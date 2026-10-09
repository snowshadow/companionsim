import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { verifyPassword } from "./password";
import {
  ensureDockerPlatformConfig,
  platformDocumentFromEnv,
} from "./prepare-platform-config";

const KEYS = [
  "ADMIN_USERNAME",
  "ADMIN_PASSWORD",
  "MYSQL_HOST",
  "MYSQL_PORT",
  "MYSQL_USER",
  "MYSQL_PASSWORD",
  "MYSQL_DATABASE",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  return Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const key of KEYS) {
    const value = saved[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test("缺少 ADMIN_PASSWORD 时容器入口失败，且不覆盖已有平台配置", async () => {
  const saved = snapshotEnv();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sim-platform-"));
  const file = path.join(root, "config", "platform.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '{"keep":true}\n');
  try {
    delete process.env.ADMIN_PASSWORD;
    await ensureDockerPlatformConfig(file);
    assert.equal(await fs.readFile(file, "utf8"), '{"keep":true}\n');
    await fs.rm(file);
    await assert.rejects(ensureDockerPlatformConfig(file), /缺少 ADMIN_PASSWORD/);
    await assert.rejects(fs.access(file));
  } finally {
    restoreEnv(saved);
  }
});

test("容器入口用环境变量写出数据库连接和管理员密码哈希", () => {
  const saved = snapshotEnv();
  try {
    process.env.ADMIN_USERNAME = "admin";
    process.env.ADMIN_PASSWORD = "local-admin-password";
    process.env.MYSQL_HOST = "mysql";
    process.env.MYSQL_PORT = "3306";
    process.env.MYSQL_USER = "sim";
    process.env.MYSQL_PASSWORD = "local-mysql-password";
    process.env.MYSQL_DATABASE = "sim_eval";
    const document = platformDocumentFromEnv() as {
      mysql: { host: string; user: string; password: string; database: string };
      superadmin: { username: string; passwordHash: string };
    };
    assert.equal(document.mysql.host, "mysql");
    assert.equal(document.mysql.user, "sim");
    assert.equal(document.mysql.password, "local-mysql-password");
    assert.equal(document.mysql.database, "sim_eval");
    assert.equal(document.superadmin.username, "admin");
    assert.equal(
      verifyPassword("local-admin-password", document.superadmin.passwordHash),
      true,
    );
    assert.equal(document.superadmin.passwordHash.includes("local-admin-password"), false);
  } finally {
    restoreEnv(saved);
  }
});
