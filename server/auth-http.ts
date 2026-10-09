import { configurationStatus } from "./config-center";
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  AdminOverviewResponse,
  ApiKeyView,
  AuditView,
  CreateKeyRequest,
  CreateKeyResponse,
  MeResponse,
  QuotaEstimateResponse,
  QuotaSettingsView,
  QuotaUsageView,
  Role,
  StartHuntRequest,
  UserAdminView,
} from "../shared/schema";
import {
  actorOf,
  clearedSessionCookie,
  clientIp,
  createSession,
  destroySession,
  destroyUserSessions,
  isAdminPrincipal,
  parseCookies,
  sessionCookie,
  type Principal,
} from "./auth";

import { appendAudit, recentAudit } from "./audit";
import { databaseHealth } from "./db";
import { hashPassword, verifyPassword } from "./password";
import {
  createKey,
  findKey,
  KEY_SCOPES,
  listKeys,
  revokeKey,
  type ApiKeyRecord,
  type KeyScope,
} from "./keys";
import type { PlatformConfig } from "./platform-config";
import {
  checkQuota,
  dayKey,
  estimateHuntTokens,
  estimateReplayTokens,
  quotaForUser,
  quotaSettings,
  saveQuotaSettings,
  setQuotaOverride,
  usageByDay,
} from "./quota";
import { loadPerson, loadScript, loadSnapshot } from "./runtime";
import {
  createPasswordUser,
  DuplicateUsernameError,
  findLoginAccount,
  listUsers,
  recordLogin,
  setUserRole,
  setUserStatus,
} from "./users";
import { isRecord } from "./validate";
import { parseJsonBody, send, sendFile } from "./http-util";

/**
 * 认证、Key、配额、用户管理这些新接口都在这里。
 * 每个处理函数只关心自己的业务；鉴权已由 http.ts 的路由表完成。
 */

export type RouteContext = {
  principal?: Principal;
  config: PlatformConfig;
  params: string[];
};

function keyView(record: ApiKeyRecord): ApiKeyView {
  return record;
}

function quotaView(usage: {
  day: string;
  limit: number;
  used: number;
  estimated: number;
  actual: number;
  runs: number;
  remaining: number;
}): QuotaUsageView {
  return usage;
}

/* ── 健康检查 ─────────────────────────────────────────────────────── */

export async function getHealth(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const database = await databaseHealth();
  send(res, database.ok ? 200 : 503, {
    ok: database.ok,
    configuration: configurationStatus(),
    // 只回状态，不回配置内容与凭据。
    database: { ok: database.ok, version: database.version, error: database.error },
    superadmin: { configured: Boolean(ctx.config.superadmin.passwordHash) },
  });
}

/* ── 我是谁 ───────────────────────────────────────────────────────── */

export async function getMe(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const principal = ctx.principal;
  if (!principal) {
    const body: MeResponse = {
      authenticated: false,
      can: { admin: false, decide: false },
    };
    send(res, 200, body);
    return;
  }
  const admin = isAdminPrincipal(principal);
  const user =
    principal.kind === "apiKey" || principal.kind === "session"
      ? principal.user
      : undefined;
  const body: MeResponse = {
    authenticated: true,
    can: { admin, decide: principal.kind !== "apiKey" },
  };
  if (user) {
    body.user = user;
    body.role = admin ? "admin" : user.role;
    body.source = principal.kind === "apiKey" ? "apiKey" : "password";
    body.quota = quotaView(await quotaForUser(user.id));
  } else if (principal.kind === "superadmin") {
    body.role = "admin";
    body.source = "superadmin";
    body.superadminUsername = principal.username;
    body.quota = quotaView(await quotaForUser("superadmin"));
  }
  send(res, 200, body);
}

/* ── Skill 包下载 ─────────────────────────────────────────────────── */

/**
 * 直接给一个 zip：非技术同事不必装 node、配 SSH、记命令行。
 * 内容是仓库里的两份 Skill 源码 + 一份中文安装说明。
 */
export async function downloadSkills(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const { buildZip, collectSkillEntries, SKILL_ZIP_NAME } = await import(
    "./skills-zip"
  );
  const { entries, missing } = collectSkillEntries();
  if (entries.length === 0) {
    send(res, 500, {
      error: `打不出 Skill 包：找不到 ${missing.join("、")}（源码在仓库 .cursor/skills/ 下）`,
    });
    return;
  }
  const zip = buildZip(entries);
  sendFile(res, 200, zip, {
    contentType: "application/zip",
    filename: SKILL_ZIP_NAME,
  });
}

