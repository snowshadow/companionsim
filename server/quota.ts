import { nacosEnabled, readRuntimeConfig, writeRuntimeConfig } from "./config-center";
import fs from "node:fs/promises";
import path from "node:path";
import type { RowDataPacket } from "mysql2/promise";
import type { Script } from "../shared/schema";
import { configFile } from "./paths";
import { databaseConfigured, execute, query } from "./db";
import { isRecord } from "./validate";
import { writeJson } from "./store";

/**
 * Token 配额：开跑前预估 + 每人每日上限。
 *
 * 两层数字：
 *   预估（开跑前）—— 拦截依据，透明可校准，系数在 config/quota.json；
 *   实测（跑完后）—— 对账与校准依据，来自模型返回的 usage。
 * 当日消耗取 `max(预估合计, 实测合计)`：预估不再累加一次，避免同一局被算两遍；
 * 也不至于因为实测要等跑完而低谷低估。跑起来之后不中断，只影响下一次能不能开。
 */

export type EstimateSettings = {
  simAgentFixed: number;
  simAgentPerHistoricalTurn: number;
  simAgentPerBeat: number;
  judgeFixed: number;
  judgePerTurn: number;
  safetyFactor: number;
};

export type QuotaSettings = {
  dailyTokensPerUser: number;
  dayTimezone: string;
  estimate: EstimateSettings;
};

export const DEFAULT_QUOTA: QuotaSettings = {
  dailyTokensPerUser: 3_000_000,
  dayTimezone: "Asia/Shanghai",
  estimate: {
    simAgentFixed: 1200,
    simAgentPerHistoricalTurn: 150,
    simAgentPerBeat: 250,
    judgeFixed: 2500,
    judgePerTurn: 400,
    safetyFactor: 1.3,
  },
};

export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  source: "reported" | "estimated";
};

let cached: QuotaSettings | undefined;

function positive(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
    ? raw
    : fallback;
}

export function parseQuotaSettings(raw: unknown): QuotaSettings {
  if (!isRecord(raw)) return DEFAULT_QUOTA;
  const estimateRaw = isRecord(raw.estimate) ? raw.estimate : {};
  return {
    dailyTokensPerUser: positive(
      raw.dailyTokensPerUser,
      DEFAULT_QUOTA.dailyTokensPerUser,
    ),
    dayTimezone:
      typeof raw.dayTimezone === "string" && raw.dayTimezone.trim() !== ""
        ? raw.dayTimezone.trim()
        : DEFAULT_QUOTA.dayTimezone,
    estimate: {
      simAgentFixed: positive(estimateRaw.simAgentFixed, DEFAULT_QUOTA.estimate.simAgentFixed),
      simAgentPerHistoricalTurn: positive(
        estimateRaw.simAgentPerHistoricalTurn,
        DEFAULT_QUOTA.estimate.simAgentPerHistoricalTurn,
      ),
      simAgentPerBeat: positive(estimateRaw.simAgentPerBeat, DEFAULT_QUOTA.estimate.simAgentPerBeat),
      judgeFixed: positive(estimateRaw.judgeFixed, DEFAULT_QUOTA.estimate.judgeFixed),
      judgePerTurn: positive(estimateRaw.judgePerTurn, DEFAULT_QUOTA.estimate.judgePerTurn),
      safetyFactor: positive(estimateRaw.safetyFactor, DEFAULT_QUOTA.estimate.safetyFactor) || 1,
    },
  };
}

export async function quotaSettings(): Promise<QuotaSettings> {
  if (nacosEnabled()) return parseQuotaSettings(await readRuntimeConfig("quota.json"));
  if (cached) return cached;
  try {
    const raw = JSON.parse(
      await fs.readFile(configFile("quota.json"), "utf8"),
    ) as unknown;
    cached = parseQuotaSettings(raw);
  } catch {
    // 没有配额文件就用默认值：配额不该成为跑不起来的理由。
    cached = DEFAULT_QUOTA;
  }
  return cached;
}

export async function saveQuotaSettings(raw: unknown): Promise<QuotaSettings> {
  const settings = parseQuotaSettings(raw);
  if (nacosEnabled()) { await writeRuntimeConfig("quota.json", settings); return settings; }
  const abs = configFile("quota.json");
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await writeJson(abs, settings);
  cached = settings;
  return settings;
}

