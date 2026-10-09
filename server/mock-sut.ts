import { isRecord } from "./validate";

/** 本仓库的对话回声样例。用来验证 SSE 接入，不是产品大脑。 */

export function lastUserFromChatBody(body: unknown): string {
  if (!isRecord(body)) return "";
  if (typeof body.message === "string" && body.message.trim() !== "") return body.message;
  if (!Array.isArray(body.messages)) return "";
  let last = "";
  for (const item of body.messages) {
    if (isRecord(item) && item.role === "user" && typeof item.content === "string") {
      last = item.content;
    }
  }
  return last;
}

export function mockSutReply(userText: string): string {
  const last = userText.trim();
  return last === "" ? "嗯，我在。" : `嗯，我听到了：${last}`;
}

export function encodeOpenAiChatSse(reply: string): Uint8Array {
  const mid = Math.ceil(reply.length / 2);
  const parts = [reply.slice(0, mid), reply.slice(mid)].filter((chunk) => chunk !== "");
  let out = "";
  for (const chunk of parts) {
    out += `data: ${JSON.stringify({ choices: [{ delta: { content: chunk } }] })}\n\n`;
  }
  out += "data: [DONE]\n\n";
  return new TextEncoder().encode(out);
}

export function mockSutSseResponse(requestBody: string): Response {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(requestBody);
  } catch {
    parsed = {};
  }
  const bytes = encodeOpenAiChatSse(mockSutReply(lastUserFromChatBody(parsed)));
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}

export function isInProcessMockChat(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/$/, "");
    if (path !== "/api/mock-sut/chat") return false;
    const host = parsed.hostname.replace(/^\[|\]$/g, "");
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}
