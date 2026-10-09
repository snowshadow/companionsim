import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import type { JudgeConfigSnapshot, Run } from "../shared/schema";
import { generateUserLineLLM } from "./fake-user-llm";
import { executeJudge } from "./judge";
import { buildLlmChatRequest, parseLlmChatMessage } from "./llm-chat";
import { parseSutConfig } from "./sut-config";
import { createSseChatBrain } from "./sut-sse";

test("openai 请求保持 chat/completions 形状，并只在没有 Authorization 时补 Bearer", () => {
  const built = buildLlmChatRequest({
    url: "https://api.openai.com/v1/chat/completions",
    apiKey: "sk-test",
    model: "gpt-4.1-mini",
    temperature: 0,
    stream: false,
    extraBody: { top_p: 0.2 },
    messages: [
      { role: "system", content: "规则" },
      { role: "user", content: "你好" },
    ],
  });
  assert.equal(built.method, "POST");
  assert.equal(built.headers.Authorization, "Bearer sk-test");
  assert.equal(built.headers["x-api-key"], undefined);
  assert.equal(built.headers["anthropic-version"], undefined);
  assert.deepEqual(JSON.parse(built.body), {
    model: "gpt-4.1-mini",
    temperature: 0,
    stream: false,
    top_p: 0.2,
    messages: [
      { role: "system", content: "规则" },
      { role: "user", content: "你好" },
    ],
  });

  const kept = buildLlmChatRequest({
    url: "https://example.test/v1/chat/completions",
    apiKey: "sk-test",
    headers: { Authorization: "Bearer caller" },
    stream: true,
    messages: [{ role: "user", content: "hi" }],
    model: "m",
    temperature: 0.2,
    topP: 0.7,
    session: { field: "session_id", id: "sim-abc" },
  });
  assert.equal(kept.headers.Authorization, "Bearer caller");
  assert.equal(JSON.parse(kept.body).session_id, "sim-abc");
  assert.equal(JSON.parse(kept.body).stream, true);
  assert.equal(JSON.parse(kept.body).top_p, 0.7);
});

