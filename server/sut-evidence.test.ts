import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import type { SutCaps } from "../shared/schema";
import { createClock } from "./clock";
import { createSseChatBrain } from "./sut-sse";
import { SutRequestError } from "./sut-common";
import { listSuts, resolveSut, updateSseSut } from "./sut";
import {
  collectSutMetadata,
  metadataFromObject,
  safeUrl,
} from "./sut-evidence";
import { applySseSutInput, loadSutRecords } from "./sut-config";

const caps: SutCaps = { chat: true, inbox: false, memory: false };
let server: http.Server;
let origin: string;
let temporaryRoot: string;
let driftRequests = 0;
let received: {
  body: Record<string, unknown>;
  authorization?: string;
  sessionId?: string;
  url?: string;
}[] = [];
const previousEnvironment = {
  NODE_ENV: process.env.NODE_ENV,
  SIM_EVAL_TEST_ROOT: process.env.SIM_EVAL_TEST_ROOT,
  SUT_TEST_SECRET: process.env.SUT_TEST_SECRET,
};
const frame = (text: string, model = "actual-model") =>
  `data: ${JSON.stringify({ model, choices: [{ delta: { content: text } }] })}\n\n`;

before(async () => {
  temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sim-sut-evidence-"));
  await fs.mkdir(path.join(temporaryRoot, "config"));
  process.env.NODE_ENV = "test";
  process.env.SIM_EVAL_TEST_ROOT = temporaryRoot;
  process.env.SUT_TEST_SECRET = "first-secret-for-test";
  server = http.createServer(async (request, response) => {
    const route = new URL(request.url ?? "", "http://local").pathname;
    let raw = "";
    for await (const chunk of request) raw += chunk;
    if (request.method === "POST")
      received.push({
        body: JSON.parse(raw),
        authorization: request.headers.authorization,
        sessionId: request.headers['x-session-id'] as string | undefined,
        url: request.url,
      });
    if (route === "/bad-meta") {
      response.writeHead(503);
      response.end();
      return;
    }
    if (route === "/meta") {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify({
          model: "actual-model",
          build: "meta-build",
          token: "not-retained",
        }),
      );
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "x-request-id": `request-${received.length}`,
    });
    response.flushHeaders();
    if (route === "/timed") {
      response.write(
        ': keepalive\n\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      );
      setTimeout(() => response.write(frame("回复")), 35);
      setTimeout(() => response.end("data: [DONE]\n\n"), 80);
    } else if (route === "/incomplete") response.end(frame("未完成的正文"));
    else if (route === "/empty") response.end("data: [DONE]\n\n");
    else if (route === "/stall") response.write(frame("部分回复"));
    else if (route === "/stall-empty") response.write(": waiting\n\n");
    else if (route === "/drift") {
      driftRequests += 1;
      response.end(
        frame("回答", `model-${driftRequests}`) + "data: [DONE]\n\n",
      );
    } else if (route === "/stream-error")
      response.end(
        frame("部分回复") +
          'data: {"error":{"message":"sensitive remote detail"}}\n\n',
      );
    else response.end(frame("完成") + "data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // Test-owned temporary files remain in the OS temp directory; no user files are removed.
});

function brain(route: string, timeoutMs?: number) {
  return createSseChatBrain(
    {
      id: "test",
      name: "测试",
      transport: "sse",
      url: origin + route,
      model: "requested-model",
    },
    caps,
    { timeoutMs },
  );
}

test("TTFT observes the first nonempty body, with real send/finish time and response identity", async () => {
  const sut = brain("/timed");
  const result = await sut.handleUser("你好");
  const trace = result.request!;
  assert.equal(result.reply, "回复");
  assert.equal(trace.outcome, "completed");
  assert.equal(trace.source, "remote");
  assert.equal(trace.requestedModel, "requested-model");
  assert.equal(trace.returnedModel, "actual-model");
  assert.equal(trace.httpStatus, 200);
  assert.match(trace.requestId!, /^request-/);
  assert.ok(trace.ttftMs! >= 25, `TTFT was ${trace.ttftMs}`);
  assert.ok(trace.durationMs! > trace.ttftMs! + 15);
  assert.ok(Date.parse(trace.firstContentAt!) >= Date.parse(trace.startedAt));
  assert.ok(
    Date.parse(trace.completedAt!) >= Date.parse(trace.firstContentAt!),
  );
  assert.deepEqual(sut.requests(), [trace]);
});

test("SSE conversation IDs persist across turns and reset on leave or a new brain", async () => {
  const sut = brain("/capture");
  await sut.handleUser("你好");
  const first = received.at(-1)!.sessionId;
  assert.match(first!, /^[a-f0-9-]{36}$/);
  await sut.handleUser("继续聊");
  assert.equal(received.at(-1)!.sessionId, first);
  await sut.leave();
  await sut.handleUser("你好");
  assert.notEqual(received.at(-1)!.sessionId, first);
  const second = received.at(-1)!.sessionId;
  await brain("/capture").handleUser("你好");
  assert.notEqual(received.at(-1)!.sessionId, first);
  assert.notEqual(received.at(-1)!.sessionId, second);
});

test("EOF, no body, stream failure and body timeout remain distinct failed requests", async () => {
  for (const [route, outcome, hasBody] of [
    ["/incomplete", "incomplete", true],
    ["/empty", "empty", false],
    ["/stall", "timeout", true],
    ["/stall-empty", "timeout", false],
    ["/stream-error", "failed", true],
  ] as const) {
    const sut = brain(route, 70);
    await assert.rejects(sut.handleUser("你好"), (error: unknown) => {
      assert.ok(error instanceof SutRequestError);
      assert.equal(error.request.outcome, outcome);
      assert.equal(Boolean(error.partialReply), hasBody);
      assert.equal(Boolean(error.request.partialReply), hasBody);
      assert.equal(error.request.ttftMs === null, !hasBody);
      assert.equal(error.message.includes("sensitive remote detail"), false);
      return true;
    });
    const trace = sut.lastRequest()!;
    assert.equal(trace.outcome, outcome);
    assert.equal(trace.completedAt, undefined);
    assert.ok(trace.failedAt);
    assert.ok(trace.durationMs! > 0);
  }
});

test("each response keeps its returned model and reports within-run identity changes", async () => {
  const sut = brain("/drift");
  await sut.handleUser("第一轮");
  await sut.handleUser("第二轮");
  const [first, second] = sut.requests();
  assert.equal(first.returnedModel, "model-1");
  assert.equal(second.returnedModel, "model-2");
  assert.deepEqual(second.drift, ["model: model-1 → model-2"]);
});

test("one resolution freezes the exact request config and secret reference despite later edits", async () => {
  const configPath = path.join(temporaryRoot, "config/suts.json");
  await fs.writeFile(
    configPath,
    JSON.stringify({
      default: "remote",
      suts: [
        {
          id: "remote",
          name: "旧配置",
          transport: "sse",
          url: `${origin}/capture?api_key=query-secret&feature=test`,
          model: "old-model",
          systemPrompt: "  旧的 system prompt\n",
          temperature: 0.2,
          topP: 0.7,
          apiKey: "${SUT_TEST_SECRET}",
          agentVersion: "human-v1",
          promptVersion: "prompt-v1",
        },
      ],
    }),
  );
  const resolved = await resolveSut("remote", createClock());
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const { brain: sut, snapshot } = resolved.value;
  const beforeSnapshot = JSON.stringify(snapshot);
  assert.equal(snapshot.source, "platform-config");
  assert.equal(snapshot.declaredVersionSource, "human-unverified");
  assert.equal(snapshot.credentialRef, "${SUT_TEST_SECRET}");
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.caps));
  assert.equal(beforeSnapshot.includes("first-secret-for-test"), false);
  assert.equal(beforeSnapshot.includes("query-secret"), false);
  const view = (await listSuts())[0];
  assert.equal(JSON.stringify(view).includes("query-secret"), false);
  const updated = await updateSseSut("remote", {
    name: "新配置",
    url: view.url!,
    model: "new-model",
    systemPrompt: "新prompt",
    apiKey: "",
  });
  assert.equal(updated.ok, true);
  process.env.SUT_TEST_SECRET = "second-secret-for-test";
  received = [];
  await sut.handleUser("测试");
  assert.equal(received[0].body.model, "old-model");
  assert.equal(received[0].authorization, "Bearer first-secret-for-test");
  assert.deepEqual((received[0].body.messages as unknown[])[0], {
    role: "system",
    content: "  旧的 system prompt\n",
  });
  assert.equal(received[0].body.temperature, 0.2);
  assert.equal(received[0].body.top_p, 0.7);
  assert.equal(JSON.stringify(snapshot), beforeSnapshot);
  assert.equal(
    (await loadSutRecords()).records[0].apiKey,
    "${SUT_TEST_SECRET}",
  );
});

