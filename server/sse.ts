/** 把 SSE 字节流拆成 data 块。本版只认 `data:` 行。 */

export function splitSse(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, "\n");
  const parts = normalized.split("\n\n");
  const rest = parts.pop() ?? "";
  const events: string[] = [];
  for (const part of parts) {
    const dataLines = part
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""));
    if (dataLines.length > 0) events.push(dataLines.join("\n"));
  }
  return { events, rest };
}

export function isSseDone(data: string): boolean {
  return data.trim() === "[DONE]";
}

export function sseCompletion(data: string): { done: boolean; finishReason?: string; error?: string } {
  if (isSseDone(data)) return { done: true };
  try {
    const value = JSON.parse(data);
    if (!value || typeof value !== "object") return { done: false };
    if (value.error || value.type === "error" || value.type === "response.failed") {
      // The remote body may echo request credentials. Keep only the error category.
      return { done: false, error: "被测返回流错误" };
    }
    const reason = value.choices?.[0]?.finish_reason;
    if (typeof reason === "string" && reason !== "") return { done: true, finishReason: reason };
    return { done: value.done === true || value.type === "response.completed" };
  } catch {
    return { done: false };
  }
}

/**
 * openai-chat：choices[0].delta.content
 * text：{ text | delta | content }
 * raw：整段 data
 */
export function sseDelta(data: string, parse: "openai-chat" | "text" | "raw"): string {
  if (parse === "raw") return data;
  try {
    const json: unknown = JSON.parse(data);
    if (!json || typeof json !== "object") return "";
    const obj = json as Record<string, unknown>;
    if (parse === "text") {
      if (typeof obj.text === "string") return obj.text;
      if (typeof obj.delta === "string") return obj.delta;
      if (typeof obj.content === "string") return obj.content;
      return "";
    }
    const choices = obj.choices;
    if (!Array.isArray(choices) || choices.length === 0) return "";
    const first = choices[0];
    if (!first || typeof first !== "object") return "";
    const choice = first as Record<string, unknown>;
    const delta = choice.delta;
    if (delta && typeof delta === "object" && typeof (delta as { content?: unknown }).content === "string") {
      return (delta as { content: string }).content;
    }
    const message = choice.message;
    if (message && typeof message === "object" && typeof (message as { content?: unknown }).content === "string") {
      return (message as { content: string }).content;
    }
    return "";
  } catch {
    return "";
  }
}
