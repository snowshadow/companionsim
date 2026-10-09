import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type {
  CreateSutRequest,
  SutTransport,
  Presence,
  RequestTrace,
  SutCaps,
  SutSnapshot,
  SutView,
} from "../shared/schema";
import type { ClockReader } from "./clock";
import { createFixtureBrain } from "./sut-fixture";
import type { SutEffect } from "./sut-common";
import {
  addSseSut,
  interpolateEnv,
  resolveSutHeaders,
  resolvedSutApiKey,
  loadSutRecords,
  updateSseSutRecord,
  type SutRecord,
} from "./sut-config";
import {
  collectSutMetadata,
  freezeDeep,
  sutSnapshot,
  sutView,
} from "./sut-evidence";
import { createSseChatBrain } from "./sut-sse";
import { createSoulpalsChatBrain } from "./sut-soulpals";

export type { SutEffect };

export type SutBrain = {
  id: string;
  name: string;
  transport: SutTransport;
  caps: SutCaps;
  injectClock: () => Promise<void>;
  handleUser: (text: string) => Promise<SutEffect>;
  onJump: () => Promise<SutEffect>;
  onSilence: () => Promise<SutEffect>;
  leave: () => Promise<SutEffect>;
  presence: () => Presence;
  memories: () => string[];
  inbox: () => string[];
  lastRequest: () => RequestTrace | undefined;
  requests: () => RequestTrace[];
};

export type ApiFail = {
  ok: false;
  status: number;
  error: string;
  errors?: string[];
};
export type ApiOk<T> = { ok: true; value: T };
export type OpenSutResult = ApiOk<SutBrain> | ApiFail;
export type ResolveSutResult =
  ApiOk<{ brain: SutBrain; snapshot: SutSnapshot }> | ApiFail;

const FIXTURE_CAPS: SutCaps = {
  chat: true,
  inbox: true,
  memory: true,
};
const CHAT_ONLY_CAPS: SutCaps = {
  chat: true,
  inbox: false,
  memory: false,
};
/** Soulpals 有独立的记忆接口，能读到真实记忆写入。 */
const SOULPALS_CAPS: SutCaps = {
  chat: true,
  inbox: false,
  memory: true,
};

function fail(status: number, error: string): ApiFail {
  return { ok: false, status, error };
}

function wrapFixture(clock: ClockReader, record: SutRecord): SutBrain {
  const inner = createFixtureBrain(clock);
  const requests: RequestTrace[] = [];
  return {
    id: record.id,
    name: record.name,
    transport: "fixture",
    caps: { ...FIXTURE_CAPS },
    injectClock: async () => {
      inner.injectClock();
    },
    handleUser: async (text) => {
      const startedAt = new Date().toISOString();
      const start = performance.now();
      const effect = inner.handleUser(text);
      const end = performance.now();
      const finishedAt = new Date().toISOString();
      const request: RequestTrace = {
        id: randomUUID(),
        attempt: 1,
        source: "fixture",
        startedAt,
        completedAt: finishedAt,
        ...(effect.reply?.trim() ? { firstContentAt: finishedAt } : {}),
        ttftMs: effect.reply?.trim() ? end - start : null,
        durationMs: end - start,
        outcome: effect.reply?.trim() ? "completed" : "empty",
      };
      requests.push(request);
      return { ...effect, request: structuredClone(request) };
    },
    onJump: async () => inner.onJump(),
    onSilence: async () => inner.onSilence(),
    leave: async () => inner.leave(),
    presence: () => inner.presence(),
    memories: () => inner.memories(),
    inbox: () => inner.inbox(),
    lastRequest: () =>
      requests.length
        ? structuredClone(requests[requests.length - 1])
        : undefined,
    requests: () => structuredClone(requests),
  };
}

function capsFor(record: SutRecord): SutCaps {
  if (record.transport === "fixture") return FIXTURE_CAPS;
  if ((record.transport === "soulpals" || record.transport === "soulpals-service")) return SOULPALS_CAPS;
  return CHAT_ONLY_CAPS;
}

/**
 * 被测能不能接受「调用方指定的本局身份」。能的话就每局一个，
 * 会话状态与记忆自然隔离，不必靠串行换干净。
 *
 * - soulpals：建会话可传 runtime_user_id，服务端会回填。
 * - 带 sessionIdField 的 SSE：把身份放进请求体（如本地轨迹 agent 的 session_id），
 *   它按 (入口, 会话 id) 隔离摘要缓存与策略记录。
 */
export function supportsSimulatedIdentity(
  record: Pick<SutRecord, "transport"> & { sessionIdField?: string },
): boolean {
  if ((record.transport === "soulpals" || record.transport === "soulpals-service")) return true;
  return record.transport === "sse" && Boolean(record.sessionIdField);
}

/**
 * 本局仿真身份。一眼能看出不是真人账号，也不会和真实用户混淆。
 * soulpals 跟着它自己的格式（默认 `soulpals-<uuid>`）；SSE 用 `sim-<uuid>`
 * （本地 agent 限制为字母数字与 . _ : -，这个形状合法）。
 */
export function simulatedIdentity(
  record: Pick<SutRecord, "transport">,
  uuid: string,
): string {
  return (record.transport === "soulpals" || record.transport === "soulpals-service")
    ? `soulpals-sim-${uuid}`
    : `sim-${uuid}`;
}

/**
 * 并发键：哪些局不能同时跑。soulpals 一个账号同时只有一个会话可写，
 * 建新会话会把旧的变成只读历史（conversation_not_current），所以同一账号的
 * 整段对话必须串行。键用 base + headers 的哈希，避免把 Cookie 明文当键。
 * 其它传输没有这个约束。
 */
