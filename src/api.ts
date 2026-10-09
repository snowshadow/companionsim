import type {
  AdminOverviewResponse,
  ApiError,
  ApiKeyView,
  CatalogResponse,
  CreateKeyRequest,
  CreateKeyResponse,
  CreateSutRequest,
  DecideRequest,
  MeResponse,
  QueueStatus,
  QuotaEstimateResponse,
  QuotaSettingsView,
  QuotaUsageView,
  Role,
  User,
  Run,
  StartHuntRequest,
  StartReplayRequest,
  SutView,
  JudgeConfigView,
  JudgeSettings,
  UserGeneratorConfigView,
  UserGeneratorSettings,
} from "../shared/schema";

/** 401：没登录或登录过期。界面据此回登录页，而不是把它当成普通报错。 */
export class UnauthorizedError extends Error {
  constructor(message = "请先登录") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

function looksLikeHtml(text: string, contentType: string) {
  if (contentType.includes("text/html")) return true;
  const head = text.trimStart().slice(0, 15).toLowerCase();
  return head.startsWith("<!doctype") || head.startsWith("<html");
}

function errorFromBody(text: string, status: number) {
  try {
    const body = JSON.parse(text) as ApiError;
    const parts = [body.error, ...(body.errors ?? [])].filter(Boolean);
    if (parts.length > 0) return parts.join("；");
  } catch {
    /* 不是 JSON 错误体 */
  }
  return `请求失败（${status}）`;
}

async function send(path: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(path, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...init?.headers,
      },
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new Error("网络不通，没法连上评测服务");
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await send(path, init);
  const text = await res.text();
  const contentType = res.headers.get("content-type") ?? "";

  if (res.status === 401) throw new UnauthorizedError(errorFromBody(text, 401));
  if (!res.ok) throw new Error(errorFromBody(text, res.status));
  if (looksLikeHtml(text, contentType)) {
    throw new Error("评测服务还没接上，/api 没有返回数据");
  }
  if (!text.trim()) throw new Error("服务没有返回数据");

  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("服务返回的数据读不出来");
  }
}

export function getMeta() {
  return request<{ repoRoot: string }>("/api/meta");
}

export function getCatalog(signal?: AbortSignal) {
  return request<CatalogResponse>("/api/catalog", { signal });
}

export function getRuns(signal?: AbortSignal) {
  return request<Run[]>("/api/runs", { signal });
}

export function startHunt(body: Omit<StartHuntRequest, "mode">) {
  const payload: StartHuntRequest = { mode: "hunt", ...body };
  return request<Run>("/api/runs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function saveFakeUserConfig(settings: UserGeneratorSettings) {
  return request<UserGeneratorConfigView>("/api/fake-user", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export function startReplay(snapshotId: string, sutId?: string) {
  const payload: StartReplayRequest = { mode: "replay", snapshotId, sutId };
  return request<Run>("/api/runs", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function createSut(body: CreateSutRequest) {
  return request<SutView>("/api/suts", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function decideRun(
  id: string,
  status: Exclude<QueueStatus, "pending">,
  reason = "",
  evidenceTurnIds: string[] = [],
  evaluationAttemptId?: string,
) {
  const payload: DecideRequest = {
    status,
    reason,
    evidenceTurnIds,
    evaluationAttemptId,
  };
  return request<Run>(`/api/runs/${encodeURIComponent(id)}/decide`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateSut(id: string, body: CreateSutRequest) {
  return request<SutView>(`/api/suts/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export function getJudgeConfig() {
  return request<JudgeConfigView>("/api/judge");
}

export function saveJudgeConfig(settings: JudgeSettings) {
  return request<JudgeConfigView>("/api/judge", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export function retryJudge(id: string, settings?: JudgeSettings) {
  return request<Run>(`/api/runs/${encodeURIComponent(id)}/judge`, {
    method: "POST",
    body: JSON.stringify({ settings }),
  });
}

export function reviewReplay(id: string, note: string) {
  return request<Run>(`/api/runs/${encodeURIComponent(id)}/review`, {
    method: "POST",
    body: JSON.stringify({ note }),
  });
}

/* ── 认证 / Key / 配额 / 管理 ────────────────────────────────────── */

export function getMe(signal?: AbortSignal) {
  return request<MeResponse>("/api/auth/me", { signal });
}

export function login(username: string, password: string) {
  return request<{ ok: true }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function logout() {
  return request<{ ok: true }>("/api/auth/logout", { method: "POST" });
}

export function createUser(body: {
  username: string;
  password: string;
  name: string;
  role?: Role;
}) {
  return request<{ user: User }>("/api/admin/users", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function getKeys() {
  return request<{ keys: ApiKeyView[] }>("/api/keys");
}

export function createKey(body: CreateKeyRequest) {
  return request<CreateKeyResponse>("/api/keys", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

export function revokeKey(id: string) {
  return request<{ key?: ApiKeyView }>(`/api/keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function getQuota() {
  return request<{ usage: QuotaUsageView; quota?: QuotaSettingsView }>(
    "/api/quota",
  );
}

export function estimateQuota(
  body:
    | (Omit<StartHuntRequest, "mode"> & { mode?: "hunt" })
    | (Omit<StartReplayRequest, "mode"> & { mode: "replay" }),
) {
  return request<QuotaEstimateResponse>("/api/quota/estimate", {
    method: "POST",
    body: JSON.stringify({ mode: "hunt", ...body }),
  });
}

export function getAdminOverview() {
  return request<AdminOverviewResponse>("/api/admin/overview");
}

export function patchUser(id: string, body: { role?: Role; status?: "active" | "disabled" }) {
  return request<{ user: unknown }>(`/api/users/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

export function kickUser(id: string) {
  return request<{ ok: true; kickedSessions: number }>(
    `/api/users/${encodeURIComponent(id)}/logout`,
    { method: "POST" },
  );
}

export function saveQuotaSettings(settings: unknown) {
  return request<{ ok: true }>("/api/quota", {
    method: "PUT",
    body: JSON.stringify(settings),
  });
}

export function setQuotaOverride(userId: string, dailyTokens: number | null) {
  return request<{ ok: true }>(
    `/api/quota/overrides/${encodeURIComponent(userId)}`,
    { method: "PUT", body: JSON.stringify({ dailyTokens }) },
  );
}

export function errorMessage(err: unknown, fallback = "请求失败") {
  return err instanceof Error && err.message ? err.message : fallback;
}
