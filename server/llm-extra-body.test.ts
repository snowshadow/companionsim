import assert from "node:assert/strict";
import { test } from "node:test";
import type { JudgeConfigSnapshot, Run } from "../shared/schema";
import { parseExtraBody } from "./llm-connection";
import { parseJudgeSettings } from "./judge-config";
import { parseUserGeneratorSettings } from "./fake-user-config";
import { executeJudge } from "./judge";
import { FAKE_USER_PROMPT_VERSION } from "./fake-user-prompt";
import { generateUserLineLLM } from "./fake-user-llm";
import { JUDGE_PROMPT_VERSION } from "./judge-config";

/**
 * 百炼这类厂商把私有开关放在请求体顶层（`enable_thinking`），平台必须能原样带上，
 * 否则只能靠「选一个默认不带思考的模型」来绕，模型一换就踩坑。
 */

test("extraBody：只收普通值，且不准覆盖平台自己管的字段", () => {
  assert.deepEqual(parseExtraBody({ enable_thinking: false }, "x"), {
    enable_thinking: false,
  });
  assert.deepEqual(
    parseExtraBody({ a: 1, b: "s", c: true, d: ["x", "y"] }, "x"),
    { a: 1, b: "s", c: true, d: ["x", "y"] },
  );
  assert.equal(parseExtraBody(undefined, "x"), undefined);
  assert.equal(parseExtraBody({}, "x"), undefined);
  // 覆盖 model / messages / stream 等于偷改调用方式，拒绝
  for (const key of ["model", "messages", "stream"]) {
    assert.throws(() => parseExtraBody({ [key]: "x" }, "评审 extraBody"), /不准覆盖/);
  }
  assert.throws(() => parseExtraBody("nope", "x"), /必须是对象/);
  assert.throws(() => parseExtraBody({ a: { nested: 1 } }, "x"), /只支持字符串/);
  assert.throws(() => parseExtraBody({ a: [1, 2] }, "x"), /只支持字符串/);
});

test("两个 settings 都能带 extraBody 存下来（缺省时不出现在结果里）", () => {
  const judge = parseJudgeSettings({
    connectionSutId: "bailian",
    model: "kimi-k2.6",
    temperature: 0,
    rubricVersion: "companion-v1",
    extraBody: { enable_thinking: false },
  });
  assert.deepEqual(judge.extraBody, { enable_thinking: false });
  assert.equal(
    parseJudgeSettings({
      connectionSutId: "bailian",
      model: "kimi-k2.6",
      temperature: 0,
      rubricVersion: "companion-v1",
    }).extraBody,
    undefined,
  );

  const generator = parseUserGeneratorSettings({
    connectionSutId: "bailian",
    model: "qwen3.6-flash",
    temperature: 0.9,
    promptVersion: FAKE_USER_PROMPT_VERSION,
    maxAttempts: 5,
    backoffBaseMs: 1000,
    attemptTimeoutMs: 30_000,
    totalTimeoutMs: 120_000,
    priorTurnsLimit: 40,
    extraBody: { enable_thinking: false, top_p: 0.8 },
  });
  assert.deepEqual(generator.extraBody, {
    enable_thinking: false,
    top_p: 0.8,
  });
});

test("仿真 agent 请求体带上了 extraBody", async () => {
  let sent: Record<string, unknown> = {};
  const snapshot = {
    ...parseUserGeneratorSettings({
      connectionSutId: "bailian",
      model: "qwen3.6-flash",
      temperature: 0.9,
      promptVersion: FAKE_USER_PROMPT_VERSION,
      maxAttempts: 1,
      backoffBaseMs: 10,
      attemptTimeoutMs: 1000,
      totalTimeoutMs: 2000,
      priorTurnsLimit: 4,
      extraBody: { enable_thinking: false },
    }),
    capturedAt: "2026-09-21T00:00:00.000Z",
    endpoint: "http://bailian.test/v1/chat/completions",
    promptHash: "sha256:test",
    prompt: "SYSTEM",
  };
  await generateUserLineLLM(
    snapshot,
    {
      person: {
        id: "p",
        name: "林夏",
        version: "v1",
        immutable: true,
        summary: "25岁年轻女性，INTJ",
        age: 25,
        gender: "女",
        interests: ["动漫"],
        expectedDiff: "差异",
        expectedDiffScripts: ["s"],
        behaviors: [{ name: "b", instructions: ["i"], violations: ["v"] }],
      },
      event: { id: "e1", clock: "21:10", kind: "speak", intent: "随口说一句" },
      simulationTime: "21:10",
      priorTurns: [],
    },
    {
      headers: { "Content-Type": "application/json" },
      fetcher: (async (_url: string, init: { body?: string }) => {
        sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            id: "x",
            model: "qwen3.6-flash",
            usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
            choices: [
              { message: { content: "行吧，我记一下。" }, finish_reason: "stop" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    },
  );
  assert.equal(sent.enable_thinking, false);
  assert.equal(sent.model, "qwen3.6-flash");
  assert.equal(sent.stream, false);
});

test("评审请求体带上了 extraBody", async () => {
  let sent: Record<string, unknown> = {};
  const run = {
    id: "r-test",
    mode: "hunt",
    status: "pending",
    createdAt: "2026-09-21T00:00:00.000Z",
    personId: "p",
    personVersion: "v1",
    personName: "林夏",
    scriptId: "s",
    scriptVersion: "v1",
    scriptName: "剧本",
    clock: "21:10",
    presence: "available",
    turns: [
      { id: "user-e1", kind: "user", text: "我明天要交材料" },
      { id: "agent-e1", kind: "agent", text: "那你早点休息" },
    ],
    facts: [],
    scores: [],
    memories: [],
    inbox: [],
  } as unknown as Run;
  const config = {
    connectionSutId: "bailian",
    model: "kimi-k2.6",
    temperature: 0,
    rubricVersion: "companion-v1",
    extraBody: { enable_thinking: false },
    capturedAt: "2026-09-21T00:00:00.000Z",
    endpoint: "http://bailian.test/v1/chat/completions",
    promptVersion: JUDGE_PROMPT_VERSION,
    promptHash: "sha256:test",
    prompt: "JUDGE",
    scale: "1-5",
    inputHash: "",
  } as unknown as JudgeConfigSnapshot;
  await executeJudge(config, run, {
    headers: { "Content-Type": "application/json" },
    fetcher: (async (_url: string, init: { body?: string }) => {
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          id: "j",
          model: "kimi-k2.6",
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
          choices: [
            {
              finish_reason: "stop",
              message: {
                content: JSON.stringify({
                  summary: "对话正常。",
                  dimensions: [
                    ...["记忆诚实", "主动与边界", "关系与人设", "出戏"].map(
                      (dim) => ({
                        dim,
                        verdict: "not_applicable",
                        value: null,
                        reason: "此剧本未考察",
                        evidenceTurnIds: [],
                      }),
                    ),
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
                    reason: "用户提了请求",
                    evidenceTurnIds: ["user-e1"],
                  },
                }),
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch,
  });
  assert.equal(sent.enable_thinking, false);
  assert.equal(sent.model, "kimi-k2.6");
  assert.equal(sent.stream, false);
});