function isSecure(req: IncomingMessage): boolean {
  if (process.env.TRUST_PROXY === "1") {
    const proto = String(req.headers["x-forwarded-proto"] ?? "")
      .split(",")[0]
      .trim();
    if (proto) return proto === "https";
  }
  return Boolean((req.socket as { encrypted?: boolean }).encrypted);
}

const USERNAME_PATTERN = /^[A-Za-z0-9._-]{3,32}$/;

/* ── 用户名密码登录 ───────────────────────────────────────────────── */

export async function login(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok || !isRecord(parsed.value)) {
    send(res, 400, { error: "登录请求必须是对象" });
    return;
  }
  const usernameRaw = parsed.value.username;
  const password = parsed.value.password;
  if (typeof usernameRaw !== "string" || typeof password !== "string") {
    send(res, 400, { error: "用户名和密码都要填" });
    return;
  }
  const username = usernameRaw.trim();
  if (username === "" || password === "") {
    send(res, 400, { error: "用户名和密码都要填" });
    return;
  }
  const ip = clientIp(req);
  if (!(await allowLoginAttempt(ip))) {
    send(res, 429, { error: "尝试过于频繁，请 5 分钟后再试" });
    return;
  }
  const account = await findLoginAccount(username);
  const passwordOk = Boolean(
    account?.passwordHash && (await verifyPassword(password, account.passwordHash)),
  );
  if (!account || !passwordOk) {
    noteLoginFailure(ip);
    send(res, 401, { error: "用户名或密码不正确" });
    return;
  }
  if (account.user.status === "disabled") {
    noteLoginFailure(ip);
    send(res, 403, { error: "该账号已被停用，请联系管理员" });
    return;
  }
  await recordLogin(account.user.id);
  const session = await createSession({
    kind: "password",
    userId: account.user.id,
    ttlHours: ctx.config.session.ttlHours,
    ip,
    ua: req.headers["user-agent"],
  });
  await appendAudit({
    actor: { kind: "user", userId: account.user.id, name: account.user.name },
    action: "auth.login",
    target: `user:${account.user.id}`,
    detail: { method: "password" },
    ip,
    ua: String(req.headers["user-agent"] ?? ""),
  });
  res.setHeader(
    "Set-Cookie",
    sessionCookie(
      ctx.config,
      session.token,
      isSecure(req),
      ctx.config.session.ttlHours * 3600,
    ),
  );
  send(res, 200, { ok: true });
}

/** 同 IP 5 分钟内最多 5 次失败。进程内存即可：单副本部署。 */
const attempts = new Map<string, { count: number; at: number }>();

async function allowLoginAttempt(ip: string | undefined): Promise<boolean> {
  const key = ip ?? "unknown";
  const now = Date.now();
  const found = attempts.get(key);
  if (!found || now - found.at > 300_000) {
    attempts.set(key, { count: 0, at: now });
    return true;
  }
  return found.count < 5;
}

export function noteLoginFailure(ip: string | undefined): void {
  const key = ip ?? "unknown";
  const now = Date.now();
  const found = attempts.get(key);
  if (!found || now - found.at > 300_000) {
    attempts.set(key, { count: 1, at: now });
    return;
  }
  found.count += 1;
}

export async function logout(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const token = parseCookies(req.headers.cookie)[ctx.config.session.cookieName];
  if (token) await destroySession(token);
  if (ctx.principal) {
    await appendAudit({
      actor: actorOf(ctx.principal),
      action: "auth.logout",
      target: "auth",
      ip: clientIp(req),
    });
  }
  res.setHeader("Set-Cookie", clearedSessionCookie(ctx.config, isSecure(req)));
  send(res, 200, { ok: true });
}

/* ── Key ─────────────────────────────────────────────────────────── */

function parseScopes(raw: unknown): KeyScope[] | undefined {
  if (raw === undefined) return [...KEY_SCOPES];
  if (!Array.isArray(raw)) return undefined;
  const out: KeyScope[] = [];
  for (const item of raw) {
    if (typeof item !== "string") return undefined;
    if (!(KEY_SCOPES as readonly string[]).includes(item)) return undefined;
    out.push(item as KeyScope);
  }
  return out.length > 0 ? out : undefined;
}

export async function listKeysRoute(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const principal = ctx.principal as Principal;
  const admin = isAdminPrincipal(principal);
  const ownerId =
    principal.kind === "superadmin"
      ? undefined
      : principal.kind === "apiKey"
        ? principal.key.ownerUserId
        : principal.user.id;
  const all = admin && !ownerId ? await listKeys() : await listKeys(ownerId);
  send(res, 200, { keys: all.map(keyView) });
}

