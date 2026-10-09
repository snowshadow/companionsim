import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { SutCaps } from "../shared/schema";
import type { SutRecord } from "./sut-config";
import { createSoulpalsChatBrain } from "./sut-soulpals";
import { SutRequestError } from "./sut-common";
import { applySseSutInput } from "./sut-config";

const CAPS: SutCaps = { chat: true, inbox: false, memory: true };

/** 测试里的时间参数：真实现场约 10～30s，这里调到毫秒级。 */
const OPTS = {
  pollMs: 1,
  memoryRetryMs: 5,
  memoryWaitMs: 200,
  memoryWindowMs: 200,
};

type SeenWrite = {
  path: string;
  origin?: string;
  csrf?: string;
  cookie?: string;
  body: Record<string, unknown>;
};

type Memory = { role: string; content: string };
type MsgRecord = {
  id: string;
  session: string;
  requestId: string;
  polls: number;
};

function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let text = "";
    req.on("data", (chunk) => (text += String(chunk)));
    req.on("end", () => {
      try {
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });
}

/**
 * 用本地服务复刻 Soulpals 的 REST + 轮询时序：202 命令 → 轮询到终态。
 * 只实现适配器用到的接口，不模拟真实大脑。
 */
function startSoulpalsMock() {
  const writes: SeenWrite[] = [];
  const sessions: string[] = [];
  const initPolls = new Map<string, number>();
  const messageRecords: MsgRecord[] = [];
  const memories = new Map<string, Memory[]>();
  let revision = 7;
  let rejectWrites = false;
  // soulpals 的真实约束：同一账号同时只有一个会话可写，建新会话会让旧的变只读
  let initializing = 0;
  let initCollisions = 0;
  let currentSession: string | null = null;
  let readOnlyRejections = 0;
  let reply = "我在，记得你说的话。";
  let memory: Memory[] = [];
  // 记忆最终一致：前 N 次读取返回 not available，再返回数据。
  let memoryReadyAfter = 0;
  const memoryReads = new Map<string, number>();

  const server = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const path = url.pathname;
      const method = req.method ?? "GET";
      const done = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (method === "GET" && path === "/api/bootstrap") {
        done(200, {
          api_version: "1",
          authenticated: true,
          user: { default_runtime_user_id: "runtime-user-1" },
          csrf_token: "csrf-1",
          environments: [{ environment: "test", display_name: "Test" }],
          config_revision: { epoch: "epoch-1", generation: 1 },
          limits: { command_status_poll_interval_ms: 1 },
        });
        return;
      }
      if (method === "GET" && path === "/api/state") {
        if (rejectWrites) {
          done(401, { error: { code: "unauthenticated" } });
          return;
        }
        done(200, { selection_revision: revision });
        return;
      }
      if (method === "POST" && path === "/api/conversations") {
        if (initializing > 0) {
          initCollisions += 1;
          done(409, {
            error: {
              code: "initialization_in_progress",
              message: "another conversation is initializing",
            },
          });
          return;
        }
        initializing += 1;
        const body = await bodyOf(req);
        writes.push({
          path,
          origin: req.headers.origin,
          csrf: req.headers["x-csrf-token"] as string | undefined,
          cookie: req.headers.cookie,
          body,
        });
        const session = `session-${sessions.length + 1}`;
        sessions.push(session);
        currentSession = session;
        revision += 1;
        done(202, {
          request_id: body.request_id,
          candidate_session_id: session,
          state: "PENDING",
          result_session_id: null,
          error_code: null,
        });
        return;
      }
      const init = path.match(/^\/api\/initializations\/([^/]+)$/);
      if (method === "GET" && init) {
        const rid = decodeURIComponent(init[1]);
        const count = (initPolls.get(rid) ?? 0) + 1;
        initPolls.set(rid, count);
        if (count >= 2) initializing = Math.max(0, initializing - 1);
        const session = sessions[sessions.length - 1];
        done(200, {
          request_id: rid,
          candidate_session_id: session,
          state: count < 2 ? "RUNNING" : "SUCCEEDED",
          result_session_id: session,
          error_code: null,
        });
        return;
      }
      const send = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      if (method === "POST" && send) {
        const touched = decodeURIComponent(send[1]);
        if (currentSession && touched !== currentSession) {
          readOnlyRejections += 1;
          done(409, {
            error: {
              code: "conversation_not_current",
              message: "conversation is historical and read-only",
            },
          });
          return;
        }
        const body = await bodyOf(req);
        writes.push({
          path,
          origin: req.headers.origin,
          csrf: req.headers["x-csrf-token"] as string | undefined,
          cookie: req.headers.cookie,
          body,
        });
        const session = decodeURIComponent(send[1]);
        const messageId = `msg-${session}-${body.request_id}`;
        memories.set(messageId, memory);
        messageRecords.push({
          id: messageId,
          session,
          requestId: String(body.request_id),
          polls: 0,
        });
        done(202, {
          message_id: messageId,
          session_id: session,
          request_id: body.request_id,
          state: "PENDING",
          user_text: body.text,
          provisional_text: "",
          authoritative_reply: null,
        });
        return;
      }
      const list = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
      if (method === "GET" && list) {
        const session = decodeURIComponent(list[1]);
        const sessionRecords = messageRecords.filter(
          (record) => record.session === session,
        );
        for (const record of sessionRecords) record.polls += 1;
        // 真实接口按新到旧返回；适配器按 request_id 找自己那句。
        const items = [...sessionRecords].reverse().map((record) => {
          const streaming = record.polls < 2;
          return {
            message_id: record.id,
            session_id: session,
            request_id: record.requestId,
            state: streaming ? "RUNNING" : "COMPLETED",
            user_text: "用户话",
            provisional_text: streaming ? "部分" : "",
            authoritative_reply: streaming ? null : reply,
            runtime_status: streaming ? "STATUS_STREAMING" : "STATUS_COMPLETED",
            safe_error_message: null,
          };
        });
        done(200, { items, next_cursor: null });
        return;
      }
      const mem = path.match(
        /^\/api\/conversations\/([^/]+)\/messages\/([^/]+)\/memory$/,
      );
      if (method === "GET" && mem) {
        const messageId = decodeURIComponent(mem[2]);
        const reads = (memoryReads.get(messageId) ?? 0) + 1;
        memoryReads.set(messageId, reads);
        if (reads <= memoryReadyAfter) {
          done(200, { short_messages: [], notice: "memory is not available" });
          return;
        }
        done(200, { short_messages: memories.get(messageId) ?? [], notice: "complete" });
        return;
      }
      done(404, { error: { code: "not_found" } });
    },
  );

  return {
    server,
    writes,
    sessions,
    get revision() {
      return revision;
    },
    set reply(value: string) {
      reply = value;
    },
    set memory(value: Memory[]) {
      memory = value;
    },
    set memoryReadyAfter(value: number) {
      memoryReadyAfter = value;
    },
    get initCollisions() {
      return initCollisions;
    },
    get readOnlyRejections() {
      return readOnlyRejections;
    },
    set rejectWrites(value: boolean) {
      rejectWrites = value;
    },
  };
}

