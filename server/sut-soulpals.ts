import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { RemoteMetadata, RequestTrace, SutCaps } from "../shared/schema";
import type { SutRecord } from "./sut-config";
import { metadataFromObject } from "./sut-evidence";
import {
  createRequestTrace,
  emptyEffect,
  noteRemoteMetadata,
  SutRequestError,
} from "./sut-common";
import type { SutBrain } from "./sut";

/**
 * Soulpals Agent 适配器。
 *
 * Soulpals 网页端不是 SSE：写操作返回 202 命令，再由前端轮询到终态。
 * 这里把「进入会话 → 发一句 → 轮询到回复 → 读记忆」包成平台的一轮对话，
 * 使被测在整局里共用同一个服务端会话，和网页端行为一致。
 *
 * 记忆是**最终一致**的：回复 COMPLETED 时 /memory 常常还返回
 * "memory is not available"，约 15～30s 后才写入。所以读完一次就拿不到时
 * 不能判成“没记忆”，要按 memoryRetryMs 在后台重试到 memoryWindowMs。
 *
 * 本版只接通对话与记忆；假时钟、收件箱没有对应接口，caps 里记未接入。
 */

type BrainOptions = {
  /** 调用方指定的用户身份（比如此局生成的仿真身份）；优先级高于登记里的钉子。 */
  runtimeUserId?: string;
  timeoutMs?: number;
  /** 轮询间隔；测试里调小，生产用服务端建议值。 */
  pollMs?: number;
  /** 记忆未写入时的后台重试间隔。 */
  memoryRetryMs?: number;
  /** 一轮内同步等记忆写好的最长预算；超时就转后台。 */
  memoryWaitMs?: number;
  /** 记忆后台重试的最长窗口。 */
  memoryWindowMs?: number;
  remoteMetadata?: RemoteMetadata;
};

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_POLL_MS = 500;
const DEFAULT_MEMORY_RETRY_MS = 5_000;
const DEFAULT_MEMORY_WAIT_MS = 30_000;
const DEFAULT_MEMORY_WINDOW_MS = 180_000;
const ACTIVE_STATES = new Set(["PENDING", "RUNNING"]);
/** 连续几轮等不到记忆，就不再为它空等。 */
const MEMORY_MISSES_BEFORE_GIVING_UP = 2;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 后台收记忆不能拖住进程退出。 */
function sleepUnref(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function isActive(state: unknown): boolean {
  return typeof state === "string" && ACTIVE_STATES.has(state);
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function objectOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function describeError(json: Record<string, unknown>, status: number, step: string): string {
  const error = objectOf(json.error);
  const code = textOf(error.code) || `http_${status}`;
  const message = textOf(error.message);
  return `Soulpals ${step}失败：${code}${message ? ` · ${message}` : ""}`;
}

export function createSoulpalsChatBrain(
  input: SutRecord,
  caps: SutCaps,
  options: BrainOptions = {},
): SutBrain {
  const record = structuredClone(input);
  const service = record.transport === "soulpals-service";
  const authError = service
    ? "Chatbot API Key 无效、已过期或已吊销，请更新 CHATBOT_API_KEY"
    : "Soulpals 未登录或会话已过期，请更新 SOULPALS_SESSION";
  const base = (record.url ?? "").replace(/\/+$/, "");
  const origin = new URL(base).origin;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const memoryRetryMs = options.memoryRetryMs ?? DEFAULT_MEMORY_RETRY_MS;
  const memoryWaitMs = options.memoryWaitMs ?? DEFAULT_MEMORY_WAIT_MS;
  const memoryWindowMs = options.memoryWindowMs ?? DEFAULT_MEMORY_WINDOW_MS;

  const requests: RequestTrace[] = [];
  const memoryLines: string[] = [];
  const harvests = new Set<Promise<void>>();
  // 记忆接口的可用性因被测而异：有的从不出数据。连续几次等不到就不再空等，
  // 但一旦拿到就恢复等待——否则一个坏接口会让长对话白等几十分钟。
  let memoryMisses = 0;
  let csrfToken: string | undefined;
  let bootstrapped = false;
  let sessionId: string | undefined;
  let runtimeUserId: string | undefined =
    options.runtimeUserId ?? record.runtimeUserId;
  let environment: string | undefined = record.environment;
  let needsSession = true;
  let previousMetadata: RemoteMetadata | undefined = options.remoteMetadata;
  let bootstrapMetadata: RemoteMetadata | undefined;

  function headers(write: boolean): Record<string, string> {
    const out: Record<string, string> = {
      ...record.headers,
      Accept: "application/json",
      // Soulpals 对写操作校验 Origin；用被测地址本身，不额外登记。
      Origin: origin,
      Referer: `${origin}/`,
    };
    if (service) {
      delete out.Origin;
      delete out.Referer;
      for (const name of Object.keys(out)) {
        if (name.toLowerCase() === "cookie") delete out[name];
      }
    }
    if (write) {
      out["Content-Type"] = "application/json";
      if (csrfToken) out["X-CSRF-Token"] = csrfToken;
    }
    return out;
  }

  async function call(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<{ res: Response; json: Record<string, unknown> }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const apiPath = service ? path.replace(/^\/api\//, "/api/service/v1/") : path;
      const res = await fetch(`${base}${apiPath}`, {
        method,
        headers: headers(body !== undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
        redirect: "error",
      });
      let json: Record<string, unknown> = {};
      try {
        json = objectOf(await res.json());
      } catch {
        /* 204 或非 JSON 响应体。 */
      }
      return { res, json };
    } finally {
      clearTimeout(timer);
    }
  }

  function noteRemote(trace: RequestTrace, meta: RemoteMetadata | undefined): void {
    previousMetadata = noteRemoteMetadata(trace, previousMetadata, meta);
  }

  async function bootstrap(): Promise<void> {
    if (service) {
      const { res, json } = await call("GET", "/api/capabilities");
      if (res.status === 401) throw new Error(authError);
      if (res.status >= 400) throw new Error(describeError(json, res.status, "连接服务"));
      if (json.api_version !== "1") throw new Error("不支持的 Chatbot 服务 API 版本");
      runtimeUserId ??= `sim-${randomUUID()}`;
      environment ??= textOf(Array.isArray(json.environments) ? json.environments[0] : undefined);
      bootstrapMetadata = metadataFromObject({ build: json.api_version, release: objectOf(json.config_revision).epoch }, "response");
      bootstrapped = true;
      return;
    }
    const { res, json } = await call("GET", "/api/bootstrap");
    if (res.status === 401 || json.authenticated !== true) {
      throw new Error("Soulpals 未登录或会话已过期，请更新 SOULPALS_SESSION");
    }
    const token = textOf(json.csrf_token);
    if (token === "") throw new Error("Soulpals bootstrap 未返回 CSRF token");
    csrfToken = token;
    if (!runtimeUserId) {
      const user = objectOf(json.user);
      runtimeUserId = textOf(user.default_runtime_user_id) || undefined;
    }
    if (!environment) {
      const environments = Array.isArray(json.environments) ? json.environments : [];
      environment = textOf(objectOf(environments[0]).environment) || undefined;
    }
    const revision = objectOf(json.config_revision);
    bootstrapMetadata = metadataFromObject(
      {
        build: json.api_version,
        release: revision.epoch,
        model: record.avatarId,
      },
      "response",
    );
    bootstrapped = true;
  }

  async function currentRevision(): Promise<number> {
    const { res, json } = await call("GET", "/api/state");
    if (res.status === 401) throw new Error("Soulpals 未登录或会话已过期");
    if (res.status >= 400)
      throw new Error(describeError(json, res.status, "读取状态"));
    return typeof json.selection_revision === "number"
      ? json.selection_revision
      : 0;
  }

  async function ensureSession(trace: RequestTrace): Promise<void> {
    if (!needsSession && sessionId) return;
    if (!bootstrapped) await bootstrap();
    noteRemote(trace, bootstrapMetadata);
    if (!environment) throw new Error("Soulpals 被测缺少 environment");
    if (!record.avatarId) throw new Error("Soulpals 被测缺少 avatarId");
    if (!runtimeUserId)
      throw new Error("Soulpals 被测缺少 runtimeUserId，且服务未返回默认值");

    // 账号锁在 handleUser 外层已经拿到，这里直接建会话。
    const requestId = randomUUID();
      // 每建一段会话都会推进 selection_revision，必须用最新值，否则被拒。
      const selectionRevision = service ? undefined : await currentRevision();
      const created = await call("POST", "/api/conversations", {
        request_id: requestId,
        environment,
        avatar_id: record.avatarId,
        ...(service
          ? { run_id: runtimeUserId, subject_id: runtimeUserId }
          : { checkpoint_id: null, runtime_user_id: runtimeUserId, selection_revision: selectionRevision }),
      });
      trace.httpStatus = created.res.status;
      if (created.res.status === 401)
        throw new Error(authError);
      if (created.res.status >= 400)
        throw new Error(
          describeError(created.json, created.res.status, "创建对话"),
        );

    let command = created.json;
    const started = performance.now();
    while (isActive(command.state)) {
      if (performance.now() - started > timeoutMs)
        throw new Error("Soulpals 新对话初始化超时");
      await sleep(pollMs);
      const poll = await call("GET", `/api/initializations/${requestId}`);
      if (poll.res.status >= 400)
        throw new Error(
          describeError(poll.json, poll.res.status, "读取初始化状态"),
        );
      command = poll.json;
    }
    if (
      command.state !== "SUCCEEDED" ||
      typeof command.result_session_id !== "string"
    )
      throw new Error(
        `Soulpals 新对话初始化失败：${textOf(command.error_code) || textOf(command.state) || "unknown"}`,
      );
    sessionId = command.result_session_id;
    needsSession = false;
  }

  async function readMemoryOnce(messageId: string): Promise<string[]> {
    try {
      const mem = await call(
        "GET",
        `/api/conversations/${sessionId}/messages/${messageId}/memory`,
      );
      if (mem.res.status >= 400) return [];
      const short = Array.isArray(mem.json.short_messages)
        ? mem.json.short_messages
        : [];
      const added: string[] = [];
      for (const raw of short) {
        const item = objectOf(raw);
        const content = textOf(item.content).trim();
        if (content === "") continue;
        const line = `${textOf(item.role) || "memory"}: ${content}`;
        if (!memoryLines.includes(line)) {
          memoryLines.push(line);
          added.push(line);
        }
      }
      return added;
    } catch {
      // 记忆读取失败不影响对话；缺证据时 facts 会记 untestable。
      return [];
    }
  }

  /**
   * 记忆最终一致：回复结束时常常还没写入，约 10～30s 后才出现。
   * 先在这轮里轮询到 memoryWaitMs；仍没有就交给后台窗口继续追。
   */
  async function readMemory(messageId: string): Promise<string[]> {
    const gaveUp = memoryMisses >= MEMORY_MISSES_BEFORE_GIVING_UP;
    const deadline = Date.now() + (gaveUp ? 0 : memoryWaitMs);
    for (;;) {
      const added = await readMemoryOnce(messageId);
      if (added.length > 0) {
        memoryMisses = 0;
        return added;
      }
      if (Date.now() >= deadline) {
        memoryMisses += 1;
        return [];
      }
      await sleep(Math.min(memoryRetryMs, Math.max(0, deadline - Date.now())));
    }
  }

  /** 同步等不到的记忆交给后台，供本局结束前的 memories() 使用。 */
  function scheduleMemoryHarvest(messageId: string): void {
    const task = (async () => {
      const deadline = Date.now() + memoryWindowMs;
      while (Date.now() < deadline) {
        await sleepUnref(memoryRetryMs);
        if ((await readMemoryOnce(messageId)).length > 0) return;
      }
    })().catch(() => undefined);
    harvests.add(task);
    void task.finally(() => harvests.delete(task));
  }

  async function sendMessage(
    text: string,
    trace: RequestTrace,
    start: number,
  ): Promise<{ reply: string; logs: string[] }> {
    const requestId = randomUUID();
    const sent = await call("POST", `/api/conversations/${sessionId}/messages`, {
      request_id: requestId,
      text,
    });
    trace.httpStatus = sent.res.status;
    trace.requestId = requestId;
    if (sent.res.status === 401) throw new Error(authError);
    if (sent.res.status >= 400)
      throw new Error(describeError(sent.json, sent.res.status, "发送消息"));

    let message = sent.json;
    const started = performance.now();
    let reply = "";
    while (isActive(message.state)) {
      if (performance.now() - started > timeoutMs) {
        trace.partialReply = reply || undefined;
        throw new Error("Soulpals 回复超时（包含轮询等待）");
      }
      await sleep(pollMs);
      const poll = await call(
        "GET",
        service
          ? `/api/conversations/${sessionId}/messages/${encodeURIComponent(textOf(message.message_id))}`
          : `/api/conversations/${sessionId}/messages?limit=50`,
      );
      if (poll.res.status >= 400)
        throw new Error(
          describeError(poll.json, poll.res.status, "读取消息状态"),
        );
      const items = service ? [poll.json] : Array.isArray(poll.json.items) ? poll.json.items : [];
      const found = items.find(
        (item) => objectOf(item).request_id === requestId,
      );
      if (found) message = objectOf(found);
      reply =
        textOf(message.authoritative_reply).trim() ||
        textOf(message.provisional_text).trim();
      if (reply !== "" && trace.firstContentAt === undefined) {
        trace.firstContentAt = new Date().toISOString();
        trace.ttftMs = performance.now() - start;
      }
    }

    reply =
      textOf(message.authoritative_reply).trim() ||
      textOf(message.provisional_text).trim();
    // 极快回复可能在 POST 响应里就已 COMPLETED，没走到轮询。
    if (reply !== "" && trace.firstContentAt === undefined) {
      trace.firstContentAt = new Date().toISOString();
      trace.ttftMs = performance.now() - start;
    }
    const state = textOf(message.state);
    if (state !== "COMPLETED") {
      trace.partialReply = reply || undefined;
      throw new Error(
        `Soulpals 回复未完成：${state || "unknown"}${textOf(message.safe_error_message) ? ` · ${textOf(message.safe_error_message)}` : ""}`,
      );
    }
    const logs = await readMemory(textOf(message.message_id));
    // 这轮等不到也不能当成“没有记忆”：后台继续追到 memoryWindowMs。
    if (logs.length === 0 && textOf(message.message_id) !== "")
      scheduleMemoryHarvest(textOf(message.message_id));
    return { reply, logs };
  }

  return {
    id: record.id,
    name: record.name,
    transport: "soulpals",
    caps: { ...caps },
    injectClock: async () => {},
    async handleUser(text) {
      const start = performance.now();
      const trace: RequestTrace = createRequestTrace({
        ...(record.avatarId ? { requestedModel: record.avatarId } : {}),
      });
      let reply = "";
      let pendingLogs: string[] = [];
      try {
        // 账号级串行在运行时做（concurrencyKeyOf）：必须覆盖整段对话，
        // 否则轮与轮之间会被别的局抢走可写会话。这里不再自行加锁，避免嵌套死锁。
        await ensureSession(trace);
        const result = await sendMessage(text, trace, start);
        reply = result.reply;
        pendingLogs = result.logs;
        if (reply === "") {
          trace.outcome = "empty";
          throw new Error("Soulpals 已结束，但没有返回正文");
        }
        trace.outcome = "completed";
        trace.completedAt = new Date().toISOString();
        return {
          proactive: [],
          memoryLogs: pendingLogs,
          reply,
          request: trace,
        };
      } catch (err) {
        trace.failedAt = new Date().toISOString();
        const message = err instanceof Error ? err.message : "连接 Soulpals 失败";
        if (message.includes("超时")) trace.outcome = "timeout";
        trace.error = message;
        if (!trace.partialReply && reply !== "") trace.partialReply = reply;
        throw new SutRequestError(message, trace, trace.partialReply ?? "");
      } finally {
        trace.durationMs = performance.now() - start;
        requests.push(structuredClone(trace));
      }
    },
    onJump: async () => emptyEffect(),
    onSilence: async () => emptyEffect(),
    leave: async () => {
      // 没有归档接口。用户离开后，下一次 speak 视为新开场：新建会话。
      needsSession = true;
      sessionId = undefined;
      return emptyEffect();
    },
    presence: () => "available",
    memories: () => [...memoryLines],
    inbox: () => [],
    lastRequest: () =>
      requests.length
        ? structuredClone(requests[requests.length - 1])
        : undefined,
    requests: () => structuredClone(requests),
  };
}
