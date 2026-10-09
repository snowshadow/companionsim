import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type ArtifactKind = "people" | "scripts" | "snapshots" | "runs";

const IMAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function resolveRepoRoot(): string {
  // 测试必须使用独立临时目录，避免运行用例进入用户的实验记录。
  if (process.env.NODE_ENV === "test" && process.env.SIM_EVAL_TEST_ROOT) {
    return path.resolve(process.env.SIM_EVAL_TEST_ROOT);
  }
  const candidates = [IMAGE_ROOT, process.cwd()];
  for (const root of candidates) {
    if (fs.existsSync(path.join(root, "artifacts"))) return root;
  }
  return candidates[0];
}

/** 镜像（代码）所在目录。只读，与数据目录分开。 */
export function imageRoot(): string {
  return IMAGE_ROOT;
}

export function repoRoot(): string {
  return resolveRepoRoot();
}

/**
 * 数据根目录：产物、配置与本地状态都放这里。
 *
 * 本地开发不设 `SIM_EVAL_DATA_ROOT`，行为与从前完全一致（数据在仓库里）。
 * 容器里设成挂载点（如 `/data`），这样镜像可只读，重启不丢配置与产物。
 */
export function dataRoot(): string {
  const override = process.env.SIM_EVAL_DATA_ROOT?.trim();
  if (!override) return repoRoot();
  return path.resolve(override);
}

export function artifactsRoot(): string {
  return path.join(dataRoot(), "artifacts");
}

export function artifactDir(kind: ArtifactKind): string {
  return path.join(artifactsRoot(), kind);
}

export function configDir(): string {
  return path.join(dataRoot(), "config");
}

/** 只有数据目录与仓库分离时才需要把镜像里的默认配置种过去。 */
export function imageConfigDir(): string {
  return path.join(IMAGE_ROOT, "config");
}

export function personFile(id: string, version: string): string {
  assertSegment(id);
  assertSegment(version);
  return path.join(artifactDir("people"), `${id}@${version}.json`);
}

export function scriptFile(id: string, version: string): string {
  assertSegment(id);
  assertSegment(version);
  return path.join(artifactDir("scripts"), `${id}@${version}.json`);
}

export function snapshotFile(id: string): string {
  assertSegment(id);
  return path.join(artifactDir("snapshots"), `${id}.json`);
}

export function runFile(id: string): string {
  assertSegment(id);
  return path.join(artifactDir("runs"), `${id}.json`);
}

export function sutConfigFile(): string {
  return path.join(configDir(), "suts.json");
}

export function configFile(name: string): string {
  return path.join(configDir(), name);
}

/** 平台自身配置（含数据库与登录凭据）。真值不进 git，见 platform.example.json。 */
export function platformConfigFile(): string {
  return configFile("platform.json");
}

export function relFromData(absPath: string): string {
  return path.relative(dataRoot(), absPath).split(path.sep).join("/");
}

/**
 * 数据目录与仓库分离时，把镜像里的默认配置种进数据目录（只补缺失的文件）。
 * 返回新种下的文件名，供启动日志说明。
 */
export function seedConfigDir(): string[] {
  if (dataRoot() === repoRoot()) return [];
  const source = imageConfigDir();
  const target = configDir();
  if (!fs.existsSync(source)) return [];
  fs.mkdirSync(target, { recursive: true });
  const seeded: string[] = [];
  for (const name of fs.readdirSync(source)) {
    if (!name.endsWith(".json")) continue;
    const to = path.join(target, name);
    if (fs.existsSync(to)) continue;
    fs.copyFileSync(path.join(source, name), to);
    seeded.push(name);
  }
  return seeded;
}

function assertSegment(value: string): void {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    /[\\/\\\\\u0000]/.test(value) ||
    value.includes("..")
  ) {
    throw new Error("无效的产物标识");
  }
}