async function withMock(
  run: (ctx: ReturnType<typeof startSoulpalsMock>, record: SutRecord) => Promise<void>,
): Promise<void> {
  const ctx = startSoulpalsMock();
  await new Promise<void>((resolve) => ctx.server.listen(0, "127.0.0.1", resolve));
  const address = ctx.server.address();
  assert.ok(address && typeof address !== "string");
  const record: SutRecord = {
    id: "soulpals",
    name: "Soulpals 测试",
    transport: "soulpals",
    url: `http://127.0.0.1:${address.port}`,
    environment: "test",
    avatarId: "avatar-1",
    headers: { Cookie: "soulpals_session=test-cookie" },
  };
  try {
    await run(ctx, record);
  } finally {
    await new Promise<void>((resolve) => ctx.server.close(() => resolve()));
  }
}

test("Soulpals 适配器：建会话、发一句、轮询到回复并读记忆", async () => {
  await withMock(async (ctx, record) => {
    ctx.memory = [
      { role: "user", content: "晚上别建议我喝咖啡" },
      { role: "assistant", content: "记住了。" },
    ];
    const brain = createSoulpalsChatBrain(record, CAPS, OPTS);
    const effect = await brain.handleUser("晚上别建议我喝咖啡");

    assert.equal(effect.reply, "我在，记得你说的话。");
    assert.deepEqual(effect.memoryLogs, [
      "user: 晚上别建议我喝咖啡",
      "assistant: 记住了。",
    ]);
    // 记忆接口的内容进入 memories()，供 facts 核对。
    assert.deepEqual(brain.memories(), effect.memoryLogs);

    const request = brain.lastRequest();
    assert.ok(request);
    assert.equal(request.outcome, "completed");
    assert.equal(request.source, "remote");
    assert.equal(request.requestedModel, "avatar-1");
    assert.equal(request.httpStatus, 202);
    assert.equal(request.ttftMs !== null, true);
    assert.equal(request.durationMs !== null, true);
    assert.equal(request.remote?.model, "avatar-1");
    assert.equal(brain.caps.memory, true);
  });
});