export async function createKeyRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const principal = ctx.principal as Principal;
  if (principal.kind === "apiKey") {
    send(res, 403, { error: "请通过网页登录创建 Key，API Key 不能签发其他 Key" });
    return;
  }
  const parsed = await parseJsonBody(req);
  if (!parsed.ok || !isRecord(parsed.value)) {
    send(res, 400, { error: "创建 Key 的请求必须是对象" });
    return;
  }
  const body = parsed.value as CreateKeyRequest;
  if (typeof body.name !== "string" || body.name.trim() === "") {
    send(res, 400, { error: "给 Key 起个名字，方便日后区分" });
    return;
  }
  const scopes = parseScopes(body.scopes);
  if (!scopes) {
    send(res, 400, { error: `scopes 只能是 ${KEY_SCOPES.join(" / ")}` });
    return;
  }
  const owner =
    principal.kind === "superadmin"
      ? { id: "superadmin", name: `超级管理员（${principal.username}）` }
      : { id: principal.user.id, name: principal.user.name };
  const actor = actorOf(principal);
  const created = await createKey({
    name: body.name,
    ownerUserId: owner.id,
    ownerName: owner.name,
    scopes,
    expiresInDays:
      typeof body.expiresInDays === "number" && body.expiresInDays > 0
        ? body.expiresInDays
        : undefined,
    actor,
  });
  await appendAudit({
    actor,
    action: "key.create",
    target: `key:${created.record.id}`,
    detail: { name: created.record.name, scopes: created.record.scopes },
    ip: clientIp(req),
  });
  const body2: CreateKeyResponse = { key: keyView(created.record), plain: created.plain };
  send(res, 201, body2);
}

export async function revokeKeyRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const principal = ctx.principal as Principal;
  const id = ctx.params[0];
  const existing = await findKey(id);
  if (!existing) {
    send(res, 404, { error: "未找到该 Key" });
    return;
  }
  const admin = isAdminPrincipal(principal);
  const owns =
    principal.kind !== "superadmin" &&
    (principal.kind === "apiKey"
      ? principal.key.ownerUserId
      : principal.user.id) === existing.ownerUserId;
  if (!admin && !owns) {
    send(res, 403, { error: "只能吊销自己的 Key" });
    return;
  }
  const actor = actorOf(principal);
  const revoked = await revokeKey(id, actor);
  await appendAudit({
    actor,
    action: "key.revoke",
    target: `key:${id}`,
    detail: { name: existing.name, owner: existing.ownerName },
    ip: clientIp(req),
  });
  send(res, 200, { key: revoked ? keyView(revoked) : undefined });
}

/* ── 配额 ────────────────────────────────────────────────────────── */

export async function getQuota(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const principal = ctx.principal as Principal;
  const subject =
    principal.kind === "superadmin"
      ? "superadmin"
      : principal.kind === "apiKey"
        ? principal.key.ownerUserId
        : principal.user.id;
  const usage = await quotaForUser(subject);
  if (!isAdminPrincipal(principal)) {
    send(res, 200, { usage: quotaView(usage) });
    return;
  }
  const settings = await quotaSettings();
  const today = dayKey(settings);
  const rows = await usageByDay(today);
  const users = await listUsers();
  const nameOf = new Map(users.map((user) => [user.id, user.name]));
  const view: QuotaSettingsView = {
    settings: {
      dailyTokensPerUser: settings.dailyTokensPerUser,
      dayTimezone: settings.dayTimezone,
      estimate: { ...settings.estimate },
    },
    today,
    users: rows.map((row) => ({
      userId: row.userId,
      name: nameOf.get(row.userId) ?? row.userId,
      estimated: row.estimated,
      actual: row.actual,
      runs: row.runs,
    })),
  };
  send(res, 200, { usage: quotaView(usage), quota: view });
}

