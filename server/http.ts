import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CatalogResponse,
  CreateSutRequest,
  DecideRequest,
  JudgeSettings,
  PersonView,
  RejudgeRequest,
  ScriptView,
  Snapshot,
  StartHuntRequest,
  StartReplayRequest,
  SubmitRequest,
  UserGeneratorSettings,
} from "../shared/schema";
import { dataRoot, personFile, relFromData, scriptFile } from "./paths";
import { recoverOrphanedRuns } from "./jobs";
import { ensurePlatformReady } from "./bootstrap";
import {
  collectPeopleBrief,
  collectScriptIds,
  decideRun,
  getRun,
  listRuns,
  scriptSpan,
  startHunt,
  startReplay,
  retryJudgeRun,
  markReplayReviewed,
  type ApiFail,
} from "./runtime";
import { encodeOpenAiChatSse, lastUserFromChatBody, mockSutReply } from "./mock-sut";
import { listJsonFiles, readJson, readJsonIfExists, writeJson } from "./store";
import { listSuts, registerSseSut, updateSseSut } from "./sut";
import { getJudgeConfig, saveJudgeConfig } from "./judge-config";
import { getUserGeneratorConfig, saveUserGeneratorConfig } from "./fake-user-config";
import {
  isRecord,
  parsePerson,
  parseScript,
  parseSnapshotFile,
  snapshotSubmitErrors,
} from "./validate";
import {
  actorOf,
  clientIp,
  decideAccess,
  resolvePrincipal,
  type Access,
  type Principal,
} from "./auth";
import { appendAudit, latestActorsByTarget } from "./audit";
import { platformConfig, type PlatformConfig } from "./platform-config";
import * as authHttp from "./auth-http";
import {
  parseJsonBody,
  pathnameOf,
  send,
  sendFail,
} from "./http-util";

/**
 * 唯一 HTTP 面。
 *
 * 路由在 ROUTES 里声明：**先匹配，后鉴权**。派发只认这张表，
 * 所以「新接口忘了挂鉴权」这种事故在这里不可能发生——忘声明就是 404，
 * 而不是裸奔。测试会遍历这张表断言未登录一律 401、member 打 admin 一律 403。
 */

export type RouteContext = {
  principal?: Principal;
  config: PlatformConfig;
  params: string[];
};

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
) => Promise<void>;

type Route = {
  method: string;
  pattern: RegExp;
  access: Access;
  handler: Handler;
};

/** 传给 handle 的注入点：测试直接给身份，生产不传（走真实解析）。 */
export type HandleContext = {
  principal?: Principal;
  config?: PlatformConfig;
};

/* ── 既有接口的处理函数 ─────────────────────────────────────────── */

async function mockSutChat(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok) {
    send(res, 400, { error: parsed.error });
    return;
  }
  if (!isRecord(parsed.value)) {
    send(res, 400, { error: "请求体必须是对象" });
    return;
  }
  const bytes = encodeOpenAiChatSse(
    mockSutReply(lastUserFromChatBody(parsed.value)),
  );
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(Buffer.from(bytes));
}

