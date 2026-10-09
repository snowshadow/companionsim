import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type { RemoteMetadata, RequestTrace, SutCaps } from "../shared/schema";
import { resolvedSutApiKey, type SutRecord } from "./sut-config";
import { buildLlmChatRequest, parseLlmChatMessage } from "./llm-chat";
import { isInProcessMockChat, mockSutSseResponse } from "./mock-sut";
import { isRecord } from "./validate";
import { isSseDone, splitSse, sseCompletion, sseDelta } from "./sse";
import { metadataFromHeaders, metadataFromObject } from "./sut-evidence";
import {
  createRequestTrace,
  emptyEffect,
  noteRemoteMetadata,
  SutRequestError,
} from "./sut-common";
import type { SutBrain } from "./sut";

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
type BrainOptions = { timeoutMs?: number; remoteMetadata?: RemoteMetadata };
const SPEAK_TIMEOUT_MS = 120_000;

/** The caller resolves environment references once, before saving its snapshot. */
export function createSseChatBrain(
  input: SutRecord,
  caps: SutCaps,
  options: BrainOptions = {},
): SutBrain {
  const record = structuredClone(input);
  const messages: ChatMessage[] = [];
  let conversationId = randomUUID();
  const requests: RequestTrace[] = [];
  const parse = record.parse ?? "openai-chat";
  const url = record.url ?? "";
  const fixture = isInProcessMockChat(url);
  let previousMetadata = options.remoteMetadata;

  function chatMessages(): ChatMessage[] {
    return record.systemPrompt
      ? [{ role: "system", content: record.systemPrompt }, ...messages]
      : [...messages];
  }

  function buildBody(): string {
    const messageStyle = (record.body ?? "openai-chat") === "message";
    return buildLlmChatRequest({
      api: "openai",
      url,
      messages: chatMessages(),
      model: record.model,
      temperature: record.temperature,
      topP: record.topP,
      stream: messageStyle ? undefined : true,
      messageStyle,
      latestUser:
        [...messages].reverse().find((item) => item.role === "user")?.content ??
        "",
      // 有的被测要求每段对话一个独立会话 id，字段名由登记里的 sessionIdField 指定。
      session:
        record.sessionIdField && record.runtimeUserId
          ? { field: record.sessionIdField, id: record.runtimeUserId }
          : undefined,
    }).body;
  }

  async function speakAnthropic(text: string) {
    messages.push({ role: "user", content: text });
    const built = buildLlmChatRequest({
      api: "anthropic",
      url,
      apiKey: resolvedSutApiKey(record),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Session-Id": conversationId,
        ...record.headers,
      },
      model: record.model,
      temperature: record.temperature,
      messages: chatMessages(),
    });
    const controller = new AbortController();
    const trace: RequestTrace = createRequestTrace({
      source: "remote",
      ...(record.model ? { requestedModel: record.model } : {}),
    });
    const start = performance.now();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? SPEAK_TIMEOUT_MS,
    );
    let reply = "";
    try {
      const response = await fetch(built.url, {
        method: "POST",
        body: built.body,
        headers: built.headers,
        signal: controller.signal,
      });
      trace.httpStatus = response.status;
      const remoteId =
        response.headers.get("x-request-id") ??
        response.headers.get("request-id");
      if (remoteId) trace.requestId = remoteId;
      if (!response.ok) throw new Error(`被测 HTTP ${response.status}`);
      const raw = await response.text();
      let envelope: unknown;
      try {
        envelope = JSON.parse(raw);
      } catch {
        throw new Error("被测没有返回可用的回复");
      }
      if (!isRecord(envelope)) throw new Error("被测没有返回可用的回复");
      previousMetadata = noteRemoteMetadata(
        trace,
        previousMetadata,
        metadataFromObject(envelope, "response"),
      );
      const parsed = parseLlmChatMessage("anthropic", envelope);
      if (!trace.requestId && parsed.id) trace.requestId = parsed.id.slice(0, 512);
      if (parsed.usage) trace.usage = parsed.usage;
      if (typeof envelope.stop_reason === "string" && envelope.stop_reason !== "")
        trace.finishReason = envelope.stop_reason;
      reply = parsed.text;
      if (reply.trim() !== "") {
        trace.firstContentAt = new Date().toISOString();
        trace.ttftMs = performance.now() - start;
      }
      if (reply.trim() === "") {
        trace.outcome = "empty";
        throw new Error("被测已结束，但没有返回正文");
      }
      messages.push({ role: "assistant", content: reply.trim() });
      trace.outcome = "completed";
      trace.completedAt = new Date().toISOString();
      return { ...emptyEffect(), reply: reply.trim(), request: trace };
    } catch (err) {
      messages.pop();
      trace.failedAt = new Date().toISOString();
      if (controller.signal.aborted) trace.outcome = "timeout";
      const safeErrors = [
        "被测 HTTP ",
        "被测没有返回可用的回复",
        "被测已结束",
      ];
      const message = controller.signal.aborted
        ? "被测对话超时（包含读取回复流）"
        : err instanceof Error &&
            safeErrors.some((prefix) => err.message.startsWith(prefix))
          ? err.message
          : "连接或读取被测回复失败";
      trace.error = message;
      if (reply !== "") trace.partialReply = reply;
      throw new SutRequestError(message, trace, reply);
    } finally {
      trace.durationMs = performance.now() - start;
      clearTimeout(timer);
      controller.abort();
      requests.push(structuredClone(trace));
    }
  }

  return {
    id: record.id,
    name: record.name,
    transport: "sse",
    caps: { ...caps },
    injectClock: async () => {},
    async handleUser(text) {
      if ((record.api ?? "openai") === "anthropic") return speakAnthropic(text);
      messages.push({ role: "user", content: text });
      const body = buildBody();
      const controller = new AbortController();
      const trace: RequestTrace = createRequestTrace({
        source: fixture ? "fixture" : "remote",
        ...(record.model ? { requestedModel: record.model } : {}),
      });
      const start = performance.now();
      const timer = setTimeout(
        () => controller.abort(),
        options.timeoutMs ?? SPEAK_TIMEOUT_MS,
      );
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let reply = "";
      let completed = false;
      let sawFinish = false;

      function captureMetadata(value: RemoteMetadata | undefined) {
        if (!value || fixture) return;
        previousMetadata = noteRemoteMetadata(trace, previousMetadata, value);
      }

      function consume(data: string): boolean {
        const state = sseCompletion(data);
        if (state.error) throw new Error(state.error);
        if (!isSseDone(data)) {
          try {
            const json = JSON.parse(data);
            captureMetadata(metadataFromObject(json, "response"));
            const piece = parseLlmChatMessage("openai", json);
            if (piece.usage) trace.usage = piece.usage;
            if (!fixture && !trace.requestId && typeof json?.id === "string")
              trace.requestId = json.id.slice(0, 512);
          } catch {
            /* Raw/text adapters may emit plain text. */
          }
        }
        const delta = isSseDone(data) ? "" : sseDelta(data, parse);
        if (delta.trim() !== "" && trace.firstContentAt === undefined) {
          trace.firstContentAt = new Date().toISOString();
          trace.ttftMs = performance.now() - start;
        }
        reply += delta;
        if (state.finishReason) trace.finishReason = state.finishReason;
        if (state.done) sawFinish = true;
        // Keep draining past finish_reason to retain trailing usage/identity chunks.
        return isSseDone(data) || (state.done && !state.finishReason);
      }

      try {
        const response = fixture
          ? mockSutSseResponse(body)
          : await fetch(url, {
              method: "POST",
              body,
              headers: {
                Accept: "text/event-stream",
                "Content-Type": "application/json",
                "X-Session-Id": conversationId,
                ...record.headers,
              },
              signal: controller.signal,
            });
        trace.httpStatus = response.status;
        if (!fixture) {
          const remoteId =
            response.headers.get("x-request-id") ??
            response.headers.get("request-id") ??
            response.headers.get("openai-request-id");
          if (remoteId) trace.requestId = remoteId;
          captureMetadata(metadataFromHeaders(response.headers));
        }
        if (!response.ok) throw new Error(`被测 HTTP ${response.status}`);
        if (!response.body) throw new Error("被测没有返回 SSE 流");
        const contentType = response.headers.get("content-type");
        if (contentType && !contentType.includes("text/event-stream"))
          throw new Error("被测返回的不是 SSE 流");
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!completed) {
          const chunk = await reader.read();
          if (chunk.done) {
            buffer += decoder.decode();
            const tail = splitSse(buffer + "\n\n");
            for (const data of tail.events) if (consume(data)) completed = true;
            if (sawFinish) completed = true;
            break;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          const split = splitSse(buffer);
          buffer = split.rest;
          for (const data of split.events) {
            if (consume(data)) {
              completed = true;
              break;
            }
          }
        }
        if (!completed) {
          trace.outcome = "incomplete";
          throw new Error("被测流提前结束，未收到完成信号");
        }
        if (reply.trim() === "") {
          trace.outcome = "empty";
          throw new Error("被测已结束，但没有返回正文");
        }
        messages.push({ role: "assistant", content: reply.trim() });
        trace.outcome = "completed";
        trace.completedAt = new Date().toISOString();
        return { ...emptyEffect(), reply: reply.trim(), request: trace };
      } catch (err) {
        messages.pop();
        trace.failedAt = new Date().toISOString();
        if (controller.signal.aborted) trace.outcome = "timeout";
        const safeErrors = [
          "被测 HTTP ",
          "被测没有返回 SSE 流",
          "被测返回的不是 SSE 流",
          "被测流提前结束",
          "被测已结束",
          "被测返回流错误",
        ];
        const message = controller.signal.aborted
          ? "被测对话超时（包含读取回复流）"
          : err instanceof Error &&
              safeErrors.some((prefix) => err.message.startsWith(prefix))
            ? err.message
            : "连接或读取被测回复失败";
        trace.error = message;
        if (reply !== "") trace.partialReply = reply;
        throw new SutRequestError(message, trace, reply);
      } finally {
        trace.durationMs = performance.now() - start;
        clearTimeout(timer);
        controller.abort();
        if (reader) void reader.cancel().catch(() => undefined);
        requests.push(structuredClone(trace));
      }
    },
    onJump: async () => emptyEffect(),
    onSilence: async () => emptyEffect(),
    leave: async () => {
      messages.length = 0;
      conversationId = randomUUID();
      return emptyEffect();
    },
    presence: () => "available",
    memories: () => [],
    inbox: () => [],
    lastRequest: () =>
      requests.length
        ? structuredClone(requests[requests.length - 1])
        : undefined,
    requests: () => structuredClone(requests),
  };
}
