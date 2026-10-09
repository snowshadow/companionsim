import type {
  JudgeConfigSnapshot,
  JudgeDimension,
  JudgeResult,
  Run,
  TokenUsage,
} from "../shared/schema";
import { judgeHeaders } from "./judge-config";
import { constrainJudgeEvidence } from "../shared/judge-evidence";
import { isRecord } from "./validate";
import { isSseDone, splitSse, sseDelta } from "./sse";
import { describeLlmConnection, estimateUsage } from "./llm-connection";
import { buildLlmChatRequest, parseLlmChatMessage, type LlmApi } from "./llm-chat";

const DIMENSIONS = [
  "记忆诚实",
  "主动与边界",
  "关系与人设",
  "能力诚实",
  "出戏",
];
export const JUDGE_TIMEOUT_MS = 240_000;
const VERDICTS = new Set([
  "pass",
  "concern",
  "fail",
  "not_applicable",
  "untestable",
]);

/** 只读、与机器/人工结论无关的原始评审输入；重评不读当前人群/剧本/被测配置。 */
export function judgeInput(run: Run): Record<string, unknown> {
  return {
    runId: run.id,
    mode: run.mode,
    userGenerator: run.userGenerator ?? "未记录",
    person: run.personSnapshot ?? {
      id: run.personId,
      version: run.personVersion,
      content: "未记录",
    },
    script: run.scriptSnapshot ?? {
      id: run.scriptId,
      version: run.scriptVersion,
      content: "未记录",
    },
    sut: run.sutSnapshot ?? {
      name: run.sutName,
      caps: run.sutCaps,
      snapshot: "未记录",
    },
    // 判「出戏」要拿被测自己的角色设定当基准；平台只登记得到它。
    characterBaseline:
      run.sutSnapshot?.description ?? "未登记角色设定：只能判绝对项",
    turns: run.turns,
    requests: run.requests ?? [],
    memories: run.memories,
    inbox: run.inbox,
    facts: run.facts,
    factSource: "关键词与接口记录规则，可能存在误判；不可替代逐句语义判断",
  };
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`评审输出缺少${label}`);
  return value.trim();
}
function evidenceIds(value: unknown, allowed: Set<string>): string[] {
  if (
    !Array.isArray(value) ||
    value.some((id) => typeof id !== "string" || !allowed.has(id))
  ) {
    throw new Error("评审引用了不存在的发言，结果未接纳");
  }
  return [...new Set(value as string[])];
}

export function parseJudgeResult(
  raw: unknown,
  turnIds: Set<string>,
  userTurnIds: Set<string> = turnIds,
): JudgeResult {
  if (
    !isRecord(raw) ||
    !Array.isArray(raw.dimensions) ||
    !isRecord(raw.simulator)
  )
    throw new Error("评审输出格式无效");
  const seen = new Set<string>();
  const dimensions: JudgeDimension[] = raw.dimensions.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.dim !== "string" ||
      !DIMENSIONS.includes(item.dim) ||
      seen.has(item.dim) ||
      typeof item.verdict !== "string" ||
      !VERDICTS.has(item.verdict)
    )
      throw new Error("评审维度或判定无效");
    seen.add(item.dim);
    const excluded =
      item.verdict === "not_applicable" || item.verdict === "untestable";
    if (
      excluded
        ? item.value !== null
        : typeof item.value !== "number" ||
          !Number.isFinite(item.value) ||
          item.value < 1 ||
          item.value > 5
    )
      throw new Error("评审分数不符合 1–5 / 不打分的约定");
    const evidenceTurnIds = evidenceIds(item.evidenceTurnIds, turnIds);
    if (!excluded && evidenceTurnIds.length === 0)
      throw new Error("适用维度没有发言证据，结果未接纳");
    return {
      dim: item.dim,
      verdict: item.verdict as JudgeDimension["verdict"],
      value: item.value as number | null,
      reason: requiredText(item.reason, "维度理由"),
      evidenceTurnIds,
    };
  });
  if (seen.size !== DIMENSIONS.length)
    throw new Error("评审未覆盖五个维度的适用性");
  const simulator = raw.simulator;
  if (
    typeof simulator.verdict !== "string" ||
    !["valid", "deviated", "untestable"].includes(simulator.verdict)
  )
    throw new Error("模拟用户判定无效");
  const simulatorEvidence = evidenceIds(simulator.evidenceTurnIds, turnIds);
  if (
    simulator.verdict !== "untestable" &&
    !simulatorEvidence.some((id) => userTurnIds.has(id))
  )
    throw new Error("模拟用户判定缺少用户发言证据");
  return {
    summary: requiredText(raw.summary, "结论"),
    dimensions,
    simulator: {
      verdict: simulator.verdict as JudgeResult["simulator"]["verdict"],
      reason: requiredText(simulator.reason, "模拟用户理由"),
      evidenceTurnIds: simulatorEvidence,
    },
  };
}

