/**
 * 通道动作表。剧本只能组合这些动作，编排 Agent 不能新增。
 *
 * 本版只做「一次连续时间的对话」，所以没有 jump：
 * 假时钟未接入任何被测（产品侧还没提供可注入时钟的通道），
 * 与其留着一个跑起来只能记 untestable 的动作，不如先把它从表里去掉。
 * 等产品接上再作为新动作加回来，见 RETIRED_KINDS.jump。
 */
export const ACTIONS = ["speak", "silence", "leave"] as const;

export type ActionKind = (typeof ACTIONS)[number];

export const ACTION_LABEL: Record<ActionKind, string> = {
  speak: "说话",
  silence: "不回",
  leave: "离开",
};

/** 旧 kind：要么是情节/产品状态，要么是已移除的动作。写成 speak 的 tone/constraints。 */
export const RETIRED_KINDS: Record<string, string> = {
  jump: "跳钟已移除。本版只做一次连续时间的对话，不接受跨日或拨钟；时间只在记录里作会话内标注。",
  dnd: "请勿打扰不是通道动作。用户说「别找我」用 speak；说完走人用 leave。设备勿扰等真脑接入后再接。",
  busy: "忙/不在不是通道动作。用 speak 或 leave。",
  sad: "低落是 speak 的语气与约束，不是独立 kind。",
  "ask-impossible": "做不到的请求是 speak 的 intent/constraints，不是独立 kind。",
  correct: "当面纠正是 speak 的 constraints，不是独立 kind。",
};

/**
 * 失败家族。每条剧本声明它要打哪一类，可多选但须能被事件覆盖。
 * 这几条对应产品最怕的失效方式，与评审四维的对应关系写在 docs/agent-spec.md。
 */
export const FAMILIES = [
  "short-term-memory",
  "taboo-topic",
  "hallucination",
  "over-promise",
] as const;

export type FailureFamily = (typeof FAMILIES)[number];

export const FAMILY_LABEL: Record<FailureFamily, string> = {
  "short-term-memory": "短期记忆",
  "taboo-topic": "禁忌话题",
  hallucination: "幻觉",
  "over-promise": "过度承诺",
};

/** 禁止作为目标：需要环境模型或第二个人，v1 不做。 */
export const FORBIDDEN_FAMILIES = ["identity-other-person"] as const;
