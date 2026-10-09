import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createSoulpalsChatBrain } from "./sut-soulpals";
import { applySseSutInput } from "./sut-config";
import { supportsSimulatedIdentity, concurrencyKeyOf } from "./sut";

test("服务 API 使用 Bearer 和独立仿真身份，按消息轮询，保留证据", async () => {
  const calls: {path: string; body: Record<string, unknown>}[] = [];
  let requestId = "";
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer service-test");
    assert.equal(req.headers.cookie, undefined);
    assert.equal(req.headers["x-csrf-token"], undefined);
    assert.equal(req.headers.origin, undefined);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const path = req.url!;
    calls.push({path, body});
    res.setHeader("Content-Type", "application/json");
    if (path.endsWith("/capabilities")) res.end(JSON.stringify({api_version: "1", environments: ["test"], config_revision: {epoch: "build-1"}}));
    else if (path.endsWith("/conversations")) {
      assert.equal(body.selection_revision, undefined);
      assert.equal(body.runtime_user_id, undefined);
      assert.equal(body.run_id, "sim-isolated");
      assert.equal(body.subject_id, "sim-isolated");
      res.statusCode = 202;
      res.end(JSON.stringify({state: "PENDING"}));
    } else if (path.includes("/initializations/")) res.end(JSON.stringify({state: "SUCCEEDED", result_session_id: "session-1"}));
    else if (path.endsWith("/messages")) {
      requestId = body.request_id;
      res.statusCode = 202;
      res.end(JSON.stringify({state: "PENDING", message_id: "message-1", request_id: requestId}));
    } else if (path.endsWith("/memory")) res.end(JSON.stringify({status: "available", short_messages: [{role: "user", content: "本局测试"}]}));
    else if (path.endsWith("/messages/message-1")) res.end(JSON.stringify({state: "COMPLETED", authoritative_reply: "服务回复", message_id: "message-1", request_id: requestId}));
    else { res.statusCode = 404; res.end("{}"); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const brain = createSoulpalsChatBrain({id: "service", name: "service", transport: "soulpals-service",
      url: `http://127.0.0.1:${address.port}`, environment: "test", avatarId: "avatar",
      runtimeUserId: "sim-isolated", headers: {Authorization: "Bearer service-test", Cookie: "must-not-send"}},
      {chat: true, memory: true, inbox: false}, {pollMs: 1, memoryWaitMs: 1, memoryWindowMs: 1});
    const result = await brain.handleUser("本局测试");
    assert.equal(result.reply, "服务回复");
    assert.deepEqual(result.memoryLogs, ["user: 本局测试"]);
    assert.ok(calls.every(c => c.path.startsWith("/api/service/v1/")));
    assert.ok(!calls.some(c => c.path.includes("bootstrap") || c.path.includes("/state")));
    assert.equal(brain.lastRequest()?.outcome, "completed");
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});

test("服务协议可登记，切换时删除旧 Cookie，继续保守串行", () => {
  const record = applySseSutInput({name: "service", url: "http://localhost:18080", style: "soulpals-service",
    avatarId: "avatar"},
    {id: "test", name: "old", transport: "soulpals", headers: {Cookie: "old-cookie"}});
  assert.equal(record.transport, "soulpals-service");
  assert.equal(record.headers?.Cookie, undefined);
  assert.equal(record.apiKey, undefined);
  assert.equal(supportsSimulatedIdentity(record), true);
  assert.ok(concurrencyKeyOf(record));
});
