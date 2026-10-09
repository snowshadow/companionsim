import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import mysql from "mysql2/promise";
import type { TestContext } from "node:test";
import { closePool } from "./db";
import { migrate } from "./migrations";
import { resetPlatformConfigCache } from "./platform-config";
import { resetQuotaCache, resetQuotaWarning } from "./quota";
import { resetAuditWarning } from "./audit";
import { resetPlatformReady } from "./bootstrap";
import { hashPassword } from "./password";

/**
 * 测试用的平台环境：临时数据目录 + 一个独立的 MySQL 库（用完就删）。
 *
 * 没配 `SIM_EVAL_TEST_MYSQL_HOST/PORT/USER/PASSWORD` 就跳过——本地没装 MySQL
 * 不该让这些用例变成红的；CI 里挂了 mysql 服务，会真的跑。
 * 本机开发可以把这几项写进 .env.local（见 README）。
 */

export type MysqlTarget = {
  host: string;
  port: number;
  user: string;
  password: string;
};

const ENV_FILE = path.resolve(process.cwd(), ".env.local");

async function fromEnvFile(keys: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = await fs.readFile(ENV_FILE, "utf8");
  } catch {
    return out;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!keys.includes(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export async function mysqlTarget(): Promise<MysqlTarget | undefined> {
  const keys = [
    "SIM_EVAL_TEST_MYSQL_HOST",
    "SIM_EVAL_TEST_MYSQL_PORT",
    "SIM_EVAL_TEST_MYSQL_USER",
    "SIM_EVAL_TEST_MYSQL_PASSWORD",
  ];
  const file = await fromEnvFile(keys);
  const read = (key: string): string =>
    (process.env[key] ?? file[key] ?? "").trim();
  const host = read("SIM_EVAL_TEST_MYSQL_HOST");
  if (host === "") return undefined;
  return {
    host,
    port: Number(read("SIM_EVAL_TEST_MYSQL_PORT") || 3306),
    user: read("SIM_EVAL_TEST_MYSQL_USER"),
    password: read("SIM_EVAL_TEST_MYSQL_PASSWORD"),
  };
}

export type TestPlatform = {
  /** 临时数据目录（artifacts 与 config 都在这里）。 */
  root: string;
  database: string;
  /** 首个管理员密码明文，配合 platform.json 里的哈希。 */
  superadminPassword: string;
};

/** 连不上库时的文案：把「配置对但拉不起来」和「压根没配」分开。 */
function unreachable(target: MysqlTarget, err: unknown): string {
  const reason = err instanceof Error ? err.message : String(err);
  return [
    `连不上测试用 MySQL（${target.host}:${target.port}）：${reason}`,
    "  · CI：确认 runner 能拉取公网 mysql:8，并把 SIM_EVAL_TEST_MYSQL_* 指到该服务；",
    "    见 .github/workflows/ci.yml。",
    "  · 本机：检查 .env.local / 环境变量里的 SIM_EVAL_TEST_MYSQL_*。",
  ].join("\n");
}

export async function withTestPlatform(
  t: TestContext,
  fn: (platform: TestPlatform) => Promise<void>,
): Promise<void> {
  const target = await mysqlTarget();
  if (!target) {
    t.skip(
      "未配置测试用 MySQL（SIM_EVAL_TEST_MYSQL_HOST/PORT/USER/PASSWORD）；CI 里由 mysql 服务提供",
    );
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sim-eval-auth-"));
  const database = `sim_eval_test_${process.pid}_${randomBytes(3).toString("hex")}`;
  const superadminPassword = "test-superadmin-pw";

  let admin: Awaited<ReturnType<typeof mysql.createConnection>>;
  try {
    admin = await mysql.createConnection({
      host: target.host,
      port: target.port,
      user: target.user,
      password: target.password,
      connectTimeout: 10_000,
    });
  } catch (err) {
    // 显式声明「凑合放行」时才跳，而且跳得看得见——否则流水线会静默失去权限层的保护。
    if (process.env.SIM_EVAL_TEST_MYSQL_OPTIONAL === "1") {
      console.warn(`[mysql-test] ${unreachable(target, err)}`);
      t.skip(`MySQL 不可达，按 SIM_EVAL_TEST_MYSQL_OPTIONAL=1 跳过：${target.host}:${target.port}`);
      return;
    }
    throw new Error(unreachable(target, err));
  }
  try {
    await admin.query(
      `CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`,
    );
    await fs.mkdir(path.join(root, "config"), { recursive: true });
    await fs.writeFile(
      path.join(root, "config", "platform.json"),
      `${JSON.stringify(
        {
          mysql: {
            host: target.host,
            port: target.port,
            user: target.user,
            password: target.password,
            database,
            connectionLimit: 4,
          },
          feishu: {
            appId: "cli_test_app",
            appSecret: "test_app_secret",
            redirectUri: "https://sim.test/api/auth/feishu/callback",
            authorizeBase: "https://accounts.feishu.cn",
            apiBase: "https://open.feishu.cn",
            scope: "contact:user.base:readonly",
          },
          superadmin: {
            username: "admin",
            passwordHash: hashPassword(superadminPassword),
          },
          adminFeishuOpenIds: ["ou_admin"],
          session: { cookieName: "sim_session", ttlHours: 24 },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    process.env.NODE_ENV = "test";
    process.env.SIM_EVAL_DATA_ROOT = root;
    delete process.env.SIM_EVAL_TEST_ROOT;
    resetPlatformConfigCache();
    resetQuotaCache();
    resetQuotaWarning();
    resetAuditWarning();
    resetPlatformReady();

    await migrate();
    await fn({
      root,
      database,
      superadminPassword,
    });
  } finally {
    await closePool();
    await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
    await admin.end();
    delete process.env.SIM_EVAL_DATA_ROOT;
    resetPlatformConfigCache();
    resetQuotaCache();
    resetQuotaWarning();
    resetAuditWarning();
    resetPlatformReady();
    await fs.rm(root, { recursive: true, force: true });
  }
}

/** 复用同一份临时环境跑多组断言时的辅助：清掉按 key 缓存的连接池。 */
export async function recyclePool(): Promise<void> {
  await closePool();
}
