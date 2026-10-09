import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import { buildZip, collectSkillEntries, crc32 } from "./skills-zip";

/** 自己拆一遍 ZIP：验证中央目录、CRC 与内容能对上（不依赖系统 unzip）。 */
function readZip(zip: Buffer): { name: string; data: Buffer }[] {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end > 0, "应当有 EOCD 记录");
  const count = zip.readUInt16LE(end + 10);
  let cursor = zip.readUInt32LE(end + 16);
  const out: { name: string; data: Buffer }[] = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(zip.readUInt32LE(cursor), 0x02014b50, "中央目录头签名");
    const method = zip.readUInt16LE(cursor + 10);
    const crc = zip.readUInt32LE(cursor + 16);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const rawSize = zip.readUInt32LE(cursor + 24);
    const nameLen = zip.readUInt16LE(cursor + 28);
    const extraLen = zip.readUInt16LE(cursor + 30);
    const commentLen = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const name = zip.subarray(cursor + 46, cursor + 46 + nameLen).toString("utf8");

    assert.equal(zip.readUInt32LE(localOffset), 0x04034b50, "本地头签名");
    assert.equal(zip.readUInt16LE(localOffset + 6) & 0x0800, 0x0800, "UTF-8 标志");
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + localNameLen + localExtraLen;
    const body = zip.subarray(start, start + compressedSize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);

    assert.equal(data.length, rawSize, `${name} 解压后长度`);
    assert.equal(crc32(data), crc, `${name} 的 CRC 对不上`);
    out.push({ name, data });
    cursor += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

test("CRC32 与标准一致（已知答案）", () => {
  assert.equal(crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(crc32(Buffer.from("")), 0);
});

test("ZIP 容器：中文与长文本都能原样取回", () => {
  const entries = [
    { name: "a/SKILL.md", data: Buffer.from("# 标题\n中文内容\n", "utf8") },
    { name: "b.txt", data: Buffer.from("x".repeat(5000), "utf8") },
  ];
  const zip = buildZip(entries, new Date("2026-09-21T10:00:00Z"));
  assert.equal(zip.subarray(0, 4).toString("hex"), "504b0304");
  const read = readZip(zip);
  assert.deepEqual(
    read.map((item) => item.name),
    ["a/SKILL.md", "b.txt"],
  );
  assert.equal(read[0].data.toString("utf8"), "# 标题\n中文内容\n");
  assert.equal(read[1].data.length, 5000);
});

test("Skill 包：包含两份 Skill 与安装说明", () => {
  const { entries, missing } = collectSkillEntries();
  assert.deepEqual(missing, [], `找不到这些 Skill：${missing.join("、")}`);
  const names = entries.map((entry) => entry.name);
  assert.ok(names.includes("companionsim-ops/SKILL.md"));
  assert.ok(names.includes("companionsim-author/SKILL.md"));
  // 文件名必须是 ASCII：macOS 自带的 unzip 不认 UTF-8 通用标志
  assert.ok(names.includes("INSTALL.md"));
  for (const name of names) {
    assert.match(name, /^[\x20-\x7e]+$/, `${name} 含非 ASCII 字符`);
  }
  const install = entries.find((entry) => entry.name === "INSTALL.md");
  assert.ok(install, "应当带安装说明");
  const note = install.data.toString("utf8");
  for (const dir of [".claude/skills/", ".codex/skills/", ".pi/agent/skills/", ".cursor/skills/"]) {
    assert.ok(note.includes(dir), `安装说明应当写明 ${dir}`);
  }
  // 打出来的 zip 也要能拆回同样的内容
  const read = readZip(buildZip(entries));
  assert.equal(read.length, entries.length);
  assert.ok(read.every((item, index) => item.name === entries[index].name));
});

test("Skill 文件里不夹带凭据样式的字符串", () => {
  const { entries } = collectSkillEntries();
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    const text = entry.data.toString("utf8");
    assert.equal(/simk_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}/.test(text), false, entry.name);
  }
});