test("anthropic 抽出 system，使用 x-api-key，并映射 input/output tokens", () => {
  const built = buildLlmChatRequest({
    api: "anthropic",
    url: "https://api.anthropic.com/v1/messages",
    apiKey: "sk-ant-test",
    headers: { "X-Trace": "1" },
    model: "claude-sonnet-4-5",
    temperature: 0.9,
    messages: [
      { role: "system", content: "第一条" },
      { role: "user", content: "问" },
      { role: "assistant", content: "答" },
      { role: "system", content: "第二条" },
      { role: "user", content: "再问" },
    ],
  });
  assert.equal(built.headers["x-api-key"], "sk-ant-test");
  assert.equal(built.headers["anthropic-version"], "2023-06-01");
  assert.equal(built.headers.Authorization, undefined);
  assert.equal(built.headers["X-Trace"], "1");
  assert.deepEqual(JSON.parse(built.body), {
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    temperature: 0.9,
    system: "第一条\n\n第二条",
    messages: [
      { role: "user", content: "问" },
      { role: "assistant", content: "答" },
      { role: "user", content: "再问" },
    ],
  });

  const caller = buildLlmChatRequest({
    api: "anthropic",
    url: "https://api.anthropic.com/v1/messages",
    apiKey: "sk-ant-test",
    headers: { Authorization: "Bearer caller-set" },
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(caller.headers.Authorization, "Bearer caller-set");
  assert.equal(caller.headers["x-api-key"], "sk-ant-test");

  const parsed = parseLlmChatMessage("anthropic", {
    id: "msg_1",
    model: "claude-sonnet-4-5",
    content: [
      { type: "text", text: "前半" },
      { type: "text", text: "后半" },
    ],
    usage: { input_tokens: 11, output_tokens: 7 },
  });
  assert.equal(parsed.text, "前半后半");
  assert.equal(parsed.id, "msg_1");
  assert.deepEqual(parsed.usage, {
    promptTokens: 11,
    completionTokens: 7,
    totalTokens: 18,
    source: "reported",
  });
});

test("配置里的 api 只接受 openai 或 anthropic", () => {
  assert.throws(
    () =>
      parseSutConfig({
        default: "remote",
        suts: [
          {
            id: "remote",
            name: "远程",
            transport: "sse",
            url: "https://example.test/v1/messages",
            api: "other",
          },
        ],
      }),
    /api 必须是 openai 或 anthropic/,
  );
  const loaded = parseSutConfig(
    JSON.parse(fs.readFileSync(new URL("../config/suts.json", import.meta.url), "utf8")),
  );
  assert.equal(loaded.defaultId, "fixture");
  assert.deepEqual(
    loaded.records.map((item) => item.id),
    ["fixture", "mock-sse", "openai", "anthropic"],
  );
  assert.equal(loaded.records.find((item) => item.id === "anthropic")?.api, "anthropic");
  const judge = JSON.parse(
    fs.readFileSync(new URL("../config/judge.json", import.meta.url), "utf8"),
  );
  const fakeUser = JSON.parse(
    fs.readFileSync(new URL("../config/fake-user.json", import.meta.url), "utf8"),
  );
  assert.equal(judge.connectionSutId, "openai");
  assert.equal(judge.model, "gpt-4.1-mini");
  assert.equal(judge.extraBody, undefined);
  assert.equal(fakeUser.connectionSutId, "anthropic");
  assert.equal(fakeUser.model, "claude-sonnet-4-5");
  assert.equal(fakeUser.extraBody, undefined);
});

test("仿真用户走 anthropic 时不再发 Bearer", async () => {
  let seen: { headers: Record<string, string>; body: Record<string, unknown> } | undefined;
  const result = await generateUserLineLLM(
    {
      connectionSutId: "anthropic",
      model: "claude-sonnet-4-5",
      temperature: 0.9,
      promptVersion: "fake-user-v3",
      maxAttempts: 1,
      backoffBaseMs: 1,
      attemptTimeoutMs: 1000,
      totalTimeoutMs: 2000,
      priorTurnsLimit: 4,
      capturedAt: "2026-10-09T00:00:00.000Z",
      endpoint: "https://api.anthropic.com/v1/messages",
      promptHash: "sha256:test",
      prompt: "SYSTEM",
    },
    {
      person: {
        id: "p",
        name: "林夏",
        version: "v1",
        immutable: true,
        summary: "25岁",
        age: 25,
        gender: "女",
        interests: ["阅读"],
        expectedDiff: "差异",
        expectedDiffScripts: ["s"],
        behaviors: [{ name: "b", instructions: ["i"], violations: ["v"] }],
      },
      event: { id: "e1", clock: "21:10", kind: "speak", intent: "打个招呼" },
      simulationTime: "21:10",
      priorTurns: [],
    },
    {
      api: "anthropic",
      apiKey: "sk-ant-user",
      headers: { "Content-Type": "application/json" },
      fetcher: (async (_url: string, init?: RequestInit) => {
        seen = {
          headers: init?.headers as Record<string, string>,
          body: JSON.parse(String(init?.body)),
        };
        return new Response(
          JSON.stringify({
            id: "msg_user",
            model: "claude-sonnet-4-5",
            content: [{ type: "text", text: "在的。" }],
            usage: { input_tokens: 4, output_tokens: 2 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    },
  );
  assert.equal(result.text, "在的。");
  assert.equal(result.usage?.promptTokens, 4);
  assert.equal(result.usage?.completionTokens, 2);
  assert.equal(seen?.headers["x-api-key"], "sk-ant-user");
  assert.equal(seen?.headers.Authorization, undefined);
  assert.equal(seen?.headers["anthropic-version"], "2023-06-01");
  assert.equal(seen?.body.system, "SYSTEM");
  assert.equal(seen?.body.max_tokens, 1024);
  const messages = seen?.body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, "user");
  assert.equal(messages.some((item) => item.role === "system"), false);
});

test("被测 anthropic 发送 messages 请求并拼出正文", async () => {
  let seen: { authorization?: string; apiKey?: string; version?: string; body: Record<string, unknown> } | undefined;
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    seen = {
      authorization: request.headers.authorization,
      apiKey: request.headers["x-api-key"] as string | undefined,
      version: request.headers["anthropic-version"] as string | undefined,
      body: JSON.parse(raw),
    };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        id: "msg_sut",
        model: "claude-sonnet-4-5",
        stop_reason: "end_turn",
        content: [
          { type: "text", text: "嗯，" },
          { type: "text", text: "我在。" },
        ],
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  try {
    const brain = createSseChatBrain(
      {
        id: "anthropic",
        name: "Anthropic",
        transport: "sse",
        api: "anthropic",
        url: `http://127.0.0.1:${address.port}/v1/messages`,
        apiKey: "sk-ant-sut",
        model: "claude-sonnet-4-5",
        systemPrompt: "短句",
      },
      { chat: true, inbox: false, memory: false },
    );
    const effect = await brain.handleUser("你好");
    assert.equal(effect.reply, "嗯，我在。");
    assert.equal(seen?.authorization, undefined);
    assert.equal(seen?.apiKey, "sk-ant-sut");
    assert.equal(seen?.version, "2023-06-01");
    assert.equal(seen?.body.system, "短句");
    assert.equal(seen?.body.max_tokens, 1024);
    assert.deepEqual(seen?.body.messages, [{ role: "user", content: "你好" }]);
    assert.equal(brain.lastRequest()?.usage?.totalTokens, 5);
    assert.equal(brain.lastRequest()?.returnedModel, "claude-sonnet-4-5");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("评审走 anthropic 时从 content 取结构化结论", async () => {
  const run = {
    id: "r-test",
    mode: "hunt",
    status: "pending",
    createdAt: "2026-10-09T00:00:00.000Z",
    personId: "p",
    personVersion: "v1",
    personName: "林夏",
    scriptId: "s",
    scriptVersion: "v1",
    scriptName: "剧本",
    clock: "21:10",
    presence: "available",
    turns: [
      { id: "user-e1", kind: "user", text: "在吗" },
      { id: "agent-e1", kind: "agent", text: "在" },
    ],
    facts: [],
    scores: [],
    memories: [],
    inbox: [],
  } as unknown as Run;
  const verdict = {
    summary: "对话很短。",
    dimensions: [
      ...["记忆诚实", "主动与边界", "关系与人设", "出戏"].map((dim) => ({
        dim,
        verdict: "not_applicable",
        value: null,
        reason: "此剧本未考察",
        evidenceTurnIds: [],
      })),
      {
        dim: "能力诚实",
        verdict: "pass",
        value: 4,
        reason: "没有假装",
        evidenceTurnIds: ["agent-e1"],
      },
    ],
    simulator: {
      verdict: "valid",
      reason: "用户打了招呼",
      evidenceTurnIds: ["user-e1"],
    },
  };
  let sent: Record<string, unknown> = {};
  const config = {
    connectionSutId: "anthropic",
    model: "claude-sonnet-4-5",
    temperature: 0,
    rubricVersion: "companion-v1",
    capturedAt: "2026-10-09T00:00:00.000Z",
    endpoint: "https://api.anthropic.com/v1/messages",
    promptVersion: "companion-judge-v3",
    promptHash: "sha256:test",
    prompt: "JUDGE",
    scale: "1-5",
    inputHash: "",
  } as unknown as JudgeConfigSnapshot;
  const reply = await executeJudge(config, run, {
    api: "anthropic",
    apiKey: "sk-ant-judge",
    headers: { "Content-Type": "application/json" },
    fetcher: (async (_url: string, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["x-api-key"], "sk-ant-judge");
      assert.equal(headers.Authorization, undefined);
      return new Response(
        JSON.stringify({
          id: "msg_judge",
          model: "claude-sonnet-4-5",
          content: [{ type: "text", text: JSON.stringify(verdict) }],
          usage: { input_tokens: 20, output_tokens: 9 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch,
  });
  assert.equal(sent.system, "JUDGE");
  assert.equal(sent.model, "claude-sonnet-4-5");
  assert.equal(sent.max_tokens, 1024);
  assert.equal(
    (sent.messages as Array<{ role: string }>).some((item) => item.role === "system"),
    false,
  );
  assert.equal(reply.result.summary, "对话很短。");
  assert.equal(reply.usage?.promptTokens, 20);
  assert.equal(reply.usage?.completionTokens, 9);
  assert.equal(reply.returnedModel, "claude-sonnet-4-5");
});
