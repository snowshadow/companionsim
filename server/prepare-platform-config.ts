import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { hashPassword } from "./password";
import { platformConfigFile } from "./paths";

/**
 * 容器首次启动时，若平台配置还不存在，用环境变量写一份。
 * 本地 `npm run dev` 不经过这里。
 */

export function platformDocumentFromEnv(): Record<string, unknown> {
  const password = process.env.ADMIN_PASSWORD;
  if (password === undefined || password === "") {
    throw new Error(
      "缺少 ADMIN_PASSWORD。请设置管理员密码（至少 8 位）；容器会计算哈希并写入平台配置，然后才启动服务。",
    );
  }
  const username = process.env.ADMIN_USERNAME?.trim() ?? "";
  if (username === "") {
    throw new Error("缺少 ADMIN_USERNAME。请设置管理员用户名。");
  }
  const mysqlPassword = process.env.MYSQL_PASSWORD;
  if (mysqlPassword === undefined || mysqlPassword === "") {
    throw new Error("缺少 MYSQL_PASSWORD。请把数据库口令通过环境变量传给应用。");
  }
  const mysqlUser = process.env.MYSQL_USER?.trim() ?? "";
  if (mysqlUser === "") {
    throw new Error("缺少 MYSQL_USER。请把数据库用户通过环境变量传给应用。");
  }
  const port = Number(process.env.MYSQL_PORT ?? "3306");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("MYSQL_PORT 必须是 1 到 65535 的整数");
  }
  const host = process.env.MYSQL_HOST?.trim() || "mysql";
  const database = process.env.MYSQL_DATABASE?.trim() || "sim_eval";
  return {
    mysql: {
      host,
      port,
      user: mysqlUser,
      password: mysqlPassword,
      database,
      connectionLimit: 8,
    },
    superadmin: {
      username,
      passwordHash: hashPassword(password),
    },
    session: {
      cookieName: "sim_session",
      ttlHours: 168,
    },
  };
}

export async function ensureDockerPlatformConfig(
  file = platformConfigFile(),
): Promise<void> {
  try {
    await access(file);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const document = platformDocumentFromEnv();
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, file);
}

function isDirectRun(): boolean {
  const argv = process.argv[1];
  if (!argv) return false;
  return pathToFileURL(path.resolve(argv)).href === import.meta.url;
}

if (isDirectRun()) {
  ensureDockerPlatformConfig().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
