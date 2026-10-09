import type { Person, RunMode, ScriptEvent } from "../shared/schema";

function behaviorCue(person: Person): string {
  return person.behaviors
    .flatMap((behavior) => [behavior.name, ...behavior.instructions])
    .join("\n");
}

function portraitCue(person: Person): string {
  return [person.summary, person.personality ?? "", person.relationship ?? "", ...person.interests].join("\n");
}

function shortTalk(person: Person, event: ScriptEvent): boolean {
  const cue = `${behaviorCue(person)}\n${event.tone ?? ""}`;
  return /很少|点头|一句|短句|少说/.test(cue);
}

function likesCorrect(person: Person): boolean {
  return /改口|纠正|说死|说满|说清楚/.test(behaviorCue(person));
}

function likesAnime(person: Person): boolean {
  return /动漫|追番|手办/.test(portraitCue(person));
}

function justBrokeUp(person: Person): boolean {
  return /分手/.test(portraitCue(person));
}

function gadgetBallGuy(person: Person): boolean {
  const cue = portraitCue(person);
  return person.gender === "男" && /篮球/.test(cue) && /电子产品/.test(cue);
}

function constraintText(event: ScriptEvent): string {
  return [event.intent ?? "", event.tone ?? "", ...(event.constraints ?? [])].join(" ");
}

/**
 * 探索时按人群画像 + 相处说法 + 本拍 intent/tone/constraints 生成一句中文。
 * 与剧本冲突时以本拍为准。禁止用于回归。
 */
export function generateUserLine(person: Person, event: ScriptEvent, mode: RunMode): string {
  if (mode === "replay") {
    throw new Error("回归跑法禁止调用仿真 agent");
  }
  if (event.kind !== "speak") {
    throw new Error("仿真 agent 只为 speak 生成台词");
  }

  const brief = shortTalk(person, event);
  const cue = constraintText(event);

  if (cue.includes("咖啡") && (cue.includes("告知") || cue.includes("不建议") || cue.includes("偏好") || cue.includes("晚上"))) {
    if (likesCorrect(person) && likesAnime(person)) {
      return "晚上别建议我喝咖啡，我会睡不着，还要追番。这不是少喝，是不要。";
    }
    if (likesCorrect(person)) return "晚上别建议我喝咖啡，我会睡不着。这不是少喝，是不要。";
    return brief ? "晚上别建议咖啡。" : "晚上别建议我喝咖啡，我会睡不着。";
  }

  if (cue.includes("提神") || cue.includes("换说法")) {
    return brief ? "困了，怎么提神？" : "早上有点困，有什么提神的？";
  }

  if (cue.includes("灯") || cue.includes("做不到")) {
    return "去把隔壁房间的灯关了。";
  }

  if (cue.includes("改口") || cue.includes("纠正")) {
    return likesCorrect(person)
      ? "更正一下：我晚上是完全不喝咖啡，不是少喝。"
      : "更正一下，刚才那句以这个为准。";
  }

  if (cue.includes("请勿打扰") || cue.includes("不要主动") || cue.includes("别找我")) {
    return brief ? "别主动找我。" : "这段时间别主动找我。";
  }

  if (cue.includes("低落") || cue.includes("不要向对方要建议") || cue.includes("先不要给建议") || cue.includes("别给办法")) {
    if (justBrokeUp(person)) return "今天有点难受。先陪我就好，不要给建议。";
    return brief ? "今天有点难受。先不要给建议。" : "今天心情不好，先别给我建议。";
  }

  if (gadgetBallGuy(person)) {
    if (cue.includes("自我介绍") || cue.includes("刚加上")) {
      return brief
        ? "刚毕业，爱打篮球，也爱折腾数码。"
        : "嗨，刚毕业没几年，平时爱打篮球，最近还在看新耳机。你平时怎么玩？";
    }
    if (cue.includes("互相熟悉") || cue.includes("对方的日常")) {
      return brief
        ? "你下班一般都干啥？"
        : "那你平时下班都干啥？我这边就打球、刷数码评测，挺想多了解你一点。";
    }
    if (cue.includes("见面约会") || cue.includes("主动提出见面")) {
      return brief
        ? "周末出来打球？"
        : "这周周末要不要出来打一场？打完再去逛一圈数码店。";
    }
    if (cue.includes("身边") || cue.includes("小事")) {
      return brief
        ? "下班路过球场，看了会儿三对三。"
        : "今天下班路过球场，有人在打三对三，我站那儿看了半天。你今天身边有啥好玩的？";
    }
    if (cue.includes("聊篮球") || cue.includes("新入手") || cue.includes("电子产品")) {
      return brief
        ? "今晚投了会儿篮，还在看新耳机。"
        : "今晚去球场投了会儿，回来还在纠结要不要下手一副新耳机。你最近在玩啥？";
    }
  }

  const intent = event.intent?.trim() ?? "";
  if (intent !== "") {
    return brief ? `${intent}。` : `我说一下：${intent}。`;
  }

  return brief ? "嗯。" : "我想说一句。";
}
