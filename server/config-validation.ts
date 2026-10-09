import type { ConfigDocument } from "./config-center";
import { parsePlatformConfig } from "./platform-config";
import { parseSutConfig } from "./sut-config";
import { parseUserGeneratorSettings } from "./fake-user-config";
import { parseJudgeSettings } from "./judge-config";
import { parseQuotaSettings } from "./quota";
import { isRecord } from "./validate";

function exact(raw: unknown, fields: string[]): asserts raw is Record<string, unknown> {
  if (!isRecord(raw) || Object.keys(raw).some(k => !fields.includes(k))) throw new Error("配置包含未知字段");
}
function rejectReferences(raw: unknown): void {
  if (typeof raw === "string" && /\$\{|REPLACE-ME/.test(raw)) throw new Error("Nacos 配置必须包含实际值，不可引用本地环境变量");
  if (raw && typeof raw === "object") for (const v of Object.values(raw)) rejectReferences(v);
}
export function validateConfigDocument(raw: unknown): ConfigDocument {
  exact(raw, ["schemaVersion", "platform", "runtime"]);
  if (raw.schemaVersion !== 1) throw new Error("不支持的配置版本");
  if (!isRecord(raw.platform)) throw new Error("配置包含未知字段");
  const platformFields: Record<string, unknown> = { ...raw.platform };
  delete platformFields.feishu;
  delete platformFields.adminFeishuOpenIds;
  rejectReferences({ ...raw, platform: platformFields });
  exact(platformFields, ["mysql", "superadmin", "session"]);
  const platform = parsePlatformConfig(raw.platform);
  if (!Number.isInteger(platform.mysql.port) || platform.mysql.port < 1 || platform.mysql.port > 65535 || !Number.isInteger(platform.mysql.connectionLimit) || platform.mysql.connectionLimit < 1 || platform.session.ttlHours <= 0 || platform.session.ttlHours > 24 * 30) throw new Error("启动配置数值无效");
  exact(raw.runtime, ["suts.json", "fake-user.json", "judge.json", "quota.json"]);
  const suts = parseSutConfig(raw.runtime["suts.json"]);
  for (const r of suts.records) {
    if (r.url) { const u = new URL(r.url); if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.hash || u.search) throw new Error("连接 URL 无效"); }
  }
  const user = parseUserGeneratorSettings(raw.runtime["fake-user.json"]);
  const judge = parseJudgeSettings(raw.runtime["judge.json"]);
  for (const settings of [user, judge]) {
    const connection = suts.records.find(r => r.id === settings.connectionSutId);
    if (!connection?.url || connection.transport !== "sse" || (connection.body && connection.body !== "openai-chat")) throw new Error("模型连接引用无效");
  }
  const quota = raw.runtime["quota.json"];
  exact(quota, ["dailyTokensPerUser", "dayTimezone", "estimate", "overrides"]);
  exact(quota.estimate, ["simAgentFixed", "simAgentPerHistoricalTurn", "simAgentPerBeat", "judgeFixed", "judgePerTurn", "safetyFactor"]);
  for (const v of [quota.dailyTokensPerUser, ...Object.values(quota.estimate)]) if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error("配额数值无效");
  if (typeof quota.dayTimezone !== "string") throw new Error("配额时区无效");
  new Intl.DateTimeFormat("en", { timeZone: quota.dayTimezone });
  parseQuotaSettings(quota);
  // Preserve original bytes semantically for CAS; parsing normalizes only at consumption.
  return structuredClone(raw) as ConfigDocument;
}
