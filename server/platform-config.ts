import { nacosEnabled, remotePlatform } from "./config-center";
import fs from "node:fs/promises";
import { interpolateEnv } from "./sut-config";
import { isRecord } from "./validate";
import { platformConfigFile } from "./paths";

/**
 * 平台自身配置：MySQL，以及账号密码登录的首个管理员种子。
 *
 * 放在 config/platform.json（不进 git），字段值支持 `${ENV}` 引用，
 * 所以现在可以直接写明文，以后要换 Secret 也不用改代码。
 * 旧文件里的 feishu / adminFeishuOpenIds 忽略，不参与启动。
 */

export type MysqlSettings = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit: number;
};

export type PlatformConfig = {
  mysql: MysqlSettings;
  superadmin: { username: string; passwordHash: string };
  session: { cookieName: string; ttlHours: number };
};

export const PLATFORM_CONFIG_HINT =
  "缺少 config/platform.json。复制 config/platform.example.json 并填写数据库与登录配置；该文件已被 .gitignore 忽略，不会提交。";

let cached: PlatformConfig | undefined;

function text(raw: unknown, label: string, errors: string[], required = true): string {
  if (raw === undefined || raw === null || raw === "") {
    if (required) errors.push(`${label} 必填`);
    return "";
  }
  if (typeof raw !== "string") {
    errors.push(`${label} 必须是字符串`);
    return "";
  }
  return interpolateEnv(raw.trim());
}

function num(raw: unknown, label: string, fallback: number, errors: string[]): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    errors.push(`${label} 必须是数字`);
    return fallback;
  }
  return raw;
}

export function parsePlatformConfig(raw: unknown): PlatformConfig {
  const errors: string[] = [];
  if (!isRecord(raw)) throw new Error("config/platform.json 必须是 JSON 对象");

  const mysqlRaw = isRecord(raw.mysql) ? raw.mysql : {};
  if (!isRecord(raw.mysql)) errors.push("mysql 必须是对象");
  const mysql: MysqlSettings = {
    host: text(mysqlRaw.host, "mysql.host", errors),
    port: num(mysqlRaw.port, "mysql.port", 3306, errors),
    user: text(mysqlRaw.user, "mysql.user", errors),
    password: text(mysqlRaw.password, "mysql.password", errors, false),
    database: text(mysqlRaw.database, "mysql.database", errors),
    connectionLimit: num(mysqlRaw.connectionLimit, "mysql.connectionLimit", 8, errors),
  };

  const superRaw = isRecord(raw.superadmin) ? raw.superadmin : {};
  if (!isRecord(raw.superadmin)) errors.push("superadmin 必须是对象");
  const superadmin = {
    username: text(superRaw.username, "superadmin.username", errors, false) || "admin",
    passwordHash: text(superRaw.passwordHash, "superadmin.passwordHash", errors, false),
  };

  const sessionRaw = isRecord(raw.session) ? raw.session : {};
  const cookieName = text(sessionRaw.cookieName, "session.cookieName", errors, false);
  if (cookieName && !/^[A-Za-z0-9_-]+$/.test(cookieName)) {
    errors.push("session.cookieName 只能包含字母、数字、下划线与连字符");
  }
  const session = {
    cookieName: cookieName || "sim_session",
    ttlHours: num(sessionRaw.ttlHours, "session.ttlHours", 168, errors),
  };

  if (errors.length > 0) {
    throw new Error(`config/platform.json 配置有误：\n- ${errors.join("\n- ")}`);
  }
  return { mysql, superadmin, session };
}

export type PlatformConfigStatus =
  | { state: "ok"; config: PlatformConfig }
  | { state: "missing" }
  | { state: "invalid"; error: string };

/**
 * 「缺文件」与「配置有误」要分开：
 * 前者是本地开发/用例里的无数据库模式（配额与审计降级为空操作）；
 * 后者必须大声报错，不能悄悄降级。
 */
export async function platformConfigStatus(): Promise<PlatformConfigStatus> {
  if (nacosEnabled()) {
    try { return { state: "ok", config: parsePlatformConfig(await remotePlatform()) }; }
    catch { return { state: "invalid", error: "Nacos 平台配置尚未就绪" }; }
  }
  if (cached) return { state: "ok", config: cached };
  let raw: string;
  try {
    raw = await fs.readFile(platformConfigFile(), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "missing" };
    }
    return { state: "invalid", error: err instanceof Error ? err.message : "读取失败" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { state: "invalid", error: "config/platform.json 不是合法 JSON" };
  }
  try {
    cached = parsePlatformConfig(parsed);
  } catch (err) {
    return {
      state: "invalid",
      error: err instanceof Error ? err.message : "配置有误",
    };
  }
  return { state: "ok", config: cached };
}

export async function platformConfig(): Promise<PlatformConfig> {
  const status = await platformConfigStatus();
  if (status.state === "ok") return status.config;
  if (status.state === "invalid") throw new Error(status.error);
  throw new Error(PLATFORM_CONFIG_HINT);
}

/** 测试与热改配置用；生产不会调用。 */
export function resetPlatformConfigCache(): void {
  cached = undefined;
}
