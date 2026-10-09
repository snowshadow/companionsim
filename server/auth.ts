import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { RowDataPacket } from "mysql2/promise";
import type { Actor, User } from "../shared/schema";
import { execute, query } from "./db";
import { platformConfig, type PlatformConfig } from "./platform-config";
import { verifyKey, type ApiKeyRecord } from "./keys";
import { findUserById, isAdminUser } from "./users";

/**
 * 身份解析与访问级别。
 *
 * HTTP 面只有一处鉴权入口 `requireAccess`；路由表为每个接口声明 access，
 * 漏声明的接口在测试里会被抓住（见 http.ts 的 ROUTES 与 auth.test.ts）。
 */

export type Principal =
  | { kind: "session"; user: User; tokenHash: string }
  | { kind: "superadmin"; username: string; tokenHash: string }
  | { kind: "apiKey"; user: User; key: ApiKeyRecord };

/**
 * public  任何人（健康检查、登录入口、被测端点）
 * read    登录即可
 * artifact 提交人群/剧本（agent key 需要 author）
 * run     发起探索/回归（agent key 需要 run）
 * decide  人工判定与回归查看；**只允许人**，key 不行
 * admin   被测 / 评审 LLM / 仿真 agent 配置、配额、用户管理；只允许 admin
 */
export type Access = "public" | "read" | "artifact" | "run" | "decide" | "admin";

export function actorOf(principal: Principal): Actor {
  if (principal.kind === "session") {
    return { kind: "user", userId: principal.user.id, name: principal.user.name };
  }
  if (principal.kind === "superadmin") {
    return { kind: "superadmin", name: `超级管理员（${principal.username}）` };
  }
  const actor: Actor = {
    kind: "apiKey",
    userId: principal.key.ownerUserId,
    name: principal.key.ownerName,
    keyId: principal.key.id,
    keyName: principal.key.name,
  };
  return actor;
}

export function isAdminPrincipal(principal: Principal | undefined): boolean {
  if (!principal) return false;
  if (principal.kind === "superadmin") return true;
  if (principal.kind === "apiKey") return false;
  return isAdminUser(principal.user);
}

export function accessAllowed(
  access: Access,
  principal: Principal | undefined,
  _config: PlatformConfig,
): boolean {
  if (access === "public") return true;
  if (!principal) return false;
  if (principal.kind === "apiKey") {
    const scopes = principal.key.scopes;
    if (access === "read") return true;
    if (access === "artifact") return scopes.includes("author");
    if (access === "run") return scopes.includes("run");
    // 判定与配置永远不由 key 代签
    return false;
  }
  if (access === "admin") return isAdminPrincipal(principal);
  return true;
}

/* ── 会话 ─────────────────────────────────────────────────────────── */

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export type SessionRecord = {
  token: string;
  tokenHash: string;
  kind: "feishu" | "superadmin" | "password";
  userId?: string;
  username?: string;
  expiresAt: Date;
};