async function catalog(): Promise<CatalogResponse> {
  const issues: CatalogResponse["issues"] = [];
  const scriptIds = await collectScriptIds();
  const peopleBrief = await collectPeopleBrief();

  const people: PersonView[] = [];
  for (const file of await listJsonFiles("people")) {
    try {
      const raw = await readJson(file.absPath);
      const parsed = parsePerson(raw, {
        scriptIds,
        otherPeople: peopleBrief,
        fileStem: file.stem,
      });
      if (!parsed.ok) {
        issues.push({ path: file.relPath, errors: parsed.errors });
        continue;
      }
      people.push(parsed.value);
    } catch (err) {
      issues.push({
        path: file.relPath,
        errors: [err instanceof SyntaxError ? "无法解析 JSON" : "读取人群失败"],
      });
    }
  }

  const scripts: ScriptView[] = [];
  for (const file of await listJsonFiles("scripts")) {
    try {
      const raw = await readJson(file.absPath);
      const parsed = parseScript(raw, { fileStem: file.stem });
      if (!parsed.ok) {
        issues.push({ path: file.relPath, errors: parsed.errors });
        continue;
      }
      scripts.push({ ...parsed.value, span: scriptSpan(parsed.value) });
    } catch {
      issues.push({ path: file.relPath, errors: ["无法解析 JSON"] });
    }
  }

  const snapshots: Snapshot[] = [];
  for (const file of await listJsonFiles("snapshots")) {
    try {
      const raw = await readJson(file.absPath);
      const parsed = parseSnapshotFile(raw, file.stem);
      if (!parsed.ok) {
        issues.push({ path: file.relPath, errors: parsed.errors });
        continue;
      }
      snapshots.push(parsed.value);
    } catch {
      issues.push({ path: file.relPath, errors: ["无法解析 JSON"] });
    }
  }

  const suts: CatalogResponse["suts"] = [];
  try {
    suts.push(...(await listSuts()));
  } catch (err) {
    issues.push({
      path: "config/suts.json",
      errors: [err instanceof Error ? err.message : "读取被测配置失败"],
    });
  }

  // 操作人旁路附加：产物文件本身不改一个字段，「谁添加的」来自审计流。
  try {
    const targets = [
      ...people.map((person) => `person:${person.id}@${person.version}`),
      ...scripts.map((script) => `script:${script.id}@${script.version}`),
    ];
    const actors = await latestActorsByTarget(targets);
    for (const person of people) {
      const found = actors.get(`person:${person.id}@${person.version}`);
      if (found) {
        person.createdBy = found.actor;
        person.createdAt = found.at;
      }
    }
    for (const script of scripts) {
      const found = actors.get(`script:${script.id}@${script.version}`);
      if (found) {
        script.createdBy = found.actor;
        script.createdAt = found.at;
      }
    }
  } catch (err) {
    // 审计读不到不该让目录挂掉，但要如实说明。
    issues.push({
      path: "audit_log",
      errors: [
        `读取操作人失败：${err instanceof Error ? err.message : "数据库不可用"}`,
      ],
    });
  }

  return {
    people,
    scripts,
    snapshots,
    suts,
    issues,
    judge: await getJudgeConfig(),
    userGenerator: await getUserGeneratorConfig(),
  };
}

async function submitArtifact(
  body: unknown,
  principal: Principal | undefined,
  ip: string | undefined,
): Promise<{ status: number; body: unknown }> {
  if (!isRecord(body)) return { status: 400, body: { error: "提交体必须是对象" } };
  const kind = body.kind;
  const payload = body.payload;
  if (typeof kind !== "string") {
    return { status: 400, body: { error: "kind 必须是 person 或 script" } };
  }
  const snapErrors = snapshotSubmitErrors(kind, payload);
  if (kind !== "person" && kind !== "script") {
    return {
      status: 400,
      body: {
        error: "kind 必须是 person 或 script",
        errors: snapErrors.length > 0 ? snapErrors : undefined,
      },
    };
  }
  if (snapErrors.length > 0) {
    return {
      status: 400,
      body: { error: "编排 Agent 不准手写快照", errors: snapErrors },
    };
  }

  const req = body as SubmitRequest;
  const actor = principal ? actorOf(principal) : undefined;
  if (req.kind === "person") {
    const scriptIds = await collectScriptIds();
    const parsed = parsePerson(req.payload, {
      scriptIds,
      otherPeople: await collectPeopleBrief(),
      existingAtPath:
        isRecord(req.payload) &&
        typeof req.payload.id === "string" &&
        typeof req.payload.version === "string"
          ? await readJsonIfExists(personFile(req.payload.id, req.payload.version))
          : undefined,
      fileStem:
        isRecord(req.payload) &&
        typeof req.payload.id === "string" &&
        typeof req.payload.version === "string"
          ? `${req.payload.id}@${req.payload.version}`
          : undefined,
    });
    if (!parsed.ok)
      return { status: 400, body: { error: "人群校验失败", errors: parsed.errors } };
    const abs = personFile(parsed.value.id, parsed.value.version);
    const existing = await readJsonIfExists(abs);
    if (existing === undefined) {
      await writeJson(abs, parsed.value);
      if (actor) {
        await appendAudit({
          actor,
          action: "artifact.submit",
          target: `person:${parsed.value.id}@${parsed.value.version}`,
          detail: { name: parsed.value.name },
          ip,
        });
      }
    }
    return { status: 200, body: { ok: true, path: relFromData(abs) } };
  }

  const parsed = parseScript(req.payload, {
    existingAtPath:
      isRecord(req.payload) &&
      typeof req.payload.id === "string" &&
      typeof req.payload.version === "string"
        ? await readJsonIfExists(scriptFile(req.payload.id, req.payload.version))
        : undefined,
    fileStem:
      isRecord(req.payload) &&
      typeof req.payload.id === "string" &&
      typeof req.payload.version === "string"
        ? `${req.payload.id}@${req.payload.version}`
        : undefined,
  });
  if (!parsed.ok)
    return { status: 400, body: { error: "剧本校验失败", errors: parsed.errors } };
  const abs = scriptFile(parsed.value.id, parsed.value.version);
  const existingScript = await readJsonIfExists(abs);
  if (existingScript === undefined) {
    await writeJson(abs, parsed.value);
    if (actor) {
      await appendAudit({
        actor,
        action: "artifact.submit",
        target: `script:${parsed.value.id}@${parsed.value.version}`,
        detail: { name: parsed.value.name, family: parsed.value.family },
        ip,
      });
    }
  }
  return { status: 200, body: { ok: true, path: relFromData(abs) } };
}

