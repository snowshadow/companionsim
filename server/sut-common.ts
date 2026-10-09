import { randomUUID } from "node:crypto";
import type { RemoteMetadata, RequestTrace } from "../shared/schema";
import { metadataDrift } from "./sut-evidence";

/**
 * 被测适配器的公共部分。SSE 与 Soulpals 两个适配器都要：
 * 建一条 RequestTrace、累计远端元信息与漂移、把失败连同部分正文抛给运行时。
 * 各自协议细节（流解析 / 轮询）留在自己的模块里。
 */

export type SutEffect = {
  reply?: string;
  request?: RequestTrace;
  proactive: string[];
  memoryLogs: string[];
};

export function emptyEffect(): SutEffect {
  return { proactive: [], memoryLogs: [] };
}

/**
 * 一轮对话失败时带出已收到的部分正文；运行时据此保留部分输出，
 * 不让一次失败把已经拿到的内容丢掉。两个适配器共用同一个类，
 * 运行时可以直接 instanceof 判断，不必再猜字段。
 */
export class SutRequestError extends Error {
  constructor(
    message: string,
    public readonly request: RequestTrace,
    public readonly partialReply = "",
  ) {
    super(message);
    this.name = "SutRequestError";
  }
}

export function createRequestTrace(options: {
  requestedModel?: string;
  source?: "remote" | "fixture";
}): RequestTrace {
  return {
    id: randomUUID(),
    attempt: 1,
    // 缺省即远端；只有进程内样例才标 fixture，避免把样例当成真模型。
    source: options.source ?? "remote",
    startedAt: new Date().toISOString(),
    ttftMs: null,
    durationMs: null,
    outcome: "failed",
    ...(options.requestedModel ? { requestedModel: options.requestedModel } : {}),
  };
}

/**
 * 记下本次响应露出的远端元信息，并把同一局内的漂移标出来。
 * 返回合并后的 previous，供下一次调用比较。
 */
export function noteRemoteMetadata(
  trace: RequestTrace,
  previous: RemoteMetadata | undefined,
  current: RemoteMetadata | undefined,
): RemoteMetadata | undefined {
  if (!current) return previous;
  const drift = [
    ...metadataDrift(previous, current),
    ...metadataDrift(trace.remote, current),
  ];
  if (drift.length)
    trace.drift = [...new Set([...(trace.drift ?? []), ...drift])];
  trace.remote = { ...trace.remote, ...current };
  if (current.model) trace.returnedModel = current.model;
  return { ...previous, ...current };
}
