import type { ActionKind, FailureFamily } from "./actions";

/** 相处时怎么说。不写通道动作；与剧本冲突时以剧本为准。 */
export type PersonBehavior = {
  name: string;
  /** 进仿真 agent 提示词。 */
  instructions: string[];
  /** 仿真 agent 演歪的判据，不是被测失败的判据。 */
  violations: string[];
};

export type Person = {
  id: string;
  name: string;
  version: string;
  immutable: true;
  /** 人群画像，例如「25岁年轻女性，单身，INTJ，喜欢动漫」。 */
  summary: string;
  age: number;
  gender: string;
  relationship?: string;
  personality?: string;
  occupation?: string;
  interests: string[];
  expectedDiff: string;
  expectedDiffScripts: string[];
  behaviors: PersonBehavior[];
};

export type ScriptEvent = {
  id: string;
  /** 会话内时间标注（HH:MM），只用于记录与顺序，不代表拨钟或被测能读到。 */
  clock: string;
  kind: ActionKind;
  /** speak 必填：这一拍要做成的事，进仿真 agent 提示词，不是台词。 */
  intent?: string;
  /** speak 可选：语气 / 情感，进仿真 agent 提示词。 */
  tone?: string;
  /** speak 可选：硬约束，进仿真 agent 提示词。 */
  constraints?: string[];
};

export type Script = {
  id: string;
  name: string;
  version: string;
  family: FailureFamily;
  events: ScriptEvent[];
};

export type SnapshotLine = {
  eventId: string;
  clock: string;
  user: string;
};

export type Snapshot = {
  id: string;
  personId: string;
  personVersion: string;
  scriptId: string;
  scriptVersion: string;
  sourceRunId: string;
  lines: SnapshotLine[];
  personSnapshot?: Person;
  scriptSnapshot?: Script;
};

export type QueueStatus = "pending" | "accepted" | "rejected" | "unclear";

/** 权限只有两档：登录即 member；被测 / 评审 / 仿真 agent 配置与配额只有 admin 能改。 */
export type Role = "admin" | "member";

export type User = {
  id: string;
  username?: string;
  feishuOpenId?: string;
  feishuUnionId?: string;
  name: string;
  avatarUrl?: string;
  email?: string;
  role: Role;
  status: "active" | "disabled";
  createdAt: string;
  lastLoginAt?: string;
  loginCount: number;
};

/**
 * 操作人。姓名存快照：人改名之后历史记录仍读得通。
 * apiKey 的归属落在 key 主人身上，所以 Agent 提交的产物能追到人。
 */
export type ActorKind = "user" | "superadmin" | "apiKey" | "system";

export type Actor = {
  kind: ActorKind;
  userId?: string;
  name: string;
  keyId?: string;
  keyName?: string;
};

/** 模型用量。网关不回 usage 时按字符估算，并如实标注 source。 */
export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source: "reported" | "estimated";
};

/** 跑局执行阶段。和待审判定 status 分开：没跑完不能判定。 */
export type RunPhase = "running" | "done" | "failed";

export type FactResult = "pass" | "fail" | "untestable" | "not_applicable";

export type FactCheck = {
  label: string;
  result: FactResult;
  note: string;
};

export type Score = {
  dim: string;
  value: number | null;
  reason: string;
};

export type TurnKind =
  "clock" | "event" | "user" | "agent" | "proactive" | "memory";

export type Turn = {
  id: string;
  kind: TurnKind;
  text: string;
  eventId?: string;
  simulationTime?: string;
  recordedAt?: string;
  requestTraceId?: string;
};

export type RemoteMetadata = {
  source: "response" | "meta-endpoint";
  capturedAt: string;
  model?: string;
  build?: string;
  release?: string;
  commit?: string;
  promptVersion?: string;
  toolsVersion?: string;
  memoryVersion?: string;
};

/** 一次被测请求的实测数据；缺失值不作零处理。 */
export type RequestTrace = {
  id: string;
  /** 被测若返回用量就记；没有接口就空着，不估算成真值。 */
  usage?: TokenUsage;
  eventId?: string;
  attempt: number;
  source: "remote" | "fixture";
  simulationTime?: string;
  startedAt: string;
  firstContentAt?: string;
  completedAt?: string;
  failedAt?: string;
  ttftMs: number | null;
  durationMs: number | null;
  outcome: "completed" | "failed" | "timeout" | "empty" | "incomplete";
  httpStatus?: number;
  requestId?: string;
  requestedModel?: string;
  returnedModel?: string;
  finishReason?: string;
  remote?: RemoteMetadata;
  drift?: string[];
  error?: string;
  partialReply?: string;
};

export type Presence = "available" | "busy" | "dnd";