export type JudgeReply = {
  result: JudgeResult;
  rawResult: JudgeResult;
  constraints: string[];
  requestId?: string;
  returnedModel?: string;
  usage?: TokenUsage;
};
export async function executeJudge(
  config: JudgeConfigSnapshot,
  run: Run,
  options: {
    fetcher?: typeof fetch;
    headers?: Record<string, string>;
    timeoutMs?: number;
    api?: LlmApi;
    apiKey?: string;
  } = {},
): Promise<JudgeReply> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? JUDGE_TIMEOUT_MS,
  );
  try {
    const described =
      options.api === undefined && config.credentialRef
        ? await describeLlmConnection(config.credentialRef, config.endpoint)
        : undefined;
    const api = options.api ?? described?.api ?? "openai";
    const apiKey =
      api === "anthropic" ? (options.apiKey ?? described?.apiKey) : undefined;
    const headers =
      options.headers ?? described?.headers ?? (await judgeHeaders(config));
    const built = buildLlmChatRequest({
      api,
      url: config.endpoint,
      apiKey,
      headers,
      model: config.model,
      temperature: config.temperature,
      stream: api === "openai" ? false : undefined,
      extraBody: config.extraBody,
      messages: [
        { role: "system", content: config.prompt },
        { role: "user", content: JSON.stringify(judgeInput(run)) },
      ],
    });
    const response = await (options.fetcher ?? fetch)(built.url, {
      method: "POST",
      signal: controller.signal,
      headers: built.headers,
      body: built.body,
    });
    if (!response.ok) throw new Error(`评审接口 HTTP ${response.status}`);
    const body = await response.text();
    if (body.length > 300_000) throw new Error("评审响应过长，结果未接纳");
    let content: string;
    let returnedModel: string | undefined;
    let usage: TokenUsage | undefined;
    let requestId =
      response.headers.get("x-request-id") ??
      response.headers.get("request-id") ??
      undefined;
    if (api === "anthropic") {
      let envelope: unknown;
      try {
        envelope = JSON.parse(body);
      } catch {
        throw new Error("评审接口未返回有效 JSON");
      }
      if (!isRecord(envelope)) throw new Error("评审接口响应结构无效");
      if (envelope.error != null || envelope.type === "error")
        throw new Error("评审接口报告错误，结果未接纳");
      if (!Array.isArray(envelope.content) && typeof envelope.content !== "string")
        throw new Error("评审接口响应结构无效");
      const parsed = parseLlmChatMessage("anthropic", envelope);
      content = requiredText(parsed.text, "回复正文");
      if (parsed.model) returnedModel = parsed.model;
      if (parsed.id) requestId ??= parsed.id;
      usage = parsed.usage;
    } else if (
      (response.headers.get("content-type") ?? "").includes("text/event-stream")
    ) {
      const events = splitSse(body + "\n\n").events;
      if (!events.some(isSseDone)) throw new Error("评审响应流未完整结束");
      content = "";
      for (const event of events) {
        if (isSseDone(event)) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(event);
        } catch {
          throw new Error("评审流包含无效事件");
        }
        if (!isRecord(parsed)) throw new Error("评审流事件格式无效");
        if (parsed.error != null || parsed.type === "error")
          throw new Error("评审接口报告流错误；本次结果未接纳");
        const choice = Array.isArray(parsed.choices)
          ? parsed.choices[0]
          : undefined;
        if (
          isRecord(choice) &&
          ["length", "content_filter", "error"].includes(
            String(choice.finish_reason),
          )
        )
          throw new Error("评审输出被截断或中断，结果未接纳");
        content += sseDelta(event, "openai-chat");
        const piece = parseLlmChatMessage("openai", parsed);
        if (piece.model) returnedModel = piece.model;
        if (piece.id) requestId ??= piece.id;
        usage = piece.usage ?? usage;
      }
    } else {
      let envelope: unknown;
      try {
        envelope = JSON.parse(body);
      } catch {
        throw new Error("评审接口未返回有效 JSON");
      }
      if (
        !isRecord(envelope) ||
        !Array.isArray(envelope.choices) ||
        !isRecord(envelope.choices[0]) ||
        !isRecord(envelope.choices[0].message)
      )
        throw new Error("评审接口响应结构无效");
      if (envelope.error != null)
        throw new Error("评审接口报告错误，结果未接纳");
      if (
        ["length", "content_filter", "error"].includes(
          String(envelope.choices[0].finish_reason),
        )
      )
        throw new Error("评审输出被截断或中断，结果未接纳");
      const piece = parseLlmChatMessage("openai", envelope);
      content = requiredText(piece.text, "回复正文");
      if (piece.model) returnedModel = piece.model;
      if (piece.id) requestId ??= piece.id;
      usage = piece.usage;
    }
    const jsonText = content
      .trim()
      .replace(/^```(?:json)?\s*/, "")
      .replace(/\s*```$/, "");
    let raw: unknown;
    try {
      raw = JSON.parse(jsonText);
    } catch {
      throw new Error("评审未返回完整的结构化结论");
    }
    const rawResult = parseJudgeResult(
      raw,
      new Set(run.turns.map((turn) => turn.id)),
      new Set(
        run.turns
          .filter((turn) => turn.kind === "user")
          .map((turn) => turn.id),
      ),
    );
    const constrained = constrainJudgeEvidence(rawResult, run);
    return {
      result: constrained.result,
      rawResult,
      constraints: constrained.constraints,
      requestId,
      returnedModel,
      // 网关没给用量就按字符估算，并如实标注来源。
      usage: usage ?? estimateUsage(`${config.prompt}\n${JSON.stringify(judgeInput(run))}`, content),
    };
  } catch (err) {
    if (controller.signal.aborted)
      throw new Error("评审超时；对话已保留，可仅重试评审");
    // Do not forward fetch errors or remote bodies: these may include credential-bearing URLs.
    if (err instanceof Error && /^(评审|适用维度|模拟用户)/.test(err.message))
      throw err;
    throw new Error("无法连接评审接口；请检查连接与凭据");
  } finally {
    clearTimeout(timeout);
  }
}
