import assert from "node:assert/strict";
import { test } from "node:test";
import { agentBriefing } from "./briefing";

test("交接语：带上平台地址与 Key，并说清 agent 不能做什么", () => {
  const text = agentBriefing("https://simulator.example", "simk_abc12345_secret");
  assert.ok(text.includes("https://simulator.example"));
  assert.ok(text.includes("simk_abc12345_secret"));
  assert.ok(text.includes("https://simulator.example/api/skills.zip"));
  assert.ok(text.includes("https://simulator.example/api/auth/me"));
  // 红线必须写明：判定不能代签
  assert.ok(text.includes("纳入回归"));
  assert.ok(text.includes("不能改被测、评审、仿真 agent 的配置"));
  // 结尾不要有空白行，粘贴过去干净
  assert.equal(text.trim(), text);
});

test("交接语：还没生成 Key 时留出占位，不编一个假 Key", () => {
  const text = agentBriefing("http://localhost:5260");
  assert.ok(text.includes("simk_"));
  assert.ok(text.includes("还没生成"));
  assert.equal(/simk_[0-9a-f]{8}_/.test(text), false, "不能出现看起来像真 Key 的串");
});

test("交接语：地址末尾多写斜杠也不出双斜杠", () => {
  const text = agentBriefing("https://simulator.example/", "k");
  assert.ok(text.includes("https://simulator.example/api/skills.zip"));
  assert.equal(text.includes("simulator.example//"), false);
});