export async function estimateQuota(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok || !isRecord(parsed.value)) {
    send(res, 400, { error: "预估请求必须是对象" });
    return;
  }
  const body = parsed.value;
  const settings = await quotaSettings();
  let estimate: number;
  if (body.mode === "replay") {
    if (typeof body.snapshotId !== "string" || body.snapshotId.trim() === "") {
      send(res, 400, { error: "回归预估要带 snapshotId" });
      return;
    }
    const snapshot = await loadSnapshot(body.snapshotId.trim());
    if (!snapshot.ok) {
      send(res, snapshot.status, { error: snapshot.error, errors: snapshot.errors });
      return;
    }
    const script = snapshot.value.scriptSnapshot
      ? { ok: true as const, value: snapshot.value.scriptSnapshot }
      : await loadScript(snapshot.value.scriptId, snapshot.value.scriptVersion);
    if (!script.ok) {
      send(res, script.status, { error: script.error, errors: script.errors });
      return;
    }
    estimate = estimateReplayTokens(script.value, settings);
  } else {
    const hunt = body as unknown as StartHuntRequest;
    if (
      typeof hunt.scriptId !== "string" ||
      typeof hunt.scriptVersion !== "string" ||
      typeof hunt.personId !== "string" ||
      typeof hunt.personVersion !== "string" ||
      hunt.scriptId.trim() === "" ||
      hunt.scriptVersion.trim() === "" ||
      hunt.personId.trim() === "" ||
      hunt.personVersion.trim() === ""
    ) {
      send(res, 400, {
        error: "探索预估要带人群与剧本的 id 和 version（和 POST /api/runs 的字段一样）",
      });
      return;
    }
    const script = await loadScript(hunt.scriptId, hunt.scriptVersion);
    if (!script.ok) {
      send(res, script.status, { error: script.error, errors: script.errors });
      return;
    }
    const person = await loadPerson(hunt.personId, hunt.personVersion);
    if (!person.ok) {
      send(res, person.status, { error: person.error, errors: person.errors });
      return;
    }
    const { getUserGeneratorConfig } = await import("./fake-user-config");
    const generator = await getUserGeneratorConfig();
    estimate = estimateHuntTokens(
      script.value,
      generator.settings?.priorTurnsLimit ?? 0,
      settings,
    );
  }
  const principal = ctx.principal as Principal;
  const subject =
    principal.kind === "superadmin"
      ? "superadmin"
      : principal.kind === "apiKey"
        ? principal.key.ownerUserId
        : principal.user.id;
  const decision = await checkQuota(subject, estimate);
  const body2: QuotaEstimateResponse = {
    estimatedTokens: estimate,
    usage: quotaView(decision.usage),
    allowed: decision.ok,
    ...(decision.ok ? {} : { error: decision.error }),
  };
  send(res, 200, body2);
}

export async function putQuotaSettings(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok || !isRecord(parsed.value)) {
    send(res, 400, { error: "配额配置必须是对象" });
    return;
  }
  const actor = actorOf(ctx.principal as Principal);
  const before = await quotaSettings();
  const after = await saveQuotaSettings(parsed.value);
  await appendAudit({
    actor,
    action: "config.update",
    target: "config:quota",
    detail: { before: before, after: after },
    ip: clientIp(req),
  });
  send(res, 200, { ok: true, settings: after });
}

export async function putQuotaOverride(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok || !isRecord(parsed.value)) {
    send(res, 400, { error: "提额请求必须是对象" });
    return;
  }
  const userId = ctx.params[0];
  const raw = parsed.value.dailyTokens;
  const dailyTokens =
    raw === null || raw === undefined || raw === ""
      ? null
      : typeof raw === "number" && Number.isFinite(raw) && raw >= 0
        ? Math.round(raw)
        : undefined;
  if (dailyTokens === undefined) {
    send(res, 400, { error: "dailyTokens 必须是非负数字，或 null 表示恢复默认" });
    return;
  }
  const actor = actorOf(ctx.principal as Principal);
  await setQuotaOverride(userId, dailyTokens, actor.name);
  await appendAudit({
    actor,
    action: "quota.adjust",
    target: `quota:${userId}`,
    detail: { dailyTokens },
    ip: clientIp(req),
  });
  send(res, 200, { ok: true });
}

/* ── 管理页 ──────────────────────────────────────────────────────── */

