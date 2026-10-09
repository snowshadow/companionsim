import type { TokenUsage } from "../shared/schema";
import { isRecord } from "./validate";

/**
 * 被测、仿真用户、评审共用的对话请求。
 * api 缺省 openai：POST 调用方给出的完整 URL，Bearer 鉴权，按 chat/completions 取正文和用量。
 * api 为 anthropic：x-api-key 与 anthropic-version，system 单独成字段，按 messages 响应取正文和用量。
 */

export type LlmApi = "openai" | "anthropic";

export type LlmChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type LlmChatCall = {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body: string;
};

export type ParsedLlmChat = {
  text: string;
  usage?: TokenUsage;
  model?: string;
  id?: string;
};

export type BuildLlmChatInput = {
  api?: LlmApi;
  url: string;
  apiKey?: string;
  headers?: Record<string, string>;
  model?: string;
  messages: LlmChatMessage[];
  temperature?: number;
  extraBody?: Record<string, unknown>;
  /** openai chat/completions：评审与仿真用户传 false，被测 SSE 传 true。 */
  stream?: boolean;
  topP?: number;
  session?: { field: string; id: string };
  messageStyle?: boolean;
  latestUser?: string;
  maxTokens?: number;
};

function hasAuthorization(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((key) => key.toLowerCase() === "authorization");
}

function chatHeaders(input: BuildLlmChatInput): Record<string, string> {
  const headers: Record<string, string> = { ...(input.headers ?? {}) };
  if ((input.api ?? "openai") === "anthropic") {
    if (input.apiKey) headers["x-api-key"] = input.apiKey;
    headers["anthropic-version"] = "2023-06-01";
    return headers;
  }
  if (input.apiKey && !hasAuthorization(headers)) {
    headers.Authorization = `Bearer ${input.apiKey}`;
  }
  return headers;
}

/** 评审 / 仿真用户一直用的形状：model、temperature、stream，然后 extraBody，最后 messages。 */
function openAiCompletionBody(input: BuildLlmChatInput): Record<string, unknown> {
  return {
    ...(input.model !== undefined ? { model: input.model } : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.stream !== undefined ? { stream: input.stream } : {}),
    ...(input.extraBody ?? {}),
    messages: input.messages,
  };
}

/** 被测 SSE 一直用的形状。session 在 model 之前写入，因此 model / temperature / top_p 仍能覆盖同名字段。 */
function openAiSseBody(input: BuildLlmChatInput): Record<string, unknown> {
  const body: Record<string, unknown> = input.messageStyle
    ? { message: input.latestUser ?? "", messages: input.messages }
    : { stream: true, messages: input.messages };
  if (input.session) body[input.session.field] = input.session.id;
  if (input.model !== undefined) body.model = input.model;
  if (input.temperature !== undefined) body.temperature = input.temperature;
  if (input.topP !== undefined) body.top_p = input.topP;
  return body;
}

function anthropicBody(input: BuildLlmChatInput): Record<string, unknown> {
  const systemParts: string[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const message of input.messages) {
    if (message.role === "system") {
      systemParts.push(message.content);
      continue;
    }
    messages.push({ role: message.role, content: message.content });
  }
  const body: Record<string, unknown> = {
    ...(input.model !== undefined ? { model: input.model } : {}),
    max_tokens: input.maxTokens ?? 1024,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.extraBody ?? {}),
  };
  const system = systemParts.join("\n\n");
  if (system !== "") body.system = system;
  body.messages = messages;
  return body;
}

export function buildLlmChatRequest(input: BuildLlmChatInput): LlmChatCall {
  const anthropic = (input.api ?? "openai") === "anthropic";
  const payload = anthropic
    ? anthropicBody(input)
    : input.extraBody || input.stream === false
      ? openAiCompletionBody(input)
      : openAiSseBody(input);
  return {
    url: input.url,
    method: "POST",
    headers: chatHeaders(input),
    body: JSON.stringify(payload),
  };
}

function numberOrZero(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? Math.round(raw)
    : 0;
}

/** OpenAI 兼容响应里的 prompt_tokens / completion_tokens。没有用量时返回 undefined。 */
export function openAiChatUsage(raw: unknown): TokenUsage | undefined {
  const root =
    isRecord(raw) && isRecord(raw.usage)
      ? raw.usage
      : isRecord(raw) && isRecord(raw.data) && isRecord(raw.data.usage)
        ? raw.data.usage
        : undefined;
  if (!root) return undefined;
  const prompt = numberOrZero(root.prompt_tokens);
  const completion = numberOrZero(root.completion_tokens);
  const total = numberOrZero(root.total_tokens) || prompt + completion;
  if (prompt === 0 && completion === 0 && total === 0) return undefined;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    source: "reported",
  };
}

function anthropicUsage(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw) || !isRecord(raw.usage)) return undefined;
  const prompt = numberOrZero(raw.usage.input_tokens);
  const completion = numberOrZero(raw.usage.output_tokens);
  const total = prompt + completion;
  if (prompt === 0 && completion === 0) return undefined;
  return {
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    source: "reported",
  };
}

function anthropicText(raw: Record<string, unknown>): string {
  if (typeof raw.content === "string") return raw.content;
  if (!Array.isArray(raw.content)) return "";
  let text = "";
  for (const block of raw.content) {
    if (isRecord(block) && typeof block.text === "string") text += block.text;
  }
  return text;
}

function openAiText(raw: Record<string, unknown>): string {
  const choice = Array.isArray(raw.choices) ? raw.choices[0] : undefined;
  if (!isRecord(choice)) return "";
  const message = choice.message;
  if (isRecord(message) && typeof message.content === "string") return message.content;
  const delta = choice.delta;
  if (isRecord(delta) && typeof delta.content === "string") return delta.content;
  return "";
}

export function parseLlmChatMessage(
  api: LlmApi,
  raw: unknown,
): ParsedLlmChat {
  if (!isRecord(raw)) return { text: "" };
  const text = api === "anthropic" ? anthropicText(raw) : openAiText(raw);
  return {
    text,
    usage: api === "anthropic" ? anthropicUsage(raw) : openAiChatUsage(raw),
    ...(typeof raw.model === "string" ? { model: raw.model } : {}),
    ...(typeof raw.id === "string" ? { id: raw.id } : {}),
  };
}
