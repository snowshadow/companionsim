import type { Person, ScriptEvent } from "../shared/schema";

/**
 * 仿真 agent 的提示词。与评审提示词严格分开：
 * 规范允许同一个模型，但禁止同一个提示词。改这里必须同时改版本号。
 */
export const FAKE_USER_PROMPT_VERSION = "fake-user-v3";

/** 一句台词的字符上限；超了当成模型没按“只说一句话”来，触发重试。 */
export const FAKE_USER_MAX_CHARS = 220;

export const FAKE_USER_PROMPT = `你在一场虚拟陪伴仿真里扮演一个真实的人，和被测 AI 伴侣对话。剧本是控制器，你只负责把这一拍说出口。

只输出这个人的下一句话本身。不要加引号、不要解释、不要旁白、不要写动作或心理描写，不要替对方说话。

【最重要的一条】不要说出你的设定。
真实的人不会向对方宣告「我现在需要什么」「我不想要什么」。所以：
- 不要预告需求：别说「你别给我建议」「我不想聊这个」「先别问」这类话。
- 不要解释自己在做什么：别说「我只是想找人说说话」「我这是在回避」。
- 不要报菜名式地交代信息：交代细节要像顺口说起，不要罗列。
本拍的 intent 和 constraints 是给你自己的行为准则，不是台词内容。用你的语气、挑的话题、答多长、要不要转开话题去自然体现。

其余要求：
- 只演给定的这个人：按年龄、性别、性格、兴趣和说话方式开口，不要演成通用助手。
- 严格遵守 intent（这一拍要做成的事）与 tone（语气）。constraints 是硬约束，指的是你「怎么演」，不是你要说的话。
- 结合已有对话自然接下去。不重复自己说过的话，不用「你还记得吗」这类提示语。
- 长度贴合人设：话少的人就给短句，不要堆修辞。
- 「不回」「离开」不是你的台词，由剧本控制；你不会被要求说这些。
- 不要主动给建议、不要提供解决方案，除非这一拍明确要求。

只输出一句话，不要输出 JSON。`;

export type PriorTurn = { role: "user" | "agent"; text: string };

export type FakeUserContext = {
  person: Person;
  event: ScriptEvent;
  simulationTime: string;
  priorTurns: PriorTurn[];
};

/** 生成端只拿到 instructions；violations 是判卷侧的事，不进这里。 */
export function buildFakeUserRequest(context: FakeUserContext): Record<string, unknown> {
  const { person, event } = context;
  return {
    simulation_time: context.simulationTime,
    person: {
      name: person.name,
      age: person.age,
      gender: person.gender,
      relationship: person.relationship ?? null,
      personality: person.personality ?? null,
      occupation: person.occupation ?? null,
      interests: person.interests,
      summary: person.summary,
      behaviors: person.behaviors.map((behavior) => ({
        name: behavior.name,
        instructions: behavior.instructions,
      })),
    },
    previous_turns: context.priorTurns,
    this_beat: {
      intent: event.intent ?? "",
      tone: event.tone ?? null,
      constraints: event.constraints ?? [],
    },
  };
}

/**
 * 从模型输出里取一句台词。只接受纯文本；
 * 空、带代码围栏、或长到不像一句话，都当成无效输出交给上层重试。
 */
export function parseUserLine(raw: string): string {
  let text = raw.trim();
  if (text === "") throw new Error("仿真 agent 输出为空");
  text = text.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (lines.length === 0) throw new Error("仿真 agent 输出为空");
  let line = lines[0];
  // 去成对的引号（中英文）。
  line = line.replace(/^["'“”‘’「『]+/, "").replace(/["'“”‘’」』]+$/, "");
  line = line.trim();
  if (line === "") throw new Error("仿真 agent 输出为空");
  if (line.length > FAKE_USER_MAX_CHARS)
    throw new Error(`仿真 agent 输出过长（${line.length} 字），不像一句话`);
  return line;
}
