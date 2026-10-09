import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Person, Script } from "../shared/schema";
import { startHunt, getRun } from "./runtime";
import { FAKE_USER_PROMPT_VERSION } from "./fake-user-prompt";
import { writeJson } from "./store";

/**
 * 这一条专门守住「运行时真的把连接凭据带给仿真 agent」。
 * 之前漏了 headers，Cherry 直接 401，而单元测试查不出来。
 */

const person: Person = {
  id: "p-test",
  version: "v1",
  immutable: true,
  name: "测试者",
  age: 24,
  gender: "男",
  summary: "24岁年轻男性，喜欢篮球。",
  interests: ["篮球"],
  expectedDiff: "低落夜会先提篮球再说低落",
  expectedDiffScripts: ["s-test"],
  behaviors: [
    {
      name: "兴趣先抛",
      instructions: ["开口带上篮球"],
      violations: ["完全不提篮球"],
    },
  ],
};

const script: Script = {
  id: "s-test",
  version: "v1",
  name: "低落夜测试",
  family: "short-term-memory",
  events: [
    {
      id: "e1",
      clock: "20:18",
      kind: "speak",
      intent: "低落开场且明确不要建议",
      tone: "短、低落",
      constraints: ["不要向对方要建议"],
    },
    {
      id: "e3",
      clock: "20:35",
      kind: "speak",
      intent: "还是先陪着，别给办法",
      tone: "低落",
      constraints: ["不要向对方要建议"],
    },
  ],
};

test("探索用 LLM 生成台词：带凭据调用、两句不同、失败不顶替模板", async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sim-eval-fakeuser-"));
  process.env.NODE_ENV = "test";
  process.env.SIM_EVAL_TEST_ROOT = testRoot;
  process.env.TEST_LLM_KEY = "test-secret-key";

  const seen: Array<{ auth?: string; body: Record<string, unknown> }> = [];
  const lines = [
    "今天打球手感全无，心里挺堵的。先别给我建议。",
    "投篮怎么投都不进，我就坐场边发呆。",
  ];
  const llm = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += String(chunk);
    const body = JSON.parse(text) as Record<string, unknown>;
    seen.push({ auth: req.headers.authorization, body });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        id: `llm-${seen.length}`,
        model: "test-fake-user-model",
        choices: [
          {
            message: { content: lines[Math.min(seen.length - 1, lines.length - 1)] },
            finish_reason: "stop",
          },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => llm.listen(0, "127.0.0.1", resolve));
  const address = llm.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  await Promise.all([
    writeJson(path.join(testRoot, "artifacts/people/p-test@v1.json"), person),
    writeJson(path.join(testRoot, "artifacts/scripts/s-test@v1.json"), script),
    writeJson(path.join(testRoot, "config/suts.json"), {
      default: "fixture",
      suts: [
        { id: "fixture", name: "内置样例", transport: "fixture" },
        {
          id: "llm-conn",
          name: "仿真 agent 连接",
          transport: "sse",
          url: `${base}/v1/chat/completions`,
          body: "openai-chat",
          apiKey: "${TEST_LLM_KEY}",
        },
      ],
    }),
    writeJson(path.join(testRoot, "config/fake-user.json"), {
      connectionSutId: "llm-conn",
      model: "test-fake-user",
      temperature: 0.9,
      promptVersion: FAKE_USER_PROMPT_VERSION,
      maxAttempts: 3,
      backoffBaseMs: 1,
      attemptTimeoutMs: 5000,
      totalTimeoutMs: 20000,
    }),
  ]);

  // 断言必须放在 try 内：mock server 的 close 在 finally，
  // 否则断言一失败就留下一个活着的 server，测试进程会挂住而不是报红。
  let id = "";
  try {
    const started = await startHunt({
      mode: "hunt",
      generator: "llm",
      personId: person.id,
      personVersion: person.version,
      scriptId: script.id,
      scriptVersion: script.version,
      sutId: "fixture",
    });
    assert.ok(started.ok, "startHunt 应当接受 LLM 探索");
    id = started.value.id;
    for (let i = 0; i < 200; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const run = await getRun(id);
      if (run && run.dialogueStatus !== "running") break;
    }
    const run = await getRun(id);
    assert.ok(run);
    assert.equal(run.userGenerator, "llm-v1");
    assert.equal(run.dialogueStatus, "done");

    // 凭据必须真的带到生成调用上。
    assert.equal(seen.length, 2);
    assert.equal(seen[0].auth, "Bearer test-secret-key");
    // 提示词里要有这一拍的要求，且不含判卷用的 violations。
    const messages = seen[0].body.messages as Array<{ content: string }>;
    const payload = JSON.parse(messages[1].content);
    assert.equal(payload.this_beat.intent, "低落开场且明确不要建议");
    assert.deepEqual(payload.person.behaviors[0].instructions, ["开口带上篮球"]);
    assert.equal("violations" in payload.person.behaviors[0], false);

    const userTurns = run.turns.filter((turn) => turn.kind === "user");
    assert.equal(userTurns.length, 2);
    assert.notEqual(userTurns[0].text, userTurns[1].text, "两拍不应复读同一句");
    assert.equal(userTurns[0].text, lines[0]);
    assert.equal(userTurns[1].text, lines[1]);

    assert.equal(run.generations?.length, 2);
    assert.ok(run.generations?.every((g) => g.outcome === "completed"));
    assert.equal(run.generations?.[0].returnedModel, "test-fake-user-model");
    assert.equal(run.generatorSnapshot?.model, "test-fake-user");
    assert.ok(run.generatorSnapshot?.promptHash.startsWith("sha256:"));
  } finally {
    await new Promise<void>((resolve) => llm.close(() => resolve()));
  }
});

test("探索用 LLM：未配置生成器时拒绝开跑，不静默用模板", async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sim-eval-nogen-"));
  process.env.NODE_ENV = "test";
  process.env.SIM_EVAL_TEST_ROOT = testRoot;
  await Promise.all([
    writeJson(path.join(testRoot, "artifacts/people/p-test@v1.json"), person),
    writeJson(path.join(testRoot, "artifacts/scripts/s-test@v1.json"), script),
    writeJson(path.join(testRoot, "config/suts.json"), {
      default: "fixture",
      suts: [{ id: "fixture", name: "内置样例", transport: "fixture" }],
    }),
  ]);
  const started = await startHunt({
    mode: "hunt",
    personId: person.id,
    personVersion: person.version,
    scriptId: script.id,
    scriptVersion: script.version,
    sutId: "fixture",
  });
  assert.equal(started.ok, false);
  if (!started.ok) assert.match(started.error, /未配置/);
});

test("探索用 LLM：显式选模板时仍走 template-v1", async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sim-eval-tpl-"));
  process.env.NODE_ENV = "test";
  process.env.SIM_EVAL_TEST_ROOT = testRoot;
  await Promise.all([
    writeJson(path.join(testRoot, "artifacts/people/p-test@v1.json"), person),
    writeJson(path.join(testRoot, "artifacts/scripts/s-test@v1.json"), script),
    writeJson(path.join(testRoot, "config/suts.json"), {
      default: "fixture",
      suts: [{ id: "fixture", name: "内置样例", transport: "fixture" }],
    }),
  ]);
  const started = await startHunt({
    mode: "hunt",
    generator: "template",
    personId: person.id,
    personVersion: person.version,
    scriptId: script.id,
    scriptVersion: script.version,
    sutId: "fixture",
  });
  assert.ok(started.ok);
  assert.equal(started.value.userGenerator, "template-v1");
});
