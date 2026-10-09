import type { TokenUsage, UserGeneratorConfigSnapshot } from "../shared/schema";
import { isRecord } from "./validate";
import { describeLlmConnection, estimateUsage } from "./llm-connection";
import { buildLlmChatRequest, parseLlmChatMessage, type LlmApi } from "./llm-chat";
import { isSseDone, splitSse, sseDelta } from "./sse";
import {
  buildFakeUserRequest,
  parseUserLine,
  type FakeUserContext,
} from "./fake-user-prompt";

/**
 * 仿真 agent 台词生成：OpenAI 兼容调用 + 重试 + 指数退避。
 * 只产一句 speak 台词；动作表由剧本控制，这里改不了。
 */

export type GenerateUserLineResult = {
  text: string;
  attempts: number;
  latencyMs: number;
  requestId?: string;
  returnedModel?: string;
  usage?: TokenUsage;
};

export class UserGeneratorError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly latencyMs: number,
  ) {
    super(message);
    this.name = "UserGeneratorError";
  }
}

/** retryable=false 表示再试也没用（鉴权、结构错误），立即停。 */
class AttemptError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AttemptError";
  }
}

type Options = {
  fetcher?: typeof fetch;
  headers?: Record<string, string>;
  api?: LlmApi;
  apiKey?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
};

type Transport = {
  api: LlmApi;
  apiKey?: string;
  headers: Record<string, string>;
};

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function streamText(body: string): {
  text: string;
  model?: string;
  id?: string;
  usage?: TokenUsage;
} {
  const events = splitSse(`${body}\n\n`).events;
  if (!events.some(isSseDone)) throw new AttemptError("仿真 agent 响应流未完整结束", true);
  let text = "";
  let model: string | undefined;
  let id: string | undefined;
  let usage: TokenUsage | undefined;
  for (const event of events) {
    if (isSseDone(event)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(event);
    } catch {
      throw new AttemptError("仿真 agent 响应流包含无效事件", false);
    }
    if (!isRecord(parsed)) throw new AttemptError("仿真 agent 响应流格式无效", false);
    if (parsed.error != null || parsed.type === "error")
      throw new AttemptError("仿真 agent 接口报告流错误", true);
    const choice = Array.isArray(parsed.choices) ? parsed.choices[0] : undefined;
    if (isRecord(choice)) {
      if (["length", "content_filter", "error"].includes(String(choice.finish_reason)))
        throw new AttemptError("仿真 agent 输出被截断或中断", true);
      const delta = sseDelta(event, "openai-chat");
      if (delta) text += delta;
    }
    const piece = parseLlmChatMessage("openai", parsed);
    if (piece.model) model = piece.model;
    if (piece.id) id ??= piece.id;
    usage = piece.usage ?? usage;
  }
  return { text, model, id, usage };
}

function envelopeText(body: string): {
  text: string;
  model?: string;
  id?: string;
  usage?: TokenUsage;
} {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    throw new AttemptError("仿真 agent 接口未返回有效 JSON", false);
  }
  if (!isRecord(envelope) || !Array.isArray(envelope.choices) || !isRecord(envelope.choices[0])) {
    throw new AttemptError("仿真 agent 接口响应结构无效", false);
  }
  if (envelope.error != null) throw new AttemptError("仿真 agent 接口报告错误", true);
  const choice = envelope.choices[0] as Record<string, unknown>;
  if (["length", "content_filter", "error"].includes(String(choice.finish_reason)))
    throw new AttemptError("仿真 agent 输出被截断或中断", true);
  const piece = parseLlmChatMessage("openai", envelope);
  const message = isRecord(choice.message) ? choice.message : {};
  const content = typeof message.content === "string" ? message.content : "";
  return {
    text: content,
    model: piece.model,
    id: piece.id,
    usage: piece.usage,
  };
}

function anthropicReply(body: string): {
  text: string;
  model?: string;
  id?: string;
  usage?: TokenUsage;
} {
  let envelope: unknown;
  try {
    envelope = JSON.parse(body);
  } catch {
    throw new AttemptError("仿真 agent 接口未返回有效 JSON", false);
  }
  if (!isRecord(envelope)) throw new AttemptError("仿真 agent 接口响应结构无效", false);
  if (envelope.error != null || envelope.type === "error") {
    throw new AttemptError("仿真 agent 接口报告错误", true);
  }
  if (!Array.isArray(envelope.content) && typeof envelope.content !== "string") {
    throw new AttemptError("仿真 agent 接口响应结构无效", false);
  }
  const parsed = parseLlmChatMessage("anthropic", envelope);
  return {
    text: parsed.text,
    model: parsed.model,
    id: parsed.id,
    usage: parsed.usage,
  };
}

