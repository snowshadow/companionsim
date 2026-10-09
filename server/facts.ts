import type { FactCheck, Script, SutCaps, Turn } from "../shared/schema";

export type FactInput = {
  turns: Turn[];
  memories: string[];
  inbox: string[];
  script: Script;
  caps?: SutCaps;
};

function capsOf(input: FactInput): SutCaps {
  return input.caps ?? { chat: true, inbox: true, memory: true };
}

/**
 * 本层只做一件事：**证据闸**。判断「这一局有没有资格给某个维度下结论」，
 * 而不是去猜语义。
 *
 * 按 Q27：缺记录就不要打那个分，改记 untestable。
 * 语义判断（是否幻觉、是否过度承诺、有没有尊重禁忌）交给独立评判模型与聚类，
 * 不在这里堆正则——`artifacts/jev-experiments/` 的离线实验测过，
 * 「是否声称已经关灯」这类关键词命中只有 6/11，远不如结构化/语义判定。
 */
export function checkFacts(input: FactInput): FactCheck[] {
  const caps = capsOf(input);
  const facts: FactCheck[] = [];

  const hasMemory =
    input.memories.length > 0 ||
    input.turns.some((turn) => turn.kind === "memory");
  facts.push({
    label: "记忆接口与记录",
    result: caps.memory && hasMemory ? "pass" : "untestable",
    note: !caps.memory
      ? "被测未接记忆接口，记忆类结论只能记测不了"
      : hasMemory
        ? "已接入且有本局记忆记录，记忆类结论可以下"
        : "已接入但本局没有记忆读写记录，记忆类结论只能记测不了",
  });

  facts.push({
    label: "主动收件箱",
    result: caps.inbox ? "pass" : "untestable",
    note: caps.inbox
      ? "已接入，打扰类结论可以下"
      : "被测未接主动收件箱，打扰类结论只能记测不了",
  });

  facts.push({
    label: "时间跳转与到点调度",
    result: "not_applicable",
    note: "本版只做一次连续时间的对话，不考察跳钟与到点调度",
  });

  return facts;
}
