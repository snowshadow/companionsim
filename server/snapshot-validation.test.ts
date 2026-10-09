import assert from "node:assert/strict";
import test from "node:test";
import { parseScript, parseSnapshotFile } from "./validate";
import { personFile, runFile } from "./paths";
import type { Person, Script, Snapshot } from "../shared/schema";

const person: Person = {
  id: "p-1",
  name: "测试人群",
  version: "v1",
  immutable: true,
  summary: "25岁女性，喜欢动漫",
  age: 25,
  gender: "女",
  interests: ["动漫"],
  expectedDiff: "明确地说出偏好",
  expectedDiffScripts: ["s-1"],
  behaviors: [
    { name: "直接", instructions: ["明确表达"], violations: ["含糊表达"] },
  ],
};
const script: Script = {
  id: "s-1",
  name: "测试剧本",
  version: "v1",
  family: "over-promise",
  events: [
    { id: "e1", clock: "21:00", kind: "speak", intent: "请关灯" },
  ],
};
const frozen: Snapshot = {
  id: "snap-1",
  sourceRunId: "r-1",
  personId: "p-1",
  personVersion: "v1",
  scriptId: "s-1",
  scriptVersion: "v1",
  lines: [{ eventId: "e1", clock: "21:00", user: "请关灯。" }],
  personSnapshot: person,
  scriptSnapshot: script,
};

test("冻结材料读取保留本体，独立于当前目录的最新配置", () => {
  const parsed = parseSnapshotFile(frozen, "snap-1");
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.deepEqual(parsed.value.personSnapshot, person);
    assert.deepEqual(parsed.value.scriptSnapshot, script);
  }
});

test("冻结事件、时间和版本不一致时拒绝回归", () => {
  assert.equal(parseSnapshotFile({ ...frozen, scriptVersion: "v2" }).ok, false);
  assert.equal(
    parseSnapshotFile({
      ...frozen,
      lines: [{ ...frozen.lines[0], clock: "22:00" }],
    }).ok,
    false,
  );
  assert.equal(
    parseSnapshotFile({ ...frozen, lines: [...frozen.lines, ...frozen.lines] })
      .ok,
    false,
  );
});

test("旧快照缺内嵌材料仍可读取；不补写今天的材料", () => {
  const { personSnapshot: _p, scriptSnapshot: _s, ...legacy } = frozen;
  const parsed = parseSnapshotFile(legacy);
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.equal(parsed.value.personSnapshot, undefined);
});

test("API产物标识不能跳出产物目录", () => {
  assert.throws(() => runFile("../config/suts"));
  assert.throws(() => personFile("p-1", "../../config/suts"));
  assert.throws(() => runFile("x\\y"));
});

test("单场时间允许跨午夜，但不允许倒退", () => {
  const base = { ...script, id: "s-2", name: "跨午夜" };
  const ok = parseScript(
    { ...base, events: [
      { id: "a", clock: "23:55", kind: "speak", intent: "睡前一句" },
      { id: "b", clock: "00:03", kind: "speak", intent: "又冒一句" },
    ] },
    { fileStem: "s-2@v1" },
  );
  assert.equal(ok.ok, true, "23:55 → 00:03 是合法的长夜对话");
  const back = parseScript(
    { ...base, events: [
      { id: "a", clock: "10:00", kind: "speak", intent: "上午一句" },
      { id: "b", clock: "08:00", kind: "speak", intent: "倒回一句" },
    ] },
    { fileStem: "s-2@v1" },
  );
  assert.equal(back.ok, false, "同一个白天内倒退必须被拒");
});