test("Soulpals 适配器：写操作带 Origin 与 CSRF，会话用最新 selection_revision", async () => {
  await withMock(async (ctx, record) => {
    const brain = createSoulpalsChatBrain(record, CAPS, OPTS);
    await brain.handleUser("第一句");
    await brain.handleUser("第二句");

    const creates = ctx.writes.filter((w) => w.path === "/api/conversations");
    assert.equal(creates.length, 1, "同一段会话内不应重复建会话");
    assert.equal(creates[0].origin, record.url);
    assert.equal(creates[0].csrf, "csrf-1");
    assert.equal(creates[0].cookie, "soulpals_session=test-cookie");
    assert.equal(creates[0].body.runtime_user_id, "runtime-user-1");
    assert.equal(creates[0].body.avatar_id, "avatar-1");
    assert.equal(creates[0].body.selection_revision, ctx.revision - 1);

    const sends = ctx.writes.filter((w) => w.path.endsWith("/messages"));
    assert.equal(sends.length, 2);
    assert.equal(sends[1].body.text, "第二句");
  });
});

test("Soulpals 适配器：用户离开后下一次开口新建会话并重读 revision", async () => {
  await withMock(async (ctx, record) => {
    const brain = createSoulpalsChatBrain(record, CAPS, OPTS);
    await brain.handleUser("第一段");
    await brain.leave();
    await brain.handleUser("新开场");

    assert.equal(ctx.sessions.length, 2);
    const creates = ctx.writes.filter((w) => w.path === "/api/conversations");
    assert.equal(creates[1].body.selection_revision, ctx.revision - 1);
  });
});

test("Soulpals 适配器：会话过期时留下失败 trace", async () => {
  await withMock(async (ctx, record) => {
    ctx.rejectWrites = true;
    const brain = createSoulpalsChatBrain(record, CAPS, OPTS);
    await assert.rejects(
      () => brain.handleUser("你好"),
      (err: unknown) =>
        err instanceof SutRequestError &&
        /未登录或会话已过期/.test(err.message),
    );
    const request = brain.lastRequest();
    assert.ok(request);
    assert.equal(request.outcome, "failed");
    assert.match(request.error ?? "", /未登录或会话已过期/);
  });
});

test("Soulpals 适配器：记忆最终一致 —— 前几次 not available 时轮询等写入", async () => {
  await withMock(async (ctx, record) => {
    ctx.memory = [{ role: "user", content: "记住我不喝咖啡" }];
    // 模拟现场：回复完成后头 3 次读记忆都还没写入。
    ctx.memoryReadyAfter = 3;
    const brain = createSoulpalsChatBrain(record, CAPS, OPTS);
    const effect = await brain.handleUser("记住我不喝咖啡");
    assert.deepEqual(effect.memoryLogs, ["user: 记住我不喝咖啡"]);
    assert.deepEqual(brain.memories(), ["user: 记住我不喝咖啡"]);
  });
});

