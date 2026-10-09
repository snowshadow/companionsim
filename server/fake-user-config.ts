import type {
  UserGeneratorConfigSnapshot,
  UserGeneratorConfigView,
  UserGeneratorSettings,
} from "../shared/schema";
import {
  hashPrompt,
  llmConnectionHeaders,
  loadLlmSettings,
  parseExtraBody,
  resolveLlmConnection,
  saveLlmSettings,
} from "./llm-connection";
import { isRecord } from "./validate";
import { FAKE_USER_PROMPT, FAKE_USER_PROMPT_VERSION } from "./fake-user-prompt";

const CONFIG_NAME = "fake-user.json";
const CONNECTION_REQUIREMENT = "仿真 agent 需要已登记的 OpenAI 兼容对话连接";

function num(raw: unknown, label: string, min: number, max: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < min || raw > max)
    throw new Error(`${label} 必须是 ${min}–${max} 之间的数值`);
  return raw;
}

export function parseUserGeneratorSettings(raw: unknown): UserGeneratorSettings {
  if (!isRecord(raw)) throw new Error("仿真 agent 配置必须是对象");
  const connectionSutId =
    typeof raw.connectionSutId === "string" ? raw.connectionSutId.trim() : "";
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  const promptVersion =
    typeof raw.promptVersion === "string" ? raw.promptVersion.trim() : "";
  if (!connectionSutId || !model) throw new Error("请填写仿真 agent 连接与模型");
  if (promptVersion !== FAKE_USER_PROMPT_VERSION)
    throw new Error(
      `本版只支持 ${FAKE_USER_PROMPT_VERSION} 提示词；版本名必须对应真实提示词`,
    );
  const extraBody = parseExtraBody(raw.extraBody, "仿真 agent extraBody");
  return {
    connectionSutId,
    model,
    temperature: num(raw.temperature, "仿真 agent temperature", 0, 2),
    promptVersion,
    maxAttempts: Math.round(num(raw.maxAttempts, "重试次数", 1, 10)),
    backoffBaseMs: Math.round(num(raw.backoffBaseMs, "退避基数", 0, 60_000)),
    attemptTimeoutMs: Math.round(
      num(raw.attemptTimeoutMs, "单次超时", 1_000, 300_000),
    ),
    totalTimeoutMs: Math.round(
      num(raw.totalTimeoutMs, "单句总预算", 1_000, 900_000),
    ),
    // 旧配置没有这一项：给 40 轮，够长对话里回指早前细节
    priorTurnsLimit: Math.round(
      num(raw.priorTurnsLimit ?? 40, "回看轮数", 1, 200),
    ),
    ...(extraBody ? { extraBody } : {}),
  };
}

export function getUserGeneratorConfig(): Promise<UserGeneratorConfigView> {
  return loadLlmSettings(CONFIG_NAME, parseUserGeneratorSettings, "仿真 agent 配置");
}

export async function saveUserGeneratorConfig(
  raw: UserGeneratorSettings,
): Promise<
  | { ok: true; value: UserGeneratorConfigView }
  | { ok: false; status: number; error: string }
> {
  try {
    // 先确认连接真的可用，再落盘。
    await captureUserGeneratorConfig(raw);
    const saved = await saveLlmSettings(
      CONFIG_NAME,
      parseUserGeneratorSettings,
      raw,
      "仿真 agent 配置保存失败",
    );
    if (!saved.ok) return saved;
    return {
      ok: true,
      value: { configured: true, settings: saved.settings, source: "saved" },
    };
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err instanceof Error ? err.message : "仿真 agent 配置保存失败",
    };
  }
}

/** 冻结调用行为；凭据只留服务端引用。 */
export async function captureUserGeneratorConfig(
  settings?: UserGeneratorSettings,
): Promise<UserGeneratorConfigSnapshot> {
  if (!settings) {
    const current = await getUserGeneratorConfig();
    if (!current.configured || !current.settings)
      throw new Error(current.error || "仿真 agent 未配置，请先设置连接与模型");
    settings = current.settings;
  }
  const parsed = parseUserGeneratorSettings(settings);
  const target = await resolveLlmConnection(
    parsed.connectionSutId,
    CONNECTION_REQUIREMENT,
  );
  return {
    ...parsed,
    capturedAt: new Date().toISOString(),
    endpoint: target.endpoint,
    credentialRef: target.credentialRef,
    promptHash: hashPrompt(FAKE_USER_PROMPT),
    prompt: FAKE_USER_PROMPT,
  };
}

/** 可解析轮换后的凭据，但地址、模型、提示词仍取本局冻结的配置。 */
export function userGeneratorHeaders(
  config: UserGeneratorConfigSnapshot,
): Promise<Record<string, string>> {
  return llmConnectionHeaders(config.credentialRef, config.endpoint);
}