export type SutTransport =
  | "fixture"
  | "sse"
  | "soulpals"
  | "soulpals-service"
  | "http"
  | "websocket";

export type SseBodyStyle = "openai-chat" | "message";

/** 被测对话协议：SSE 的两种请求体，或 Soulpals 的 REST + 轮询。 */
export type SutStyle = SseBodyStyle | "soulpals" | "soulpals-service";

export type SseParseStyle = "openai-chat" | "text" | "raw";

/** 被测这局实际接上了什么。没接上的环记 untestable，不准假装通过。 */
export type SutCaps = {
  chat: boolean;
  inbox: boolean;
  memory: boolean;
};

export type SutView = {
  id: string;
  name: string;
  transport: SutTransport;
  caps: SutCaps;
  note?: string;
  url?: string;
  model?: string;
  /** 模型接口。缺省 openai。anthropic 走 messages。 */
  api?: "openai" | "anthropic";
  body?: SseBodyStyle;
  parse?: SseParseStyle;
  environment?: string;
  /** Soulpals：Agent / Avatar 标识，例如 test2。 */
  avatarId?: string;
  /** 本局的仿真身份。Soulpals 用作 runtime_user_id；带 sessionIdField 的 SSE 用作会话 id。 */
  runtimeUserId?: string;
  /** SSE：把本局仿真身份放进请求体的哪个字段（如 `session_id`）。空则不传。 */
  sessionIdField?: string;
  description?: string;
  agentVersion?: string;
  metaUrl?: string;
  systemPrompt?: string;
  promptVersion?: string;
  temperature?: number;
  topP?: number;
  session?: string;
  initialMemory?: string;
  tools?: string;
  credentialConfigured?: boolean;
  credentialRef?: string;
};

export type SutSnapshot = SutView & {
  capturedAt: string;
  source: "platform-config";
  configHash: string;
  adapterVersion: string;
  promptHash?: string;
  declaredVersionSource: "human-unverified";
  remoteMetadata?: RemoteMetadata;
  metaError?: string;
};

export type JudgeSettings = {
  connectionSutId: string;
  model: string;
  temperature: number;
  rubricVersion: string;
  /**
   * 原样透传给模型的额外请求体字段（如百炼的 `enable_thinking: false`）。
   * 厂商私有开关塞在顶层参数里，没有别的表达方式；`model` / `messages` 不准覆盖。
   */
  extraBody?: Record<string, unknown>;
};

export type JudgeConfigView = {
  configured: boolean;
  settings?: JudgeSettings;
  source: "saved" | "default" | "unconfigured";
  error?: string;
};

export type JudgeConfigSnapshot = JudgeSettings & {
  capturedAt: string;
  endpoint: string;
  credentialRef?: string;
  promptVersion: string;
  promptHash: string;
  prompt: string;
  scale: string;
  inputHash: string;
};

/** 探索台词的来源：模板、被测冻结的原句，或 LLM 扮演。 */
export type UserGeneratorKind = "template-v1" | "llm-v1" | "frozen";

/** 仿真 agent 的登记配置。只产 speak 台词，不碰动作表。 */
export type UserGeneratorSettings = {
  connectionSutId: string;
  model: string;
  temperature: number;
  promptVersion: string;
  /** 一句台词最多试几次（含首次）。 */
  maxAttempts: number;
  /** 退避基数；第 n 次重试等 backoffBaseMs * 2^(n-1)。 */
  backoffBaseMs: number;
  /** 单次调用的超时。 */
  attemptTimeoutMs: number;
  /** 一句台词的总预算，含所有重试与退避。 */
  totalTimeoutMs: number;
  /** 生成这句时回看多少轮历史。长对话要调大，否则仿真 agent 记不住前面说过的细节。 */
  priorTurnsLimit: number;
  /** 同 JudgeSettings.extraBody：厂商私有开关（百炼 `enable_thinking` 等）原样透传。 */
  extraBody?: Record<string, unknown>;
};

export type UserGeneratorConfigView = {
  configured: boolean;
  settings?: UserGeneratorSettings;
  source: "saved" | "unconfigured";
  error?: string;
};

/** 开局冻结的生成器配置；不含凭据值，只留引用。 */
export type UserGeneratorConfigSnapshot = UserGeneratorSettings & {
  capturedAt: string;
  endpoint: string;
  credentialRef?: string;
  promptHash: string;
  prompt: string;
};

/** 每次 speak 的生成实测：试了几次、花了多久、成不成。 */
export type UserGenerationRecord = {
  eventId: string;
  usage?: TokenUsage;
  attempts: number;
  startedAt: string;
  finishedAt: string;
  latencyMs: number;
  outcome: "completed" | "failed";
  requestId?: string;
  returnedModel?: string;
  error?: string;
};