async function attempt(
  config: UserGeneratorConfigSnapshot,
  context: FakeUserContext,
  options: Options,
  transport: Transport,
): Promise<{ text: string; model?: string; id?: string; usage?: TokenUsage }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.attemptTimeoutMs);
  try {
    const built = buildLlmChatRequest({
      api: transport.api,
      url: config.endpoint,
      apiKey: transport.apiKey,
      headers: transport.headers,
      model: config.model,
      temperature: config.temperature,
      stream: transport.api === "openai" ? false : undefined,
      extraBody: config.extraBody,
      messages: [
        { role: "system", content: config.prompt },
        { role: "user", content: JSON.stringify(buildFakeUserRequest(context)) },
      ],
    });
    const response = await (options.fetcher ?? fetch)(built.url, {
      method: "POST",
      signal: controller.signal,
      headers: built.headers,
      body: built.body,
    });
    if (!response.ok) {
      // 4xx（除 429）重试无用；5xx 与 429 值得退避再试。
      const retryable = response.status === 429 || response.status >= 500;
      throw new AttemptError(`仿真 agent 接口 HTTP ${response.status}`, retryable);
    }
    const body = await response.text();
    if (body.length > 100_000) throw new AttemptError("仿真 agent 响应过长", true);
    const parsed =
      transport.api === "anthropic"
        ? anthropicReply(body)
        : (response.headers.get("content-type") ?? "").includes("text/event-stream")
          ? streamText(body)
          : envelopeText(body);
    const text = parseUserLine(parsed.text);
    const requestId =
      response.headers.get("x-request-id") ??
      response.headers.get("request-id") ??
      parsed.id;
    return {
      text,
      model: parsed.model,
      id: requestId,
      // 网关没给用量就按字符估算，并如实标注来源。
      usage:
        parsed.usage ??
        estimateUsage(
          `${config.prompt}\n${JSON.stringify(buildFakeUserRequest(context))}`,
          text,
        ),
    };
  } catch (err) {
    if (err instanceof AttemptError) throw err;
    if (controller.signal.aborted)
      throw new AttemptError("仿真 agent 超时", true);
    throw new AttemptError("无法连接仿真 agent 接口", true);
  } finally {
    clearTimeout(timer);
  }
}

export async function generateUserLineLLM(
  config: UserGeneratorConfigSnapshot,
  context: FakeUserContext,
  options: Options = {},
): Promise<GenerateUserLineResult> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const random = options.random ?? Math.random;
  const described =
    options.api === undefined && config.credentialRef
      ? await describeLlmConnection(config.credentialRef, config.endpoint)
      : undefined;
  const transport: Transport = {
    api: options.api ?? described?.api ?? "openai",
    apiKey:
      (options.api ?? described?.api ?? "openai") === "anthropic"
        ? (options.apiKey ?? described?.apiKey)
        : undefined,
    headers:
      options.headers ??
      described?.headers ??
      { "Content-Type": "application/json", Accept: "application/json" },
  };
  const started = now();
  let attempts = 0;
  let lastError = "仿真 agent 失败";

  for (;;) {
    const elapsed = now() - started;
    if (attempts > 0 && elapsed >= config.totalTimeoutMs) {
      throw new UserGeneratorError(
        `仿真 agent 超时（${attempts} 次尝试，总预算 ${config.totalTimeoutMs}ms）`,
        attempts,
        elapsed,
      );
    }
    attempts += 1;
    try {
      const out = await attempt(config, context, options, transport);
      return {
        text: out.text,
        attempts,
        latencyMs: now() - started,
        requestId: out.id,
        returnedModel: out.model,
        usage: out.usage,
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : "仿真 agent 失败";
      const retryable = err instanceof AttemptError ? err.retryable : false;
      if (!retryable || attempts >= config.maxAttempts) break;
      const delay =
        Math.min(
          config.backoffBaseMs * 2 ** (attempts - 1),
          Math.max(0, config.totalTimeoutMs - (now() - started)),
        ) + Math.floor(random() * 250);
      if (now() - started + delay >= config.totalTimeoutMs) break;
      await sleep(delay);
    }
  }
  throw new UserGeneratorError(
    `${lastError}（已尝试 ${attempts} 次，未成功）`,
    attempts,
    now() - started,
  );
}
