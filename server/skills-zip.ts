import fs from "node:fs";
import path from "node:path";
import { deflateRawSync } from "node:zlib";
import { dataRoot, imageRoot } from "./paths";

/**
 * 把仓库里的 Skill 打成一个 zip 直接下载。
 *
 * 为什么不用 `npx skills add`：给非技术同事的成本太高（要装 node、配 SSH key、
 * 记命令行）。zip 解压到宿主的 skills 目录就行，平台里点一下即可。
 *
 * ZIP 只用 store/deflate 两种最基础的能力，自己写容器格式：
 * 标准解压工具（Finder、Windows 资源管理器、unzip）都能开。
 */

export type ZipEntry = { name: string; data: Buffer; mtime?: Date };

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date: Date): { time: number; date: number } {
  const time =
    (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
  const day =
    ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time: time & 0xffff, date: day & 0xffff };
}

/** 最小 ZIP 写入器。UTF-8 文件名（通用标志 bit 11），deflate 压缩。 */
export function buildZip(entries: ZipEntry[], now = new Date()): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const raw = entry.data;
    const deflated = deflateRawSync(raw, { level: 9 });
    // 压不动就存原样，别把体积搞大。
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const stamp = dosTime(entry.mtime ?? now);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    chunks.push(local, name, body);

    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4); // version made by
    head.writeUInt16LE(20, 6); // version needed
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(method, 10);
    head.writeUInt16LE(stamp.time, 12);
    head.writeUInt16LE(stamp.date, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(raw.length, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt16LE(0, 30); // extra
    head.writeUInt16LE(0, 32); // comment
    head.writeUInt16LE(0, 34); // disk
    head.writeUInt16LE(0, 36); // internal attrs
    head.writeUInt32LE(0, 38); // external attrs
    head.writeUInt32LE(offset, 42);
    central.push(head, name);

    offset += local.length + name.length + body.length;
  }

  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...chunks, centralBuf, end]);
}

/* ── 打包内容 ─────────────────────────────────────────────────────── */

export const SKILL_IDS = ["companionsim-ops", "companionsim-author"] as const;

function skillRoots(): string[] {
  return [
    path.join(imageRoot(), ".cursor", "skills"),
    path.join(dataRoot(), ".cursor", "skills"),
  ];
}

function readDirFiles(dir: string, prefix: string): ZipEntry[] {
  const out: ZipEntry[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const abs = path.join(dir, name);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      out.push(...readDirFiles(abs, `${prefix}${name}/`));
      continue;
    }
    out.push({
      name: `${prefix}${name}`,
      data: fs.readFileSync(abs),
      mtime: stat.mtime,
    });
  }
  return out;
}

export type SkillPack = { entries: ZipEntry[]; missing: string[] };

/** 收集两份 Skill 的文件；找不到的记进 missing，由调用方决定是否报错。 */
export function collectSkillEntries(): SkillPack {
  const entries: ZipEntry[] = [];
  const missing: string[] = [];
  for (const id of SKILL_IDS) {
    const dir = skillRoots()
      .map((root) => path.join(root, id))
      .find((candidate) => fs.existsSync(candidate));
    if (!dir) {
      missing.push(id);
      continue;
    }
    entries.push(...readDirFiles(dir, `${id}/`));
  }
  if (entries.length > 0) {
    // 文件名用 ASCII：macOS 自带的 Info-ZIP unzip 不认 UTF-8 通用标志，
    // 中文名会被解码成乱码并解压失败（内容仍是中文）。Finder 双击两种都行。
    entries.push({
      name: "INSTALL.md",
      data: Buffer.from(INSTALL_NOTE, "utf8"),
    });
  }
  return { entries, missing };
}

export const SKILL_ZIP_NAME = "companionsim-skills.zip";

const INSTALL_NOTE = `# CompanionSim · 本地 agent Skill 安装（INSTALL）

> 文件名是英文是为了各系统的解压工具都不出乱码，内容就是中文。

这两份 Skill 让 Codex / pi / Claude Code / Cursor 这类本地 agent 会操作 CompanionSim：
登记 OpenAI 或 Anthropic 兼容的被测、发起探索与回归、读证据（companionsim-ops），按规范写人群与剧本（companionsim-author）。

## 怎么装（选一个）

解压后你会看到两个目录：\`companionsim-ops/\`、\`companionsim-author/\`。
把这两个目录整个放到你所用 agent 的 skills 目录里：

| 你用的 agent | 放这里（把两个目录拷进去） |
| --- | --- |
| Claude Code | \`~/.claude/skills/\` |
| Codex | \`~/.codex/skills/\` |
| pi | \`~/.pi/agent/skills/\` |
| Cursor | \`~/.cursor/skills/\` |
| 其它（Grok / Amp / OpenCode / Copilot…） | 见它的文档，认 \`<skills目录>/<名字>/SKILL.md\` 这种结构 |

命令行一句话（macOS / Linux，先 cd 到解压出来的目录）：

\`\`\`bash
mkdir -p ~/.claude/skills && cp -R companionsim-ops companionsim-author ~/.claude/skills/
\`\`\`

Windows 就把两个文件夹拖进上面那个目录。

## 装完之后

1. 在平台「我的」页生成一把 Key（scope 选 read + author + run），
   放进本地环境变量 \`SIM_EVAL_KEY\`，或写进 agent 的配置里。
2. 让 agent 自检：\`curl -s -H "Authorization: Bearer $SIM_EVAL_KEY" <平台地址>/api/auth/me\`。
3. 然后直接跟它说：登记一个 OpenAI 或 Anthropic 兼容的被测，用内置样例跑一局确认能收能发。

## 注意

- Skill 里的 \`docs/...\` 是平台仓库内的路径，你这份副本里没有；
  读不到就以平台接口为准（\`GET /api/catalog\`、\`GET /api/health\`），
  SKILL.md 里已经把要紧的契约写全了。
- 装了新版就把旧的两个目录替换掉，别留两份。
- 想更新：回平台「我的」页重新下载 zip，覆盖这两个目录。
`;