export type JudgeDimension = {
  dim: string;
  verdict: "pass" | "concern" | "fail" | "not_applicable" | "untestable";
  value: number | null;
  reason: string;
  evidenceTurnIds: string[];
};

export type JudgeResult = {
  summary: string;
  dimensions: JudgeDimension[];
  simulator: {
    verdict: "valid" | "deviated" | "untestable";
    reason: string;
    evidenceTurnIds: string[];
  };
};

export type EvaluationAttempt = {
  id: string;
  number: number;
  /** 谁点的这次评审（含重评）。旧记录没有该字段。 */
  attemptedBy?: Actor;
  usage?: TokenUsage;
  status: "running" | "done" | "failed";
  config?: JudgeConfigSnapshot;
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  timeoutMs?: number;
  result?: JudgeResult;
  rawResult?: JudgeResult;
  evidenceConstraints?: string[];
  error?: string;
  requestId?: string;
  returnedModel?: string;
};

export type HumanDecision = {
  status: Exclude<QueueStatus, "pending">;
  reason: string;
  evidenceTurnIds: string[];
  decidedAt: string;
  /** 判定人。Key 不能做判定（服务端拒绝），所以这里应当只有人。 */
  decidedBy?: Actor;
  evaluationAttemptId?: string;
};

/** 一局的用量汇总，口径是「本局实际发生」而不是「本日累计」。 */
export type RunTokenUsage = TokenUsage & {
  byPhase: { simAgent: number; judge: number };
};

export type RunMode = "hunt" | "replay";

export type Run = {
  id: string;
  mode: RunMode;
  status: QueueStatus;
  createdAt: string;
  /** 发起人。旧记录没有该字段（那时还没有登录），界面显示「未记录（历史）」。 */
  createdBy?: Actor;
  /** 回归查看备注与查看人。 */
  reviewedBy?: Actor;
  /** 本局用量汇总（仿真 agent + 评审）。旧记录没有。 */
  tokenUsage?: RunTokenUsage;
  /** 缺省视为已跑完（旧文件没有该字段）。 */
  phase?: RunPhase;
  stage?: "dialogue" | "judging" | "complete";
  dialogueStatus?: "running" | "done" | "failed";
  evaluationStatus?: "pending" | "running" | "done" | "failed";
  dialogueStartedAt?: string;
  dialogueCompletedAt?: string;
  dialogueDurationMs?: number;
  completedAt?: string;
  durationMs?: number;
  personSnapshot?: Person;
  scriptSnapshot?: Script;
  sutSnapshot?: SutSnapshot;
  requests?: RequestTrace[];
  evaluations?: EvaluationAttempt[];
  decisions?: HumanDecision[];
  reviewNote?: string;
  reviewedAt?: string;
  userGenerator?: UserGeneratorKind;
  /**
   * 记录代际。旧文件没这个字段，由 runGeneration() 从证据推导。
   * 第 1 代（09-10 规则分期）：只有 scores，无 evaluations/userGenerator。
   * 第 2 代（09-11 模板期）：template-v1 / frozen + evaluations。
   * 第 3 代（09-18 起）：llm-v1 + generatorSnapshot/generations。
   */
  /**
   * 记忆域。同一域内的局共享被测侧的长程记忆，必须串行。
   * 有值说明本局是在一个已经被前面几局写过的记忆域里跑的，不是干净样本。
   */
  memoryDomain?: string;
  /** 本局在该记忆域里的序号（1 起）。 */
  memorySequence?: number;
  /** 同域内先跑的局 id，按时间序。用来判断累积记忆的影响。 */
  priorRunIds?: string[];
  /** 并发键：同键的局不能同时跑（被测账号只允许一个可写会话）。 */
  concurrencyKey?: string;
  generation?: 1 | 2 | 3;
  /** 开局冻结的生成器配置与提示词；重评不重读当前配置。 */
  generatorSnapshot?: UserGeneratorConfigSnapshot;
  /** 每次 speak 的生成实测。 */
  generations?: UserGenerationRecord[];
  /** phase=failed 时的原因。 */
  error?: string;
  eventTotal?: number;
  eventDone?: number;
  personId: string;
  personVersion: string;
  personName: string;
  scriptId: string;
  scriptVersion: string;
  scriptName: string;
  snapshotId?: string;
  sutId?: string;
  sutName?: string;
  sutTransport?: SutTransport;
  sutCaps?: SutCaps;
  /** 本局对话开始时的会话内时间标注；不代表被测读到了时间。 */
  clock: string;
  presence: Presence;
  turns: Turn[];
  facts: FactCheck[];
  scores: Score[];
  memories: string[];
  inbox: string[];
};

export type ArtifactIssue = {
  path: string;
  errors: string[];
};