export async function createSession(input: {
  kind: "feishu" | "superadmin" | "password";
  userId?: string;
  username?: string;
  ttlHours: number;
  ip?: string;
  ua?: string;
}): Promise<SessionRecord> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + input.ttlHours * 3_600_000);
  await execute(
    `INSERT INTO sessions
       (token_hash, user_id, kind, created_at, expires_at, last_seen_at, ip, ua)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      hashToken(token),
      input.userId ?? null,
      input.kind,
      now,
      expiresAt,
      now,
      input.ip ?? null,
      input.ua?.slice(0, 300) ?? null,
    ],
  );
  return {
    token,
    tokenHash: hashToken(token),
    kind: input.kind,
    userId: input.userId,
    username: input.username,
    expiresAt,
  };
}

export async function destroySession(token: string): Promise<void> {
  await execute("DELETE FROM sessions WHERE token_hash = ?", [hashToken(token)]);
}

export async function destroyUserSessions(userId: string): Promise<number> {
  const result = await execute("DELETE FROM sessions WHERE user_id = ?", [userId]);
  return result.affectedRows;
}

export async function purgeExpiredSessions(): Promise<number> {
  const result = await execute("DELETE FROM sessions WHERE expires_at <= ?", [
    new Date(),
  ]);
  return result.affectedRows;
}

type SessionRow = RowDataPacket & {
  token_hash: string;
  user_id: string | null;
  kind: "feishu" | "superadmin" | "password";
  expires_at: Date;
  last_seen_at: Date;
};

async function principalFromSession(
  token: string,
  config: PlatformConfig,
  ip: string | undefined,
): Promise<Principal | undefined> {
  const tokenHash = hashToken(token);
  const rows = await query<SessionRow>("SELECT * FROM sessions WHERE token_hash = ?", [
    tokenHash,
  ]);
  const row = rows[0];
  if (!row) return undefined;
  if (row.expires_at.getTime() <= Date.now()) {
    await execute("DELETE FROM sessions WHERE token_hash = ?", [tokenHash]);
    return undefined;
  }
  // 滑动续期：每 10 分钟最多回写一次，避免每个请求都写库。
  if (Date.now() - row.last_seen_at.getTime() > 600_000) {
    await execute("UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?", [
      new Date(),
      tokenHash,
    ]);
  }
  void ip;
  // 旧的 superadmin 会话没有 user 行，仍按配置里的用户名解析，避免旧 cookie 直接失败。
  if (row.kind === "superadmin") {
    return { kind: "superadmin", username: config.superadmin.username, tokenHash };
  }
  // password 与历史 feishu 会话都绑定 user_id，走同一套角色判断。
  const user = row.user_id ? await findUserById(row.user_id) : undefined;
  if (!user) return undefined;
  if (user.status === "disabled") return undefined;
  return { kind: "session", user, tokenHash };
}

/* ── Cookie ───────────────────────────────────────────────────────── */

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name === "") continue;
    try {
      out[name] = decodeURIComponent(value);
    } catch {
      out[name] = value;
    }
  }
  return out;
}

export function isSecureRequest(req: IncomingMessage): boolean {
  if (process.env.TRUST_PROXY === "1") {
    const proto = String(req.headers["x-forwarded-proto"] ?? "")
      .split(",")[0]
      .trim();
    if (proto) return proto === "https";
  }
  return Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

export function clientIp(req: IncomingMessage): string | undefined {
  if (process.env.TRUST_PROXY === "1") {
    const forwarded = String(req.headers["x-forwarded-for"] ?? "")
      .split(",")[0]
      .trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? undefined;
}

export function sessionCookie(
  config: PlatformConfig,
  value: string,
  secure: boolean,
  maxAgeSeconds: number,
): string {
  const parts = [
    `${config.session.cookieName}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

export function clearedSessionCookie(
  config: PlatformConfig,
  secure: boolean,
): string {
  return sessionCookie(config, "", secure, 0);
}

/* ── 解析请求身份 ─────────────────────────────────────────────────── */

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header === "string") {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  const apiKey = req.headers["x-api-key"];
  if (typeof apiKey === "string" && apiKey.trim() !== "") return apiKey.trim();
  return undefined;
}

/**
 * 旧的超级管理员会话没有 users 行。它建的 Key 需要一个身份载体，用这个占位；
 * 注意 apiKey 永远不是 admin，所以这不构成提权。
 */
export function superadminStandIn(name: string): User {
  return {
    id: "superadmin",
    name,
    role: "admin",
    status: "active",
    createdAt: new Date(0).toISOString(),
    loginCount: 0,
  };
}

export async function resolvePrincipal(
  req: IncomingMessage,
  config: PlatformConfig,
): Promise<Principal | undefined> {
  const credential = bearerToken(req);
  if (credential) {
    const key = await verifyKey(credential, clientIp(req));
    if (!key) return undefined;
    const user =
      key.ownerUserId === "superadmin"
        ? superadminStandIn(key.ownerName)
        : await findUserById(key.ownerUserId);
    if (!user) return undefined;
    if (user.status === "disabled") return undefined;
    return { kind: "apiKey", user, key };
  }
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[config.session.cookieName];
  if (!token) return undefined;
  return principalFromSession(token, config, clientIp(req));
}

export type AuthDecision =
  | { ok: true; principal?: Principal }
  | { ok: false; status: 401 | 403; error: string };

/** 路由表里每条接口的唯一鉴权入口。 */
export function decideAccess(
  access: Access,
  principal: Principal | undefined,
  config: PlatformConfig,
): AuthDecision {
  if (access === "public") return { ok: true, principal };
  if (!principal) {
    return { ok: false, status: 401, error: "请先登录" };
  }
  if (!accessAllowed(access, principal, config)) {
    if (principal.kind === "apiKey") {
      return {
        ok: false,
        status: 403,
        error:
          access === "decide"
            ? "Key 不能做人工判定（纳入回归 / 驳回 / 无法判定），请由人在界面上操作"
            : `Key 「${principal.key.name}」没有 ${access} 权限`,
      };
    }
    return { ok: false, status: 403, error: "只有超级管理员可以执行该操作" };
  }
  return { ok: true, principal };
}

export async function platformSettings(): Promise<PlatformConfig> {
  return platformConfig();
}