test("Meta is optional, whitelisted and does not block an otherwise usable connection", async () => {
  const base = {
    id: "test",
    name: "test",
    transport: "sse" as const,
    url: `${origin}/capture`,
  };
  assert.deepEqual(await collectSutMetadata(base), {});
  assert.deepEqual(
    await collectSutMetadata({ ...base, metaUrl: `${origin}/bad-meta` }),
    { metaError: "Meta HTTP 503" },
  );
  const result = await collectSutMetadata({
    ...base,
    metaUrl: `${origin}/meta`,
  });
  assert.equal(result.remoteMetadata?.source, "meta-endpoint");
  assert.equal(result.remoteMetadata?.build, "meta-build");
  assert.equal(JSON.stringify(result).includes("not-retained"), false);
  assert.equal(
    metadataFromObject({ api_key: "secret" }, "response"),
    undefined,
  );
});

test("local fixture and in-process SSE echo are not reported as a remote model", async () => {
  const sut = createSseChatBrain(
    {
      id: "echo",
      name: "echo",
      transport: "sse",
      url: "http://localhost/api/mock-sut/chat",
    },
    caps,
  );
  await sut.handleUser("你好");
  assert.equal(sut.lastRequest()?.source, "fixture");
  assert.equal(sut.lastRequest()?.remote, undefined);
  assert.equal(sut.lastRequest()?.requestedModel, undefined);
});