export type ScriptView = Script & {
  span: string;
  /** 谁提交的、什么时候（来自审计流，不写进产物本身）。 */
  createdBy?: Actor;
  createdAt?: string;
};

/** 人群视图：产物字段不动，操作人由审计流旁路附加。 */
export type PersonView = Person & {
  createdBy?: Actor;
  createdAt?: string;
};

export type CatalogResponse = {
  people: PersonView[];
  scripts: ScriptView[];
  snapshots: Snapshot[];
  suts: SutView[];
  issues: ArtifactIssue[];
  judge?: JudgeConfigView;
  userGenerator?: UserGeneratorConfigView;
};

export type StartHuntRequest = {
  mode: "hunt";
  personId: string;
  personVersion: string;
  scriptId: string;
  scriptVersion: string;
  sutId?: string;
  /** 探索台词来源。缺省 llm：没配置就报错，不静默回退模板。 */
  generator?: "llm" | "template";
};

export type StartReplayRequest = {
  mode: "replay";
  snapshotId: string;
  sutId?: string;
};


export type CreateSutRequest = {
  name: string;
  url: string;
  apiKey?: string;
  style?: SutStyle;
  /** 模型接口。缺省 openai。仅 SSE 被测使用。 */
  api?: "openai" | "anthropic";
  /** Cherry Studio 等网关要 `providerId:modelId`，不能写死 sut。 */
  model?: string;
  parse?: SseParseStyle;
  environment?: string;
  avatarId?: string;
  runtimeUserId?: string;
  sessionIdField?: string;
  description?: string;
  agentVersion?: string;
  metaUrl?: string;
  systemPrompt?: string;
  promptVersion?: string;
  temperature?: number | null;
  topP?: number | null;
  session?: string;
  initialMemory?: string;
  tools?: string;
  clearApiKey?: boolean;
};

export type DecideRequest = {
  status: Exclude<QueueStatus, "pending">;
  reason?: string;
  evidenceTurnIds?: string[];
  evaluationAttemptId?: string;
};

export type RejudgeRequest = { settings?: JudgeSettings };

export type SubmitKind = "person" | "script";

export type SubmitRequest = {
  kind: SubmitKind;
  payload: unknown;
};

export type ApiError = {
  error: string;
  errors?: string[];
};

/* ── 认证 / 权限 / 配额（DTO） ────────────────────────────────────── */

export type MeResponse = {
  authenticated: boolean;
  user?: User;
  role?: Role;
  /** 旧的超级管理员会话没有绑定用户行时，用这个显示是谁。 */
  superadminUsername?: string;
  source?: "password" | "superadmin" | "apiKey";
  can: { admin: boolean; decide: boolean };
  quota?: QuotaUsageView;
};

export type QuotaUsageView = {
  day: string;
  limit: number;
  used: number;
  estimated: number;
  actual: number;
  runs: number;
  remaining: number;
};

export type QuotaEstimateResponse = {
  estimatedTokens: number;
  usage: QuotaUsageView;
  /** 预估会超上限时为 false，界面据此提示。 */
  allowed: boolean;
  error?: string;
};

export type QuotaSettingsView = {
  settings: {
    dailyTokensPerUser: number;
    dayTimezone: string;
    estimate: Record<string, number>;
  };
  today: string;
  users: { userId: string; name: string; estimated: number; actual: number; runs: number }[];
};

export type KeyScope = "read" | "author" | "run";

export type ApiKeyView = {
  id: string;
  name: string;
  ownerUserId: string;
  ownerName: string;
  prefix: string;
  scopes: KeyScope[];
  createdAt: string;
  createdByName: string;
  createdByKind: ActorKind;
  expiresAt?: string;
  lastUsedAt?: string;
  lastUsedIp?: string;
  revokedAt?: string;
  revokedByName?: string;
};

export type CreateKeyRequest = {
  name: string;
  scopes?: KeyScope[];
  expiresInDays?: number;
};

export type CreateKeyResponse = {
  key: ApiKeyView;
  /** 明文只在这里出现一次。 */
  plain: string;
};

export type UserAdminView = User & {
  todayUsage?: QuotaUsageView;
};

export type AuditView = {
  id: number;
  at: string;
  actor: Actor;
  action: string;
  target: string;
  detail?: unknown;
  ip?: string;
};

export type ConfigurationStatus = {
  source: "file" | "nacos";
  state: "ready" | "unavailable" | "degraded" | "pending_restart";
  revision?: string;
  reason?: string;
  checkedAt?: string;
};

export type AdminOverviewResponse = {
  configuration?: ConfigurationStatus;
  users: UserAdminView[];
  keys: ApiKeyView[];
  audit: AuditView[];
  superadmin: { username: string; passwordConfigured: boolean };
  database: { ok: boolean; version?: string; error?: string };
};