export async function createUser(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok || !isRecord(parsed.value)) {
    send(res, 400, { error: "创建账号的请求必须是对象" });
    return;
  }
  const usernameRaw = parsed.value.username;
  const password = parsed.value.password;
  const nameRaw = parsed.value.name;
  const roleRaw = parsed.value.role;
  if (typeof usernameRaw !== "string" || typeof password !== "string" || typeof nameRaw !== "string") {
    send(res, 400, { error: "创建账号需要用户名、密码和显示名" });
    return;
  }
  const username = usernameRaw.trim();
  const name = nameRaw.trim();
  if (!USERNAME_PATTERN.test(username)) {
    send(res, 400, {
      error: "用户名须为 3–32 位，只能包含字母、数字、点、下划线与连字符",
    });
    return;
  }
  if (password.length < 8) {
    send(res, 400, { error: "密码至少 8 位" });
    return;
  }
  if (name === "" || name.length > 120) {
    send(res, 400, { error: "显示名不能为空，且最长 120 个字符" });
    return;
  }
  if (roleRaw !== undefined && roleRaw !== "admin" && roleRaw !== "member") {
    send(res, 400, { error: "role 只能是 admin 或 member" });
    return;
  }
  const role: Role = roleRaw === "admin" ? "admin" : "member";
  const actor = actorOf(ctx.principal as Principal);
  let user;
  try {
    user = await createPasswordUser({
      username,
      passwordHash: hashPassword(password),
      name,
      role,
    });
  } catch (err) {
    if (err instanceof DuplicateUsernameError) {
      send(res, 409, { error: "该用户名已存在" });
      return;
    }
    throw err;
  }
  await appendAudit({
    actor,
    action: "user.create",
    target: `user:${user.id}`,
    detail: { username: user.username, name: user.name, role: user.role },
    ip: clientIp(req),
  });
  send(res, 201, { user });
}

/* ── 管理页续 ────────────────────────────────────────────────────── */

export async function getAdminOverview(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const [users, keys, audit, database] = await Promise.all([
    listUsers(),
    listKeys(),
    recentAudit(100),
    databaseHealth(),
  ]);
  const settings = await quotaSettings();
  const today = dayKey(settings);
  const rows = await usageByDay(today);
  const usageOf = new Map(rows.map((row) => [row.userId, row]));
  const withUsage: UserAdminView[] = [];
  for (const user of users) {
    const row = usageOf.get(user.id);
    const usage = await quotaForUser(user.id);
    withUsage.push({ ...user, todayUsage: quotaView(usage) });
    void row;
  }
  const auditView: AuditView[] = audit.map((item) => ({
    id: item.id,
    at: item.at,
    actor: item.actor,
    action: item.action,
    target: item.target,
    ...(item.detail === undefined ? {} : { detail: item.detail }),
    ...(item.ip ? { ip: item.ip } : {}),
  }));
  const body: AdminOverviewResponse = {
    configuration: configurationStatus(),
    users: withUsage,
    keys: keys.map(keyView),
    audit: auditView,
    superadmin: {
      username: ctx.config.superadmin.username,
      passwordConfigured: Boolean(ctx.config.superadmin.passwordHash),
    },
    database: { ok: database.ok, version: database.version, error: database.error },
  };
  send(res, 200, body);
}

export async function patchUser(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok || !isRecord(parsed.value)) {
    send(res, 400, { error: "更新用户必须是对象" });
    return;
  }
  const id = ctx.params[0];
  const actor = actorOf(ctx.principal as Principal);
  const body = parsed.value;
  if (body.role !== undefined) {
    if (body.role !== "admin" && body.role !== "member") {
      send(res, 400, { error: "role 只能是 admin 或 member" });
      return;
    }
    const updated = await setUserRole(id, body.role as Role);
    if (!updated) {
      send(res, 404, { error: "未找到该用户" });
      return;
    }
    await appendAudit({
      actor,
      action: "user.role",
      target: `user:${id}`,
      detail: { role: body.role, name: updated.name },
      ip: clientIp(req),
    });
  }
  if (body.status !== undefined) {
    if (body.status !== "active" && body.status !== "disabled") {
      send(res, 400, { error: "status 只能是 active 或 disabled" });
      return;
    }
    const updated = await setUserStatus(id, body.status);
    if (!updated) {
      send(res, 404, { error: "未找到该用户" });
      return;
    }
    if (body.status === "disabled") await destroyUserSessions(id);
    await appendAudit({
      actor,
      action: "user.status",
      target: `user:${id}`,
      detail: { status: body.status, name: updated.name },
      ip: clientIp(req),
    });
  }
  const users = await listUsers();
  const found = users.find((user) => user.id === id);
  if (!found) {
    send(res, 404, { error: "未找到该用户" });
    return;
  }
  send(res, 200, { user: found });
}

export async function kickUser(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const id = ctx.params[0];
  const actor = actorOf(ctx.principal as Principal);
  const count = await destroyUserSessions(id);
  await appendAudit({
    actor,
    action: "user.status",
    target: `user:${id}`,
    detail: { kickedSessions: count },
    ip: clientIp(_req),
  });
  send(res, 200, { ok: true, kickedSessions: count });
}