async function postRuns(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok) {
    send(res, 400, { error: parsed.error });
    return;
  }
  if (!isRecord(parsed.value) || typeof parsed.value.mode !== "string") {
    send(res, 400, { error: "跑法必须是 hunt 或 replay" });
    return;
  }
  const actor = ctx.principal ? actorOf(ctx.principal) : undefined;
  if (parsed.value.mode === "hunt") {
    const result = await startHunt(parsed.value as StartHuntRequest, { actor });
    if (!result.ok) {
      sendFail(res, result);
      return;
    }
    await logRunStart(actor, result.value.id, "hunt", ctx, req);
    send(res, 201, result.value);
    return;
  }
  if (parsed.value.mode === "replay") {
    const result = await startReplay(parsed.value as StartReplayRequest, { actor });
    if (!result.ok) {
      sendFail(res, result);
      return;
    }
    await logRunStart(actor, result.value.id, "replay", ctx, req);
    send(res, 201, result.value);
    return;
  }
  send(res, 400, { error: "跑法必须是 hunt 或 replay" });
}

async function logRunStart(
  actor: ReturnType<typeof actorOf> | undefined,
  runId: string,
  mode: string,
  _ctx: RouteContext,
  req: IncomingMessage,
): Promise<void> {
  if (!actor) return;
  try {
    await appendAudit({
      actor,
      action: "run.start",
      target: `run:${runId}`,
      detail: { mode },
      ip: clientIp(req),
    });
  } catch (err) {
    console.warn(
      `[audit] 记录开局失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function postDecide(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  principal: Principal | undefined,
): Promise<void> {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok) {
    send(res, 400, { error: parsed.error });
    return;
  }
  if (!isRecord(parsed.value) || typeof parsed.value.status !== "string") {
    send(res, 400, { error: "判定必须带 status" });
    return;
  }
  const body = parsed.value as DecideRequest;
  if (
    (body.reason !== undefined && typeof body.reason !== "string") ||
    (body.evidenceTurnIds !== undefined &&
      (!Array.isArray(body.evidenceTurnIds) ||
        body.evidenceTurnIds.some((v) => typeof v !== "string"))) ||
    (body.evaluationAttemptId !== undefined &&
      typeof body.evaluationAttemptId !== "string")
  ) {
    send(res, 400, { error: "判定说明和证据格式不正确" });
    return;
  }
  const actor = principal ? actorOf(principal) : undefined;
  const result = await decideRun(
    id,
    body.status,
    body.reason,
    body.evidenceTurnIds,
    body.evaluationAttemptId,
    actor,
  );
  if (!result.ok) {
    sendFail(res, result);
    return;
  }
  if (actor) {
    await appendAudit({
      actor,
      action: "run.decide",
      target: `run:${id}`,
      detail: { status: body.status },
      ip: clientIp(req),
    });
  }
  send(res, 200, result.value);
}

async function getCatalog(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  send(res, 200, await catalog());
}

async function getRunsRoute(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  send(res, 200, await listRuns());
}

async function getMeta(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // 界面的编排交接文本需要绝对路径；不能在源码里写死某一台机器的路径。
  send(res, 200, { repoRoot: dataRoot() });
}

async function getOneRun(
  _req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const run = await getRun(ctx.params[0]);
  if (!run) {
    send(res, 404, { error: "未找到该局" });
    return;
  }
  send(res, 200, run);
}

async function getJudge(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  send(res, 200, await getJudgeConfig());
}

async function putJudge(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok || !isRecord(parsed.value)) {
    send(res, 400, { error: "评审配置必须为对象" });
    return;
  }
  const result = await saveJudgeConfig(parsed.value as JudgeSettings);
  if (!result.ok) {
    sendFail(res, result);
    return;
  }
  await auditConfig(ctx, req, "config:judge", { after: result.value.settings });
  send(res, 200, result.value);
}

async function getSimAgent(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  send(res, 200, await getUserGeneratorConfig());
}

async function putSimAgent(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok || !isRecord(parsed.value)) {
    send(res, 400, { error: "仿真 agent 配置必须为对象" });
    return;
  }
  const result = await saveUserGeneratorConfig(
    parsed.value as UserGeneratorSettings,
  );
  if (!result.ok) {
    sendFail(res, result);
    return;
  }
  await auditConfig(ctx, req, "config:sim-agent", { after: result.value.settings });
  send(res, 200, result.value);
}

async function auditConfig(
  ctx: RouteContext,
  req: IncomingMessage,
  target: string,
  detail: unknown,
): Promise<void> {
  if (!ctx.principal) return;
  try {
    await appendAudit({
      actor: actorOf(ctx.principal),
      action: "config.update",
      target,
      detail,
      ip: clientIp(req),
    });
  } catch (err) {
    console.warn(
      `[audit] 记录配置变更失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function rejudgeRun(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok || !isRecord(parsed.value)) {
    send(res, 400, { error: "评审请求必须为对象" });
    return;
  }
  const actor = ctx.principal ? actorOf(ctx.principal) : undefined;
  const result = await retryJudgeRun(
    ctx.params[0],
    parsed.value as RejudgeRequest,
    actor,
  );
  if (!result.ok) {
    sendFail(res, result);
    return;
  }
  if (actor) {
    await appendAudit({
      actor,
      action: "run.rejudge",
      target: `run:${ctx.params[0]}`,
      ip: clientIp(req),
    });
  }
  send(res, 202, result.value);
}

async function reviewReplay(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok || !isRecord(parsed.value) || typeof parsed.value.note !== "string") {
    send(res, 400, { error: "回归查看说明必须为文字" });
    return;
  }
  const actor = ctx.principal ? actorOf(ctx.principal) : undefined;
  const result = await markReplayReviewed(ctx.params[0], parsed.value.note, actor);
  if (!result.ok) {
    sendFail(res, result);
    return;
  }
  if (actor) {
    await appendAudit({
      actor,
      action: "run.review",
      target: `run:${ctx.params[0]}`,
      ip: clientIp(req),
    });
  }
  send(res, 200, result.value);
}

async function postArtifacts(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok) {
    send(res, 400, { error: parsed.error });
    return;
  }
  const result = await submitArtifact(
    parsed.value,
    ctx.principal,
    clientIp(req),
  );
  send(res, result.status, result.body);
}