export function resetQuotaCache(): void {
  cached = undefined;
}

/* ── 预估 ─────────────────────────────────────────────────────────── */

function round(value: number): number {
  return Math.round(value);
}

/**
 * 探索：每一拍都要带系统提示 + 历史轮次 + 本拍上下文，说一句；
 * 结束时整段对话过一次评审。
 */
export function estimateHuntTokens(
  script: Script,
  priorTurnsLimit: number,
  settings: QuotaSettings,
): number {
  const e = settings.estimate;
  const beats = script.events.filter((event) => event.kind === "speak").length;
  const cap = Math.max(priorTurnsLimit, 0);
  // 历史那一项按**逐拍累加**，不是「每拍都顶满回看上限」：第 i 拍时历史里最多只有
  // min(priorTurnsLimit, 2×(i-1)) 条对话。平台每拍都把历史重发一遍，所以这一项随拍数
  // 平方增长，是长剧本估算的大头；而按顶满算会把 6 拍小剧本估成 7 倍于实测
  // （2026-09-22 第一次拿真实用量校准时的结论）。
  let simAgent = 0;
  for (let i = 1; i <= beats; i += 1) {
    const history = Math.min(cap, 2 * (i - 1));
    simAgent +=
      e.simAgentFixed + history * e.simAgentPerHistoricalTurn + e.simAgentPerBeat;
  }
  const judge = e.judgeFixed + judgeTurnCount(script) * e.judgePerTurn;
  return round((simAgent + judge) * e.safetyFactor);
}

/**
 * 评审输入里的对话轮数。平台每个事件写一条 clock，说话事件再各写一条 user / agent，
 * 所以轮数 ≈ 事件数 + 2×说话数。实测：61 事件 / 55 说话的长对话是 177 轮（这条公式给 171，
 * 差 3% 由 safetyFactor 吸收）；早期用「事件×2」会低估一半，长剧本的评审预估因此少算一倍。
 */
export function judgeTurnCount(script: Script): number {
  const speaks = script.events.filter((event) => event.kind === "speak").length;
  return Math.max(script.events.length + speaks * 2, 1);
}

/** 回归：台词是冻结的，不调生成器，只付一次评审。 */
export function estimateReplayTokens(
  script: Script,
  settings: QuotaSettings,
): number {
  const e = settings.estimate;
  return round(
    (e.judgeFixed + judgeTurnCount(script) * e.judgePerTurn) * e.safetyFactor,
  );
}

/* ── 记账 ─────────────────────────────────────────────────────────── */

