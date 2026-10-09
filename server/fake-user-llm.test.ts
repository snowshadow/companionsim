import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  Person,
  ScriptEvent,
  UserGeneratorConfigSnapshot,
} from "../shared/schema";
import { generateUserLineLLM, UserGeneratorError } from "./fake-user-llm";
import {
  buildFakeUserRequest,
  parseUserLine,
  FAKE_USER_PROMPT,
  FAKE_USER_PROMPT_VERSION,
  type FakeUserContext,
} from "./fake-user-prompt";
import { JUDGE_PROMPT, JUDGE_PROMPT_VERSION } from "./judge-config";

const person: Person = {
  id: "p-luchuan",
  name: "陆川",
  version: "v1",
  immutable: true,
  summary: "24岁年轻男性，ENFP，喜欢电子产品和篮球。",
  age: 24,
  gender: "男",
  relationship: "单身",
  personality: "ENFP",
  occupation: "初级产品经理",
  interests: ["电子产品", "篮球"],
  expectedDiff: "跑相识到约会时会主动抛篮球或数码。",
  expectedDiffScripts: ["s-meet-date"],
  behaviors: [
    {
      name: "兴趣先抛出来",
      instructions: ["开口先带上篮球或电子产品"],
      violations: ["自我介绍里完全不提篮球和电子产品"],
    },
  ],
};

const event: ScriptEvent = {
  id: "e1",
  clock: "20:18",
  kind: "speak",
  intent: "低落开场且明确不要建议",
  tone: "短、低落",
  constraints: ["不要向对方要建议"],
};

const context: FakeUserContext = {
  person,
  event,
  simulationTime: "D1 20:18",
  priorTurns: [{ role: "agent", text: "在的，怎么了？" }],
};

const BASE: UserGeneratorConfigSnapshot = {
  connectionSutId: "deepseek",
  model: "deepseek-flash",
  temperature: 0.9,
  promptVersion: FAKE_USER_PROMPT_VERSION,
  maxAttempts: 5,
  backoffBaseMs: 1000,
  attemptTimeoutMs: 30_000,
  totalTimeoutMs: 120_000,
  priorTurnsLimit: 12,
  capturedAt: "2026-09-18T00:00:00.000Z",
  endpoint: "http://fake-user.test/v1/chat/completions",
  promptHash: "sha256:test",
  prompt: "SYSTEM_PROMPT",
};

function chatResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      id: "req-1",
      model: "deepseek-flash",
      choices: [{ message: { content }, finish_reason: "stop" }],
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** 按顺序发响应；给出的 Error 直接抛。 */
function scriptedFetch(steps: Array<Response | Error>) {
  const bodies: string[] = [];
  let calls = 0;
  const fetcher = (async (_url: string, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    const step = steps[Math.min(calls, steps.length - 1)];
    calls += 1;
    if (step instanceof Error) throw step;
    return step.clone();
  }) as unknown as typeof fetch;
  return { fetcher, bodies, calls: () => calls };
}

/** 受控时间：sleep 不真等，只推进 now，并记录退避。 */
function fakeTiming() {
  let t = 0;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    waits,
  };
}

test("仿真 agent：首次成功，返回一句并在请求里带上画像与本拍约束", async () => {
  const mock = scriptedFetch([chatResponse("「今天有点累，先陪我就好。」")]);
  const timing = fakeTiming();
  const result = await generateUserLineLLM(BASE, context, {
    fetcher: mock.fetcher,
    ...timing,
    random: () => 0,
  });
  assert.equal(result.text, "今天有点累，先陪我就好。");
  assert.equal(result.attempts, 1);
  assert.equal(result.returnedModel, "deepseek-flash");

  const body = JSON.parse(mock.bodies[0]) as Record<string, unknown>;
  assert.equal(body.model, "deepseek-flash");
  assert.equal(body.temperature, 0.9);
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages[0].content, "SYSTEM_PROMPT");
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.this_beat.intent, "低落开场且明确不要建议");
  assert.deepEqual(payload.this_beat.constraints, ["不要向对方要建议"]);
  assert.equal(payload.simulation_time, "D1 20:18");
  assert.equal(payload.person.name, "陆川");
  assert.equal(payload.previous_turns[0].role, "agent");
});

test("仿真 agent：5xx 按指数退避重试，第二次成功", async () => {
  const mock = scriptedFetch([
    new Response("boom", { status: 503 }),
    chatResponse("在的，我先不说话，就在这儿。"),
  ]);
  const timing = fakeTiming();
  const result = await generateUserLineLLM(BASE, context, {
    fetcher: mock.fetcher,
    ...timing,
    random: () => 0,
  });
  assert.equal(result.attempts, 2);
  assert.equal(timing.waits.length, 1);
  assert.equal(timing.waits[0], 1000);
});

