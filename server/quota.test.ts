import assert from "node:assert/strict";
import { test } from "node:test";
import type { Script } from "../shared/schema";
import {
  DEFAULT_QUOTA,
  estimateHuntTokens,
  estimateReplayTokens,
  judgeTurnCount,
} from "./quota";

function script(speaks: number): Script {
  return {
    id: "s",
    name: "s",
    version: "v1",
    family: "short-term-memory",
    events: Array.from({ length: speaks }, (_, i) => ({
      id: `e${i}`,
      clock: `21:${String(i).padStart(2, "0")}`,
      kind: "speak" as const,
      intent: "说一句",
    })),
  };
}

test("预估：历史按逐拍累加，不是每拍都顶满回看上限", () => {
  const q = DEFAULT_QUOTA;
  // 2 拍：第 1 拍没有历史，第 2 拍最多 2 条
  const two = estimateHuntTokens(script(2), 40, q);
  const perBeatMax =
    q.estimate.simAgentFixed + 40 * q.estimate.simAgentPerHistoricalTurn + q.estimate.simAgentPerBeat;
  const judge = q.estimate.judgeFixed + 4 * q.estimate.judgePerTurn;
  assert.ok(
    two < (2 * perBeatMax + judge) * q.estimate.safetyFactor,
    "2 拍的小剧本不该按「每拍都顶满 40 轮历史」估",
  );
  // 短剧本明显比长剧本便宜，且单调
  const six = estimateHuntTokens(script(6), 40, q);
  const long = estimateHuntTokens(script(55), 40, q);
  assert.ok(two < six && six < long, `${two} < ${six} < ${long}`);
  // 长剧本会被历史项主导（平方级）
  const noHistory = estimateHuntTokens(script(55), 0, q);
  assert.ok(long > noHistory * 2, `历史项应当主导长剧本：${long} vs ${noHistory}`);
});

test("预估：回归只算评审，比同剧本的探索便宜", () => {
  const hunt = estimateHuntTokens(script(6), 40, DEFAULT_QUOTA);
  const replay = estimateReplayTokens(script(6), DEFAULT_QUOTA);
  assert.ok(replay < hunt / 2, `回归应当明显更便宜：${replay} vs ${hunt}`);
});

test("评审轮数：事件 + 2×说话（不是事件×2）", () => {
  // 61 事件 / 55 说话的长对话实测 177 轮；旧公式 事件×2 只有 122，会让长剧本评审预估少算一半
  const long = script(55);
  const withEvents = { ...long, events: [...long.events, ...Array.from({ length: 6 }, (_, i) => ({ id: `x${i}`, clock: "23:59", kind: "silence" as const }))] };
  assert.equal(judgeTurnCount(withEvents), 61 + 55 * 2);
  assert.ok(judgeTurnCount(withEvents) > 61 * 2);
  // 全是沉默的剧本也要有下限 1
  assert.equal(judgeTurnCount({ ...long, events: [] }), 1);
});
