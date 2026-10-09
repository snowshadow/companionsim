import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { artifactDir, relFromData, type ArtifactKind } from "./paths";

export type ListedFile = {
  filename: string;
  absPath: string;
  relPath: string;
  stem: string;
};

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function listJsonFiles(kind: ArtifactKind): Promise<ListedFile[]> {
  const dir = artifactDir(kind);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return [];
    throw err;
  }
  const out: ListedFile[] = [];
  for (const filename of names) {
    if (!filename.endsWith(".json") || filename.startsWith(".")) continue;
    const absPath = path.join(dir, filename);
    out.push({
      filename,
      absPath,
      relPath: relFromData(absPath),
      stem: filename.slice(0, -".json".length),
    });
  }
  out.sort((a, b) => a.filename.localeCompare(b.filename, "en"));
  return out;
}

export async function readJson(absPath: string): Promise<unknown> {
  const raw = await fs.readFile(absPath, "utf8");
  return JSON.parse(raw) as unknown;
}

export async function readJsonIfExists(
  absPath: string,
): Promise<unknown | undefined> {
  try {
    return await readJson(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw err;
  }
}

export async function writeJson(absPath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(absPath));
  const text = `${JSON.stringify(data, null, 2)}\n`;
  const tmp = `${absPath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  await fs.rename(tmp, absPath);
}

export function parseIdVersionStem(
  stem: string,
): { id: string; version: string } | undefined {
  const at = stem.lastIndexOf("@");
  if (at <= 0 || at === stem.length - 1) return undefined;
  return { id: stem.slice(0, at), version: stem.slice(at + 1) };
}

export async function nextNumberedId(
  kind: "runs" | "snapshots",
  prefix: string,
): Promise<string> {
  const files = await listJsonFiles(kind);
  let max = 0;
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  for (const file of files) {
    const m = file.stem.match(re);
    if (m) max = Math.max(max, Number.parseInt(m[1], 10));
  }
  return `${prefix}-${String(max + 1).padStart(3, "0")}`;
}