export function concurrencyKeyOf(record: {
  transport: SutTransport;
  url?: string;
  /** 凭据引用（如 ${SOULPALS_SESSION}）——是变量名不是密文，可安全用作账号指纹。
   *  快照里只有这个，没有 headers，所以以它为准。 */
  credentialRef?: string;
  headers?: Record<string, string>;
}): string | undefined {
  if ((record.transport !== "soulpals" && record.transport !== "soulpals-service") || !record.url) return undefined;
  const fingerprint = record.credentialRef
    ? record.credentialRef
    : JSON.stringify(record.headers ?? {});
  const account = createHash("sha256")
    .update(fingerprint)
    .digest("hex")
    .slice(0, 12);
  return `soulpals-account:${record.url}:${account}`;
}

/**
 * 记忆域：同域内共享被测侧长程记忆，必须串行，否则写入顺序不定、不可复现。
 *
 * soulpals 的记忆键是 `memory:<user_id>:<avatar>:…`，所以域要同时带上 avatar 与 user_id。
 * 每局生成独立仿真身份时域是唯一的，等于完全隔离，可以并行；
 * 只有在登记里显式钉住 runtimeUserId（故意共享记忆）时才会落在同一个域。
 * 进程内样例每局自建实例，无状态网关不存记忆，都不限制。
 */
export function memoryDomainOf(
  record: Pick<SutRecord, "id" | "transport" | "avatarId">,
  runtimeUserId?: string,
): string | undefined {
  if ((record.transport !== "soulpals" && record.transport !== "soulpals-service")) return undefined;
  const avatar = record.avatarId ?? record.id;
  return `soulpals:${avatar}:${runtimeUserId ?? "server-default"}`;
}

export async function listSuts(): Promise<SutView[]> {
  const loaded = await loadSutRecords();
  return loaded.records.map((record) => sutView(record, capsFor(record)));
}

/** Snapshot and brain are made from the same resolved config; neither rereads it. */
export async function resolveSut(
  id: string | undefined,
  clock: ClockReader,
  options: { isolatedIdentity?: boolean } = {},
): Promise<ResolveSutResult> {
  try {
    const loaded = await loadSutRecords();
    const sutId = id?.trim() || loaded.defaultId;
    const original = loaded.records.find((item) => item.id === sutId);
    if (!original) return fail(400, `找不到被测 ${sutId}`);
    if (original.transport === "http" || original.transport === "websocket") {
      return fail(
        400,
        `被测 ${original.id} 的协议是 ${original.transport}，本版只对接 SSE 对话`,
      );
    }
    const record = structuredClone(original);
    if (record.url) record.url = interpolateEnv(record.url);
    if (record.avatarId) record.avatarId = interpolateEnv(record.avatarId);
    if (record.runtimeUserId)
      record.runtimeUserId = interpolateEnv(record.runtimeUserId);
    // 没钉住身份、且被测支持自定义身份时，给这一局一个独立仿真身份：
    // 记忆域因此唯一，既不污染别的局，也不被别的局污染。
    if (!record.runtimeUserId && options.isolatedIdentity && supportsSimulatedIdentity(record)) {
      record.runtimeUserId = simulatedIdentity(record, randomUUID());
    }
    let metaError: string | undefined;
    if (record.metaUrl) {
      try {
        record.metaUrl = interpolateEnv(record.metaUrl);
      } catch {
        delete record.metaUrl;
        metaError = "Meta 地址的环境变量未配置";
      }
    }
    record.headers = resolveSutHeaders(record);
    if (record.api === "anthropic" && record.apiKey) {
      const key = resolvedSutApiKey(record);
      if (key) record.apiKey = key;
    }
    const caps = capsFor(record);
    const snapshot = sutSnapshot(record, caps, original);
    // Meta is evidence when offered by the service; inability to collect it is not a run failure.
    Object.assign(snapshot, await collectSutMetadata(record));
    if (metaError) snapshot.metaError = metaError;
    const brain =
      record.transport === "fixture"
        ? wrapFixture(clock, record)
        : (record.transport === "soulpals" || record.transport === "soulpals-service")
          ? createSoulpalsChatBrain(record, caps, {
              remoteMetadata: snapshot.remoteMetadata,
              ...(record.runtimeUserId
                ? { runtimeUserId: record.runtimeUserId }
                : {}),
            })
          : createSseChatBrain(record, caps, {
              remoteMetadata: snapshot.remoteMetadata,
            });
    return { ok: true, value: { brain, snapshot: freezeDeep(snapshot) } };
  } catch (err) {
    // Config validation errors contain field names, not request credentials.
    return fail(400, err instanceof Error ? err.message : "解析被测配置失败");
  }
}

export async function openSut(
  id: string | undefined,
  clock: ClockReader,
): Promise<OpenSutResult> {
  const resolved = await resolveSut(id, clock);
  return resolved.ok ? { ok: true, value: resolved.value.brain } : resolved;
}

export async function registerSseSut(
  body: CreateSutRequest,
): Promise<ApiOk<SutView> | ApiFail> {
  try {
    const record = await addSseSut(body);
    return { ok: true, value: sutView(record, capsFor(record)) };
  } catch (err) {
    return fail(400, err instanceof Error ? err.message : "登记被测失败");
  }
}

export async function updateSseSut(
  id: string,
  body: CreateSutRequest,
): Promise<ApiOk<SutView> | ApiFail> {
  try {
    const record = await updateSseSutRecord(id, body);
    return { ok: true, value: sutView(record, capsFor(record)) };
  } catch (err) {
    return fail(400, err instanceof Error ? err.message : "更新被测失败");
  }
}
