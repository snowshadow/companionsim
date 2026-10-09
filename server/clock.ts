/**
 * 会话内时间标注。本版没有假时钟：产品侧还没有可注入时钟的通道，
 * 所以这里只负责给记录和剧本一个先后顺序，不去改被测读到的「现在」。
 * 谁都不准另开墙上时钟——时间只从剧本事件来。
 */
export type ClockReader = {
  hhmm: () => string;
  label: () => string;
  hour: () => number;
};

export const CLOCK_HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isHhmm(value: string): boolean {
  return CLOCK_HHMM.test(value);
}

export function createClock(): ClockReader & { set: (hhmm: string) => void } {
  let hhmm = "00:00";
  return {
    set(next: string) {
      hhmm = next;
    },
    hhmm: () => hhmm,
    label: () => hhmm,
    hour: () => {
      const n = Number.parseInt(hhmm.slice(0, 2), 10);
      return Number.isFinite(n) ? n : 0;
    },
  };
}
