import type { Presence } from "../shared/schema";
import type { ClockReader } from "./clock";
import { emptyEffect, type SutEffect } from "./sut-common";

export type FixtureBrain = {
  injectClock: () => void;
  handleUser: (text: string) => SutEffect;
  onJump: () => SutEffect;
  onSilence: () => SutEffect;
  leave: () => SutEffect;
  presence: () => Presence;
  memories: () => string[];
  inbox: () => string[];
};

type MemoryEntry = {
  text: string;
  clock: string;
};

function mentionsCoffeeBan(text: string): boolean {
  return text.includes("咖啡") && (text.includes("别") || text.includes("不要"));
}

function asksTonic(text: string): boolean {
  return text.includes("提神") || (text.includes("困") && text.includes("什么"));
}

function asksLight(text: string): boolean {
  return text.includes("灯");
}

function declinesAdvice(text: string): boolean {
  return (
    text.includes("不要建议") ||
    text.includes("不要给建议") ||
    text.includes("别给我建议") ||
    text.includes("先不要")
  );
}

function isLowMood(text: string): boolean {
  return text.includes("难受") || text.includes("低落") || text.includes("心情不好");
}

function asksQuiet(text: string): boolean {
  return (
    text.includes("别主动") ||
    text.includes("不要主动") ||
    text.includes("别找我") ||
    text.includes("请勿打扰")
  );
}

function isMorning(clock: ClockReader): boolean {
  const hour = clock.hour();
  return hour >= 5 && hour < 12;
}

/**
 * 内置样例大脑：故意不完美，用来搜失败。不是产品大脑。
 * 「现在」只读假时钟。调度未接入，不要在这里假装到点任务跑过了。
 */
export function createFixtureBrain(clock: ClockReader): FixtureBrain {
  let presence: Presence = "available";
  const memoryEntries: MemoryEntry[] = [];
  const inbox: string[] = [];
  const memoryLines: string[] = [];
  let coffeeBan = false;
  let noAdvice = false;
  let askedQuiet = false;
  let sessionOpen = true;

  function remember(text: string, logs: string[]): void {
    const line = `写入 · ${text}（${clock.label()}）`;
    memoryEntries.push({ text, clock: clock.label() });
    memoryLines.push(line);
    logs.push(line);
  }

  function recall(query: string, logs: string[]): MemoryEntry | undefined {
    const hit = [...memoryEntries].reverse().find((entry) => {
      if (query.includes("咖啡") || query.includes("提神") || query.includes("美式")) {
        return entry.text.includes("咖啡");
      }
      return entry.text.includes(query) || query.includes(entry.text);
    });
    if (hit) {
      const line = `召回 · query「${query}」命中「${hit.text}」，已进上下文`;
      memoryLines.push(line);
      logs.push(line);
    }
    return hit;
  }

  return {
    injectClock() {
      // 内置样例把假时钟写进「现在」；调度仍未接入。
    },
    handleUser(text) {
      const effect = emptyEffect();
      sessionOpen = true;
      if (asksQuiet(text)) {
        askedQuiet = true;
        presence = "dnd";
      }
      if (mentionsCoffeeBan(text)) {
        coffeeBan = true;
        remember("晚间不建议咖啡", effect.memoryLogs);
        effect.reply = "好，我记住了。晚上想提神的话，我换别的。";
        return effect;
      }
      if (asksTonic(text)) {
        recall("提神", effect.memoryLogs);
        effect.reply = "喝杯美式很快就好。要不要我按你平时的浓度来？";
        return effect;
      }
      if (asksLight(text)) {
        effect.reply = "我关不了隔壁的灯。我可以陪你一起等，或者帮你记住明天请人看线路。";
        return effect;
      }
      if (declinesAdvice(text) || isLowMood(text)) {
        noAdvice = true;
        effect.reply =
          "我在。愿意的话可以慢慢说。那我们先列三件小事：洗个热水澡、写两句、早点睡。";
        return effect;
      }
      if (text.includes("改口") || text.includes("更正") || text.includes("完全不喝")) {
        if (text.includes("咖啡")) {
          coffeeBan = true;
          remember("晚间不建议咖啡（用户纠正后）", effect.memoryLogs);
        } else {
          remember(`用户纠正：${text}`, effect.memoryLogs);
        }
        effect.reply = "好，我按你刚才纠正的记。";
        return effect;
      }
      if (asksQuiet(text)) {
        effect.reply = "好，我先不打扰你。";
        return effect;
      }
      if (noAdvice) {
        effect.reply = "那我们先列三件小事：洗个热水澡、写两句、早点睡。";
        return effect;
      }
      effect.reply = "嗯，我在。";
      return effect;
    },
    onJump() {
      const effect = emptyEffect();
      const morning = isMorning(clock);
      if (coffeeBan && morning) {
        recall("咖啡", effect.memoryLogs);
        const msg = "早安。今天要不要来杯美式开始？";
        inbox.push(msg);
        effect.proactive.push(msg);
        return effect;
      }
      if (askedQuiet && morning) {
        const msg = "早安，新的一天。";
        inbox.push(msg);
        effect.proactive.push(msg);
        return effect;
      }
      return effect;
    },
    onSilence() {
      return emptyEffect();
    },
    leave() {
      sessionOpen = false;
      presence = askedQuiet ? "dnd" : presence;
      return emptyEffect();
    },
    presence: () => (sessionOpen ? presence : askedQuiet ? "dnd" : presence),
    memories: () => [...memoryLines],
    inbox: () => [...inbox],
  };
}