async function createSut(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok) {
    send(res, 400, { error: parsed.error });
    return;
  }
  if (!isRecord(parsed.value)) {
    send(res, 400, { error: "登记体必须是对象" });
    return;
  }
  const result = await registerSseSut(parsed.value as CreateSutRequest);
  if (!result.ok) {
    sendFail(res, result);
    return;
  }
  await auditConfig(ctx, req, `config:sut:${result.value.id}`, {
    created: true,
    name: result.value.name,
  });
  send(res, 201, result.value);
}

async function updateSutRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  const parsed = await parseJsonBody(req);
  if (!parsed.ok || !isRecord(parsed.value)) {
    send(res, 400, { error: "被测配置必须为对象" });
    return;
  }
  const result = await updateSseSut(
    ctx.params[0],
    parsed.value as CreateSutRequest,
  );
  if (!result.ok) {
    sendFail(res, result);
    return;
  }
  await auditConfig(ctx, req, `config:sut:${ctx.params[0]}`, {
    updated: true,
    name: result.value.name,
  });
  send(res, 200, result.value);
}

async function getMeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
): Promise<void> {
  await authHttp.getMe(req, res, ctx);
}

function route(
  method: string,
  pattern: RegExp,
  access: Access,
  handler: Handler,
): Route {
  return { method, pattern, access, handler };
}

/**
 * 全部接口。写接口一律显式声明 access；`public` 只有健康检查、
 * 登录入口与被测端点（/api/mock-sut/chat 是被测方向我们发请求的地址）。
 */