export function dayKey(settings: QuotaSettings, at = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: settings.dayTimezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

let warnedNoDb = false;

/** 没过数据库就不记账：本地开发与用例走这条路。生产一定有 platform.json。 */
async function dbReady(context: string): Promise<boolean> {
  if (await databaseConfigured()) return true;
  if (!warnedNoDb) {
    warnedNoDb = true;
    console.warn(
      `[quota] 未配置数据库，配额不生效（${context}）。生产环境请配置 config/platform.json。`,
    );
  }
  return false;
}

export function resetQuotaWarning(): void {
  warnedNoDb = false;
}

export type QuotaUsage = {
  day: string;
  limit: number;
  used: number;
  estimated: number;
  actual: number;
  runs: number;
  remaining: number;
};

type QuotaRow = RowDataPacket & {
  estimated_tokens: number;
  actual_tokens: number;
  runs: number;
};

export async function quotaForUser(userId: string): Promise<QuotaUsage> {
  const settings = await quotaSettings();
  const day = dayKey(settings);
  if (!(await dbReady("读取额度"))) {
    return {
      day,
      limit: settings.dailyTokensPerUser,
      used: 0,
      estimated: 0,
      actual: 0,
      runs: 0,
      remaining: settings.dailyTokensPerUser,
    };
  }
  const [rows, overrides] = await Promise.all([
    query<QuotaRow>(
      "SELECT * FROM quota_daily WHERE day = ? AND user_id = ?",
      [day, userId],
    ),
    query<RowDataPacket & { daily_tokens: number }>(
      "SELECT * FROM quota_overrides WHERE user_id = ?",
      [userId],
    ),
  ]);
  const row = rows[0];
  const estimated = Number(row?.estimated_tokens ?? 0);
  const actual = Number(row?.actual_tokens ?? 0);
  const used = Math.max(estimated, actual);
  const limit = Number(overrides[0]?.daily_tokens ?? settings.dailyTokensPerUser);
  return {
    day,
    limit,
    used,
    estimated,
    actual,
    runs: Number(row?.runs ?? 0),
    remaining: Math.max(limit - used, 0),
  };
}

export async function recordRunStart(
  userId: string,
  estimate: number,
): Promise<void> {
  if (!(await dbReady("登记开局用量"))) return;
  const settings = await quotaSettings();
  const day = dayKey(settings);
  await execute(
    `INSERT INTO quota_daily (day, user_id, estimated_tokens, runs)
     VALUES (?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       estimated_tokens = estimated_tokens + VALUES(estimated_tokens),
       runs = runs + 1`,
    [day, userId, Math.max(estimate, 0)],
  );
}

/** 实测用量回来时记一次；同一局重复上报会重复计数，所以调用方保证只记一次。 */
export async function recordRunUsage(
  userId: string,
  usage: TokenUsage,
): Promise<void> {
  if (!(await dbReady("登记实际用量"))) return;
  const settings = await quotaSettings();
  const day = dayKey(settings);
  await execute(
    `INSERT INTO quota_daily (day, user_id, actual_tokens, prompt_tokens, completion_tokens)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       actual_tokens = actual_tokens + VALUES(actual_tokens),
       prompt_tokens = prompt_tokens + VALUES(prompt_tokens),
       completion_tokens = completion_tokens + VALUES(completion_tokens)`,
    [
      day,
      userId,
      Math.max(usage.totalTokens, 0),
      Math.max(usage.promptTokens, 0),
      Math.max(usage.completionTokens, 0),
    ],
  );
}

export type DailyUsageRow = {
  userId: string;
  estimated: number;
  actual: number;
  runs: number;
};

export async function usageByDay(day: string): Promise<DailyUsageRow[]> {
  if (!(await dbReady("读取当日用量"))) return [];
  const rows = await query<RowDataPacket & {
    user_id: string;
    estimated_tokens: number;
    actual_tokens: number;
    runs: number;
  }>("SELECT * FROM quota_daily WHERE day = ? ORDER BY user_id", [day]);
  return rows.map((row) => ({
    userId: row.user_id,
    estimated: Number(row.estimated_tokens),
    actual: Number(row.actual_tokens),
    runs: Number(row.runs),
  }));
}

export async function setQuotaOverride(
  userId: string,
  dailyTokens: number | null,
  actorName: string,
): Promise<void> {
  if (!(await dbReady("调整额度"))) return;
  if (dailyTokens === null) {
    await execute("DELETE FROM quota_overrides WHERE user_id = ?", [userId]);
    return;
  }
  await execute(
    `INSERT INTO quota_overrides (user_id, daily_tokens, updated_at, updated_by_name)
     VALUES (?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       daily_tokens = VALUES(daily_tokens),
       updated_at = VALUES(updated_at),
       updated_by_name = VALUES(updated_by_name)`,
    [userId, Math.max(Math.round(dailyTokens), 0), new Date(), actorName],
  );
}

export type QuotaDecision =
  | { ok: true; estimate: number; usage: QuotaUsage }
  | { ok: false; estimate: number; usage: QuotaUsage; error: string };

/** 拦截判断。只有人（session / superadmin）与 key 主人都受配额约束。 */
export async function checkQuota(
  userId: string | undefined,
  estimate: number,
): Promise<QuotaDecision> {
  if (!userId) return { ok: true, estimate, usage: await quotaForUser("") };
  if (!(await dbReady("开跑前检查额度"))) {
    return { ok: true, estimate, usage: await quotaForUser(userId) };
  }
  const usage = await quotaForUser(userId);
  if (usage.used + estimate > usage.limit) {
    return {
      ok: false,
      estimate,
      usage,
      error: `今日仿真额度不足：本局预估 ${estimate.toLocaleString("en-US")} token，今日已用 ${usage.used.toLocaleString("en-US")}，上限 ${usage.limit.toLocaleString("en-US")}。可改小剧本、明天再跑，或找管理员提额。`,
    };
  }
  return { ok: true, estimate, usage };
}
