import assert from "node:assert/strict";
import test from "node:test";
import {
  canDecide,
  failureHint,
  isReviewable,
  needsHumanReview,
  runGeneration,
  stateLabel,
} from "./run-state";
import type { Run } from "./schema";

const base = {
  mode: "hunt",
  status: "pending",
  phase: "running",
  stage: "dialogue",
} as Run;

test("对话和评审均为运行中，人工决策不得抢先", () => {
  assert.equal(stateLabel(base), "运行中 · 仿真对话");
  assert.equal(stateLabel({ ...base, stage: "judging" }), "运行中 · 自动评审");
  assert.equal(canDecide({ ...base, dialogueStatus: "done" }), false);
});

test("评审失败保留人工判断入口；对话失败不可纳入回归", () => {
  const reviewFailed = {
    ...base,
    phase: "failed",
    stage: "judging",
    dialogueStatus: "done",
  } as Run;
  assert.equal(stateLabel(reviewFailed), "未完成 · 评审失败");
  assert.equal(canDecide(reviewFailed), true);
  assert.equal(canDecide({ ...reviewFailed, dialogueStatus: "failed" }), false);
});

test("无法判定可再处理；回归不产生第二个纳入回归入口", () => {
  assert.equal(
    isReviewable({ ...base, phase: "done", status: "unclear" }),
    true,
  );
  assert.equal(canDecide({ ...base, phase: "done", mode: "replay" }), false);
  assert.equal(
    stateLabel({ ...base, phase: "done", mode: "replay" }),
    "待查看",
  );
  assert.equal(
    stateLabel({
      ...base,
      phase: "done",
      mode: "replay",
      reviewedAt: "2026-09-11T10:00:00Z",
    }),
    "已查看",
  );
});

test("旧记录没有执行阶段时仍按已有结果读取", () => {
  assert.equal(stateLabel({ ...base, phase: undefined }), "待审");
  assert.equal(canDecide({ ...base, phase: undefined }), true);
});

test("产物代际：旧文件按证据推导，新开局以字段为准", () => {
  // 第 1 代：只有关键词 scores，没有 evaluations / userGenerator。
  assert.equal(
    runGeneration({
      generation: undefined,
      userGenerator: undefined,
      evaluations: undefined,
      generatorSnapshot: undefined,
      generations: undefined,
    }),
    1,
  );
  // 第 2 代：模板 / 冻结台词来源，或已有 LLM 评审。
  assert.equal(
    runGeneration({
      generation: undefined,
      userGenerator: "template-v1",
      evaluations: [],
      generatorSnapshot: undefined,
      generations: undefined,
    }),
    2,
  );
  assert.equal(
    runGeneration({
      generation: undefined,
      userGenerator: undefined,
      evaluations: [{ id: "e" } as never],
      generatorSnapshot: undefined,
      generations: undefined,
    }),
    2,
  );
  // 第 3 代：有生成器快照 / 逐句实测，或明确写了 llm-v1。
  assert.equal(
    runGeneration({
      generation: undefined,
      userGenerator: "llm-v1",
      evaluations: undefined,
      generatorSnapshot: undefined,
      generations: undefined,
    }),
    3,
  );
  assert.equal(
    runGeneration({
      generation: undefined,
      userGenerator: "template-v1",
      evaluations: undefined,
      generatorSnapshot: undefined,
      generations: [],
    }),
    3,
  );
  // 写死的字段优先于推导（将来回填时不会被推翻）。
  assert.equal(
    runGeneration({
      generation: 1,
      userGenerator: "llm-v1",
      evaluations: undefined,
      generatorSnapshot: undefined,
      generations: [],
    }),
    1,
  );
});

test("待审口径：角标与页内筛选共用同一个判断（含「无法判定」）", () => {
  const base = { mode: "hunt" as const, phase: "done" as const };
  // pending 与 unclear 都算待审；这是角标曾漏算 unclear 导致差一的地方
  assert.equal(needsHumanReview({ ...base, status: "pending" }), true);
  assert.equal(needsHumanReview({ ...base, status: "unclear" }), true);
  assert.equal(needsHumanReview({ ...base, status: "accepted" }), false);
  assert.equal(needsHumanReview({ ...base, status: "rejected" }), false);
  // 还在跑或已经失败的不能算「等着你看」
  assert.equal(
    needsHumanReview({ ...base, phase: "running", status: "pending" }),
    false,
  );
  assert.equal(
    needsHumanReview({ ...base, phase: "failed", status: "pending" }),
    false,
  );
});

test("失败原因翻人话：上游英文码有对应提示，原文留着悬停看", () => {
  const cases: [string, RegExp][] = [
    ["conversation_not_current · conversation is historical and read-only", /抢走了可写会话/],
    ["initialization_in_progress · another conversation is initializing", /初始化另一个会话/],
    ["未登录或会话已过期（SOULPALS_SESSION）", /被测登录态过期/],
    ["Chatbot API Key 无效、已过期或已吊销，请更新 CHATBOT_API_KEY", /被测服务 API Key 失效/],
    ["仿真 agent 接口 HTTP 401（已尝试 1 次，未成功）", /模型凭据失效/],
    ["FAILED · Fault", /被测运行时中断/],
    ["被测 HTTP 502", /被测返回 5xx/],
  ];
  for (const [raw, expected] of cases) {
    const { hint, raw: kept } = failureHint(raw);
    assert.match(hint, expected, raw);
    assert.equal(kept, raw, "原文要保留，方便悬停看细节");
  }
  // 认不出来的照样原样显示，不要吞掉信息
  assert.equal(failureHint("某个没见过的错误").hint, "某个没见过的错误");
  assert.equal(failureHint("").hint, "本次未完成");
  assert.equal(failureHint(undefined).hint, "本次未完成");
});