test("Soulpals 适配器：记忆超时时仍返回回复，不把未写入当成没有记忆", async () => {
  await withMock(async (ctx, record) => {
    ctx.memoryReadyAfter = 9999; // 整轮窗口内都读不到
    const brain = createSoulpalsChatBrain(record, CAPS, OPTS);
    const effect = await brain.handleUser("我说了一件事");
    assert.equal(effect.reply, "我在，记得你说的话。");
    assert.deepEqual(effect.memoryLogs, []);
  });
});

test("登记：选 Soulpals 协议得到 soulpals transport，改回 SSE 不影响其他字段", () => {
  const base = { id: "x", name: "测试", transport: "sse" as const };
  const soulpals = applySseSutInput(
    {
      name: "样例",
      url: "https://chat.example.com",
      style: "soulpals",
      environment: "test",
      avatarId: "test2",
      runtimeUserId: "u-1",
    },
    base,
  );
  assert.equal(soulpals.transport, "soulpals");
  assert.equal(soulpals.body, undefined);
  assert.equal(soulpals.parse, undefined);
  assert.equal(soulpals.avatarId, "test2");

  const backToSse = applySseSutInput(
    { name: "样例", url: "https://example.com/chat", style: "openai-chat" },
    soulpals,
  );
  assert.equal(backToSse.transport, "sse");
  assert.equal(backToSse.body, "openai-chat");
  assert.equal(backToSse.parse, "openai-chat");
});

test("登记：SSE 可以选择 anthropic，轮询协议不保留 api", () => {
  const base = { id: "x", name: "测试", transport: "sse" as const };
  const anthropic = applySseSutInput(
    {
      name: "样例",
      url: "https://api.anthropic.com/v1/messages",
      style: "openai-chat",
      api: "anthropic",
    },
    base,
  );
  assert.equal(anthropic.transport, "sse");
  assert.equal(anthropic.api, "anthropic");

  const polling = applySseSutInput(
    {
      name: "样例",
      url: "https://chat.example.com",
      style: "soulpals",
      api: "anthropic",
      environment: "test",
      avatarId: "test2",
    },
    anthropic,
  );
  assert.equal(polling.transport, "soulpals");
  assert.equal(polling.api, undefined);
});

test("登记：Soulpals 协议缺 avatarId 时校验失败", () => {
  assert.throws(
    () =>
      applySseSutInput(
        { name: "样例", url: "https://chat.example.com", style: "soulpals" },
        { id: "x", name: "", transport: "sse" },
      ),
    /avatarId/,
  );
});

test("Soulpals 适配器：记忆一直拿不到时不再为它空等（长对话不会被拖死）", async () => {
  await withMock(async (ctx, record) => {
    // 记忆接口从不返回数据；给一个很大的等待预算，看它是否只在前两轮真等
    ctx.memoryReadyAfter = 999999;
    const brain = createSoulpalsChatBrain(record, CAPS, {
      ...OPTS,
      memoryRetryMs: 20,
      memoryWaitMs: 80,
      memoryWindowMs: 40,
    });
    const t0 = Date.now();
    await brain.handleUser("一");
    const first = Date.now() - t0;
    await brain.handleUser("二");
    const second = Date.now() - t0 - first;
    const thirdStart = Date.now();
    await brain.handleUser("三");
    const third = Date.now() - thirdStart;
    // 前两轮各等满预算；第三轮起放弃等待，明显更快
    assert.ok(first >= 80, `第一轮应等满预算，实际 ${first}ms`);
    assert.ok(second >= 80, `第二轮应等满预算，实际 ${second}ms`);
    assert.ok(third < 60, `第三轮不该再空等，实际 ${third}ms`);
    assert.equal(brain.memories().length, 0);
  });
});
