import { ensureConfiguration, nacosEnabled } from "./config-center";
import { migrate } from "./migrations";
import { purgeExpiredSessions } from "./auth";
import { seedConfigDir } from "./paths";
import { platformConfigStatus } from "./platform-config";
import { ensureSeedAdmin } from "./users";

/**
 * 进程启动后的一次性准备：种默认配置、建表、清过期会话。
 * 幂等，且只跑一次；失败的原始错误留给调用方决定怎么呈现。
 */

let ready: Promise<void> | undefined;
let lastError: string | undefined;

export function platformReadyError(): string | undefined {
  return lastError;
}

async function prepare(): Promise<void> {
  await ensureConfiguration();
  const seeded = nacosEnabled() ? [] : seedConfigDir();
  if (seeded.length > 0) {
    console.warn(`[boot] 已从镜像种下默认配置：${seeded.join("、")}`);
  }
  const status = await platformConfigStatus();
  if (status.state !== "ok") {
    // 没有数据库就不建表也不清会话；鉴权相关接口会给出明确提示。
    lastError = status.state === "invalid" ? status.error : undefined;
    return;
  }
  await migrate();
  const seededAdmin = await ensureSeedAdmin(
    status.config.superadmin.username,
    status.config.superadmin.passwordHash,
  );
  if (!seededAdmin) {
    console.warn(
      "[boot] superadmin.passwordHash 为空，未写入首个管理员。生成哈希：npm run admin-password -- <密码>",
    );
  }
  await purgeExpiredSessions();
}

/** 每个请求都可以调；内部只执行一次。 */
export async function ensurePlatformReady(): Promise<void> {
  ready ??= prepare().catch((err) => {
    // 允许下次请求重试（例如数据库稍后才起来）。
    ready = undefined;
    lastError = err instanceof Error ? err.message : String(err);
    throw err;
  });
  return ready;
}

export function resetPlatformReady(): void {
  ready = undefined;
  lastError = undefined;
}