export const ROUTES: Route[] = [
  route("GET", /^\/api\/health$/, "public", authHttp.getHealth),
  route("POST", /^\/api\/mock-sut\/chat$/, "public", (req, res) => mockSutChat(req, res)),
  route("GET", /^\/api\/auth\/me$/, "public", getMeRoute),
  route("POST", /^\/api\/auth\/login$/, "public", authHttp.login),
  route("POST", /^\/api\/auth\/admin\/login$/, "public", authHttp.login),
  route("POST", /^\/api\/auth\/logout$/, "read", authHttp.logout),

  route("GET", /^\/api\/meta$/, "read", getMeta),
  route("GET", /^\/api\/catalog$/, "read", getCatalog),
  route("GET", /^\/api\/runs$/, "read", getRunsRoute),
  route("GET", /^\/api\/runs\/([^/]+)$/, "read", getOneRun),
  route("GET", /^\/api\/judge$/, "read", getJudge),
  route("GET", /^\/api\/fake-user$/, "read", getSimAgent),
  route("GET", /^\/api\/keys$/, "read", authHttp.listKeysRoute),
  route("GET", /^\/api\/skills\.zip$/, "read", authHttp.downloadSkills),
  route("GET", /^\/api\/quota$/, "read", authHttp.getQuota),
  route("POST", /^\/api\/quota\/estimate$/, "read", authHttp.estimateQuota),

  route("POST", /^\/api\/keys$/, "read", authHttp.createKeyRoute),
  route("DELETE", /^\/api\/keys\/([^/]+)$/, "read", authHttp.revokeKeyRoute),
  route("POST", /^\/api\/runs$/, "run", postRuns),
  route("POST", /^\/api\/artifacts$/, "artifact", postArtifacts),

  route("POST", /^\/api\/runs\/([^/]+)\/decide$/, "decide", (req, res, ctx) =>
    postDecide(req, res, ctx.params[0], ctx.principal),
  ),
  route("POST", /^\/api\/runs\/([^/]+)\/review$/, "decide", reviewReplay),
  route("POST", /^\/api\/runs\/([^/]+)\/judge$/, "run", rejudgeRun),

  route("PUT", /^\/api\/judge$/, "admin", putJudge),
  route("PUT", /^\/api\/fake-user$/, "admin", putSimAgent),
  route("POST", /^\/api\/suts$/, "admin", createSut),
  route("PUT", /^\/api\/suts\/([^/]+)$/, "admin", updateSutRoute),
  route("PUT", /^\/api\/quota$/, "admin", authHttp.putQuotaSettings),
  route("PUT", /^\/api\/quota\/overrides\/([^/]+)$/, "admin", authHttp.putQuotaOverride),
  route("GET", /^\/api\/admin\/overview$/, "admin", authHttp.getAdminOverview),
  route("POST", /^\/api\/admin\/users$/, "admin", authHttp.createUser),
  route("PATCH", /^\/api\/users\/([^/]+)$/, "admin", authHttp.patchUser),
  route("POST", /^\/api\/users\/([^/]+)\/logout$/, "admin", authHttp.kickUser),
];

/**
 * 只处理 /api。未命中前缀的请求由 Vite 插件拦在外面，不要在这里 next。
 *
 * `ctx.principal` 是测试注入点：给了就用它，不给就按 Cookie / Key 解析。
 */
export async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandleContext = {},
): Promise<void> {
  const path = pathnameOf(req);
  const method = req.method ?? "GET";

  try {
    await ensurePlatformReady();
    await recoverOrphanedRuns();
  } catch (err) {
    send(res, 500, {
      error: err instanceof Error ? err.message : "平台启动准备失败",
    });
    return;
  }

  const matched = matchRoute(method, path);
  if (!matched) {
    send(
      res,
      404,
      path.startsWith("/api") ? { error: "未找到该接口" } : { error: "未命中 /api" },
    );
    return;
  }

  let config: PlatformConfig;
  try {
    config = ctx.config ?? (await platformConfig());
  } catch (err) {
    const message = err instanceof Error ? err.message : "平台配置读取失败";
    const health = matched.route.pattern.source.includes("health");
    send(res, health ? 503 : 500, { error: message });
    return;
  }

  let principal = ctx.principal;
  if (!principal) {
    try {
      principal = await resolvePrincipal(req, config);
    } catch (err) {
      // 公开接口（登录页要读 /api/auth/me）不该因为解析失败而打不开。
      if (matched.route.access !== "public") {
        send(res, 500, {
          error: err instanceof Error ? err.message : "身份解析失败",
        });
        return;
      }
    }
  }

  const decision = decideAccess(matched.route.access, principal, config);
  if (!decision.ok) {
    send(res, decision.status, { error: decision.error });
    return;
  }

  try {
    await matched.route.handler(req, res, {
      principal: decision.principal,
      config,
      params: matched.params,
    });
  } catch (err) {
    if (res.headersSent || res.writableEnded) return;
    const message = err instanceof Error ? err.message : "服务器内部错误";
    send(res, 500, { error: message });
  }
}

export function matchRoute(
  method: string,
  path: string,
): { route: Route; params: string[] } | undefined {
  for (const item of ROUTES) {
    if (item.method !== method) continue;
    const found = item.pattern.exec(path);
    if (!found) continue;
    return { route: item, params: found.slice(1).map(decodeURIComponent) };
  }
  return undefined;
}

export type { ApiFail };

export { ensurePlatformReady as start } from "./bootstrap";
export { closeConfiguration as stop } from "./config-center";