test("仿真 agent：输出不合格（过长）也重试", async () => {
  const mock = scriptedFetch([
    chatResponse("长".repeat(400)),
    chatResponse("好吧。"),
  ]);
  const timing = fakeTiming();
  const result = await generateUserLineLLM(BASE, context, {
    fetcher: mock.fetcher,
    ...timing,
    random: () => 0,
  });
  assert.equal(result.text, "好吧。");
  assert.equal(result.attempts, 2);
});

test("仿真 agent：401 是致命错误，不浪费重试", async () => {
  const mock = scriptedFetch([new Response("no", { status: 401 })]);
  const timing = fakeTiming();
  await assert.rejects(
    () =>
      generateUserLineLLM(BASE, context, {
        fetcher: mock.fetcher,
        ...timing,
        random: () => 0,
      }),
    (err: unknown) =>
      err instanceof UserGeneratorError &&
      err.attempts === 1 &&
      /HTTP 401/.test(err.message),
  );
  assert.equal(mock.calls(), 1);
});

test("仿真 agent：一直失败时用满重试次数后抛错", async () => {
  const mock = scriptedFetch([new Response("boom", { status: 500 })]);
  const timing = fakeTiming();
  await assert.rejects(
    () =>
      generateUserLineLLM(BASE, context, {
        fetcher: mock.fetcher,
        ...timing,
        random: () => 0,
      }),
    (err: unknown) =>
      err instanceof UserGeneratorError && err.attempts === BASE.maxAttempts,
  );
  assert.equal(mock.calls(), BASE.maxAttempts);
  // 退避 1s、2s、4s、8s
  assert.deepEqual(timing.waits, [1000, 2000, 4000, 8000]);
});

test("仿真 agent：单句总预算用尽就停，不再试", async () => {
  const mock = scriptedFetch([new Response("boom", { status: 500 })]);
  const timing = fakeTiming();
  await assert.rejects(
    () =>
      generateUserLineLLM(
        { ...BASE, totalTimeoutMs: 3000 },
        context,
        { fetcher: mock.fetcher, ...timing, random: () => 0 },
      ),
    (err: unknown) =>
      err instanceof UserGeneratorError && /总预算|未成功/.test(err.message),
  );
  assert.equal(mock.calls(), 2); // 1s + 2s 之后就到 3s 预算
});

test("仿真 agent：支持 SSE 流式响应", async () => {
  const sse =
    `data: ${JSON.stringify({ model: "deepseek-flash", choices: [{ delta: { content: "别急着" } }] })}\n\n` +
    `data: ${JSON.stringify({ choices: [{ delta: { content: "好起来。" } }] })}\n\n` +
    "data: [DONE]\n\n";
  const mock = scriptedFetch([
    new Response(sse, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }),
  ]);
  const timing = fakeTiming();
  const result = await generateUserLineLLM(BASE, context, {
    fetcher: mock.fetcher,
    ...timing,
    random: () => 0,
  });
  assert.equal(result.text, "别急着好起来。");
});

test("仿真 agent 提示词：生成端不带 violations，只带 instructions", () => {
  const payload = buildFakeUserRequest(context) as {
    person: { behaviors: Array<Record<string, unknown>> };
  };
  const behavior = payload.person.behaviors[0];
  assert.deepEqual(behavior.instructions, ["开口先带上篮球或电子产品"]);
  assert.equal("violations" in behavior, false);
});

test("台词解析：去引号与代码围栏，空与超长报错", () => {
  assert.equal(parseUserLine("今天不想说话。"), "今天不想说话。");
  assert.equal(parseUserLine("“先陪我就好。”"), "先陪我就好。");
  assert.equal(parseUserLine("```\n好吧。\n```"), "好吧。");
  assert.equal(parseUserLine("第一行\n第二行"), "第一行");
  assert.throws(() => parseUserLine("   "), /为空/);
  assert.throws(() => parseUserLine("长".repeat(300)), /过长/);
});

test("生成与评审必须是两套提示词（规范 Q26：允许同模型，禁止同提示）", () => {
  assert.notEqual(FAKE_USER_PROMPT, JUDGE_PROMPT);
  assert.notEqual(FAKE_USER_PROMPT_VERSION, JUDGE_PROMPT_VERSION);
  // 各自只能干自己的事：生成端扮演用户，评审端只判卷
  assert.ok(FAKE_USER_PROMPT.includes("扮演"));
  assert.ok(!FAKE_USER_PROMPT.includes("dimensions"));
  assert.ok(JUDGE_PROMPT.includes("dimensions"));
  assert.ok(!JUDGE_PROMPT.includes("你在一场虚拟陪伴仿真里扮演一个真实的人"));
});