test("editing keeps credential headers unless replaced explicitly and masks credential URLs", () => {
  const original = {
    id: "test",
    name: "test",
    transport: "sse" as const,
    url: `${origin}/capture`,
    apiKey: "old-secret",
    headers: { "X-Tenant": "test-tenant" },
    parse: "raw" as const,
    body: "message" as const,
  };
  const changed = applySseSutInput(
    { name: "new", url: original.url, apiKey: "" },
    original,
  );
  assert.deepEqual(changed.headers, original.headers);
  assert.equal(changed.apiKey, original.apiKey);
  assert.equal(changed.parse, "raw");
  const cleared = applySseSutInput(
    { name: "new", url: original.url, clearApiKey: true },
    original,
  );
  assert.deepEqual(cleared.headers, { "X-Tenant": "test-tenant" });
  assert.equal(cleared.apiKey, undefined);
  assert.equal(
    safeUrl(
      "https://name:password@example.test/path?token=secret&mode=x#private",
    ).includes("secret"),
    false,
  );
  assert.throws(
    () =>
      applySseSutInput(
        { name: "new", url: original.url, temperature: 4 },
        original,
      ),
    /temperature/,
  );
  const defaults = applySseSutInput(
    { name: "new", url: original.url, temperature: null, topP: null },
    { ...original, temperature: 0.7, topP: 0.8 },
  );
  assert.equal(defaults.temperature, undefined);
  assert.equal(defaults.topP, undefined);
});
