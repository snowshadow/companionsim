import { nacosEnabled, readRuntimeConfig, writeRuntimeConfig, type RuntimeFile } from "./config-center";
import path from "node:path";
import { createHash } from "node:crypto";
import type { TokenUsage } from "../shared/schema";
import { configDir } from "./paths";
import { readJsonIfExists, writeJson } from "./store";
import { openAiChatUsage } from "./llm-chat";
import { interpolateEnv, loadSutRecords, resolveSutHeaders, resolvedSutApiKey } from "./sut-config";
import { isRecord } from "./validate";

/**
 * LLM 连接的公共部分。评审器与仿真 agent 器都要：
 * 登记一个 OpenAI 兼容连接 → 解析 ${ENV} → 冻结快照 → 调用时按引用取凭据。
 * 各自的 settings 字段与提示词留在自己的模块里。
 */

export type LlmConnectionTarget = {
  endpoint: string;
  credentialRef: string;
};

export function hashEvidence(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

const RESERVED_BODY_KEYS = new Set(["model", "messages", "stream"]);

/**
 * 解析 extraBody：只允许能放进请求体的普通值，且不准覆盖平台自己管的字段
 * （model / messages / stream —— 覆盖了就不是「额外参数」而是偷改调用方式）。
 */
export function parseExtraBody(
  raw: unknown,
  label: string,
): Record<string, unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) throw new Error(`${label} 必须是对象`);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (RESERVED_BODY_KEYS.has(key)) {
      throw new Error(`${label} 不准覆盖 ${key}；它由平台根据配置生成`);
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      out[key] = value;
      continue;
    }
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      out[key] = value;
      continue;
    }
    throw new Error(`${label}.${key} 只支持字符串 / 数字 / 布尔 / 字符串数组`);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function hashPrompt(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

/**
 * 从 OpenAI 兼容响应里取用量。返回 undefined 表示网关没给——
 * 这时由调用方决定要不要按字符估算，并如实标注 source。
 */
export function usageFromEnvelope(raw: unknown): TokenUsage | undefined {
  return openAiChatUsage(raw);
}

export async function describeLlmConnection(
  credentialRef: string | undefined,
  expectedEndpoint?: string,
): Promise<{
  api: "openai" | "anthropic";
  apiKey?: string;
  headers: Record<string, string>;
}> {
  const headers = await llmConnectionHeaders(credentialRef, expectedEndpoint);
  if (!credentialRef) return { api: "openai", headers };
  const id = credentialRef.startsWith("sut:") ? credentialRef.slice(4) : "";
  const connection = (await loadSutRecords()).records.find((item) => item.id === id);
  if (!connection) return { api: "openai", headers };
  const api = connection.api === "anthropic" ? "anthropic" : "openai";
  const apiKey = api === "anthropic" ? resolvedSutApiKey(connection) : undefined;
  return { api, apiKey, headers };
}

/**
 * 网关不回 usage 时的兜底：按字符估算。中文约 1 token/字，英文约 4 字符/token。
 * 记 source=estimated，不假装是网关报的数。
 */
export function estimateUsage(prompt: string, completion: string): TokenUsage {
  const count = (text: string): number => {
    const cjk = (text.match(/[\u3400-\u9fff\uff00-\uffef]/g) ?? []).length;
    const rest = text.length - cjk;
    return Math.ceil(cjk + rest / 4);
  };
  const promptTokens = count(prompt);
  const completionTokens = count(completion);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    source: "estimated",
  };
}

export function addUsage(
  a: TokenUsage | undefined,
  b: TokenUsage | undefined,
): TokenUsage | undefined {
  if (!a) return b;
  if (!b) return a;
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    source:
      a.source === "reported" && b.source === "reported" ? "reported" : "estimated",
  };
}

function settingsPath(name: string): string {
  return path.join(configDir(), name);
}

/**
 * 校验并解析出一个可调用的 OpenAI 兼容连接。
 * 地址必须是无内嵌凭据、无查询参数的 HTTP(S)；凭据只以引用形式带走。
 */
export async function resolveLlmConnection(
  connectionSutId: string,
  requirement: string,
): Promise<LlmConnectionTarget> {
  const records = await loadSutRecords();
  const connection = records.records.find((item) => item.id === connectionSutId);
  if (
    !connection?.url ||
    connection.transport !== "sse" ||
    (connection.body && connection.body !== "openai-chat")
  ) {
    throw new Error(requirement);
  }
  const endpoint = interpolateEnv(connection.url);
  const url = new URL(endpoint);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search
  ) {
    throw new Error("连接地址必须是无内嵌凭据和查询参数的 HTTP(S) 地址");
  }
  return { endpoint, credentialRef: `sut:${connection.id}` };
}

/** 按冻结的引用解析凭据；可解析轮换后的环境变量，地址与模型不变。 */
export async function llmConnectionHeaders(
  credentialRef: string | undefined,
  expectedEndpoint?: string,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
  };
  if (!credentialRef) return headers;
  const id = credentialRef.startsWith("sut:") ? credentialRef.slice(4) : "";
  const connection = (await loadSutRecords()).records.find(
    (item) => item.id === id,
  );
  if (!connection) throw new Error("凭据引用的连接已不存在");
  if (expectedEndpoint && interpolateEnv(connection.url ?? "") !== expectedEndpoint)
    throw new Error("连接地址已变更，不能将当前凭据发送到旧地址；请使用当前配置重新评审");
  Object.assign(headers, resolveSutHeaders(connection));
  return headers;
}

export async function loadLlmSettings<T>(
  name: string,
  parse: (raw: unknown) => T,
  invalidMessage: string,
): Promise<{
  configured: boolean;
  settings?: T;
  source: "saved" | "unconfigured";
  error?: string;
}> {
  try {
    const raw = nacosEnabled() ? await readRuntimeConfig(name as RuntimeFile) : await readJsonIfExists(settingsPath(name));
    if (raw === undefined) return { configured: false, source: "unconfigured" };
    return { configured: true, settings: parse(raw), source: "saved" };
  } catch (err) {
    return {
      configured: false,
      source: "unconfigured",
      error:
        err instanceof SyntaxError
          ? `${invalidMessage} JSON 无效`
          : err instanceof Error
            ? err.message
            : invalidMessage,
    };
  }
}

export async function saveLlmSettings<T>(
  name: string,
  parse: (raw: unknown) => T,
  raw: T,
  failMessage: string,
): Promise<
  | { ok: true; settings: T }
  | { ok: false; status: number; error: string }
> {
  try {
    const settings = parse(raw);
    if (nacosEnabled()) await writeRuntimeConfig(name as RuntimeFile, settings);
    else await writeJson(settingsPath(name), settings);
    return { ok: true, settings };
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error: err instanceof Error ? err.message : failMessage,
    };
  }
}
