import {
  ACTIONS,
  FAMILIES,
  FORBIDDEN_FAMILIES,
  RETIRED_KINDS,
  type ActionKind,
  type FailureFamily,
} from "../shared/actions";
import type {
  Person,
  PersonBehavior,
  Script,
  ScriptEvent,
  Snapshot,
  SnapshotLine,
} from "../shared/schema";
import { isHhmm } from "./clock";

export type ParseOk<T> = { ok: true; value: T };
export type ParseFail = { ok: false; errors: string[] };
export type ParseResult<T> = ParseOk<T> | ParseFail;

export type PersonContext = {
  scriptIds: Iterable<string>;
  otherPeople: { id: string; expectedDiff: string }[];
  existingAtPath?: unknown;
  fileStem?: string;
};

export type ScriptContext = {
  existingAtPath?: unknown;
  fileStem?: string;
};

const ACTION_SET = new Set<string>(ACTIONS);
const FAMILY_SET = new Set<string>(FAMILIES);
const FORBIDDEN_FAMILY_SET = new Set<string>(FORBIDDEN_FAMILIES);
const DIALOGUE_KEYS = ["user", "lines", "dialogue"] as const;
const MAX_BEHAVIORS = 3;
const MAX_INTERESTS = 4;

function parseOptionalText(
  raw: unknown,
  label: string,
  errors: string[],
): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") {
    errors.push(`${label} 必须是非空字符串`);
    return undefined;
  }
  return raw.trim();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`).join(",")}}`;
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  return stableJson(a) === stableJson(b);
}

export function looksLikeSnapshot(payload: unknown): boolean {
  if (!isRecord(payload)) return false;
  if (typeof payload.sourceRunId === "string") return true;
  if (Array.isArray(payload.lines)) {
    const hasUserLine = payload.lines.some(
      (line) =>
        isRecord(line) &&
        typeof line.user === "string" &&
        typeof line.eventId === "string",
    );
    if (hasUserLine) return true;
  }
  if (
    typeof payload.personVersion === "string" &&
    typeof payload.scriptVersion === "string" &&
    Array.isArray(payload.lines)
  ) {
    return true;
  }
  return false;
}

function fail(errors: string[]): ParseFail {
  return { ok: false, errors };
}

function rejectPathTraversal(
  id: string,
  version: string,
  errors: string[],
): void {
  if (
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("@") ||
    id.includes("..")
  ) {
    errors.push("id 不得包含路径分隔符或 @");
  }
  if (
    version.includes("/") ||
    version.includes("\\") ||
    version.includes("@") ||
    version.includes("..")
  ) {
    errors.push("version 不得包含路径分隔符或 @");
  }
}

function checkOverwrite(
  existingAtPath: unknown | undefined,
  payload: unknown,
  errors: string[],
): void {
  if (existingAtPath === undefined) return;
  if (!jsonEqual(existingAtPath, payload)) {
    errors.push("同路径已有不同内容，必须换 version，禁止覆盖");
  }
}

function parseStringList(raw: unknown, label: string): ParseResult<string[]> {
  if (!Array.isArray(raw) || raw.length === 0) {
    return fail([`${label} 必须是非空字符串数组`]);
  }
  const items: string[] = [];
  for (const [index, item] of raw.entries()) {
    if (typeof item !== "string" || item.trim() === "") {
      return fail([`${label}[${index}] 必须是非空字符串`]);
    }
    items.push(item.trim());
  }
  return { ok: true, value: items };
}

function parseBehavior(
  raw: unknown,
  index: number,
): ParseResult<PersonBehavior> {
  if (!isRecord(raw)) return fail([`behaviors[${index}] 必须是对象`]);
  const errors: string[] = [];
  if (typeof raw.name !== "string" || raw.name.trim() === "") {
    errors.push(`behaviors[${index}] 缺少 name`);
  }
  const instructions = parseStringList(
    raw.instructions,
    `behaviors[${index}].instructions`,
  );
  if (!instructions.ok) errors.push(...instructions.errors);
  const violations = parseStringList(
    raw.violations,
    `behaviors[${index}].violations`,
  );
  if (!violations.ok) errors.push(...violations.errors);
  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    value: {
      name: (raw.name as string).trim(),
      instructions: instructions.ok ? instructions.value : [],
      violations: violations.ok ? violations.value : [],
    },
  };
}

export function snapshotSubmitErrors(kind: string, payload: unknown): string[] {
  const errors: string[] = [];
  if (kind === "snapshot") {
    errors.push("编排 Agent 不准手写快照，快照只能由人点「纳入回归」生成");
  }
  if (looksLikeSnapshot(payload)) {
    errors.push("payload 像冻结快照；编排 Agent 不准手写快照");
  }
  return errors;
}

export function parsePerson(
  payload: unknown,
  ctx: PersonContext,
): ParseResult<Person> {
  const errors: string[] = [];
  if (!isRecord(payload)) return fail(["人群必须是 JSON 对象"]);

  if (
    payload.family === "identity-other-person" ||
    FORBIDDEN_FAMILY_SET.has(String(payload.family ?? ""))
  ) {
    errors.push("人群禁止 family identity-other-person（家里另一个人）");
  }

  const id = payload.id;
  const name = payload.name;
  const version = payload.version;
  if (typeof id !== "string" || id.trim() === "") errors.push("人群 id 必填");
  if (typeof name !== "string" || name.trim() === "")
    errors.push("人群 name 必填");
  if (typeof version !== "string" || version.trim() === "")
    errors.push("人群 version 必填");
  if (payload.immutable !== true) errors.push("人群 immutable 必须为 true");

  const expectedDiff = payload.expectedDiff;
  if (typeof expectedDiff !== "string" || expectedDiff === "") {
    errors.push("人群 expectedDiff 非空");
  }

  if (
    !Array.isArray(payload.expectedDiffScripts) ||
    payload.expectedDiffScripts.length === 0
  ) {
    errors.push("人群 expectedDiffScripts 至少一项");
  }

  if ("fields" in payload) {
    errors.push(
      "不要用 fields 大口袋。年龄写 age，性别写 gender，兴趣写 interests。",
    );
  }

  const summary = payload.summary;
  if (typeof summary !== "string" || summary.trim() === "") {
    errors.push(
      "人群 summary 必填，写成能认出来的画像，例如「25岁年轻女性，单身，INTJ，喜欢动漫」",
    );
  }

  const age = payload.age;
  if (
    typeof age !== "number" ||
    !Number.isInteger(age) ||
    age < 18 ||
    age > 80
  ) {
    errors.push("人群 age 必须是 18～80 的整数");
  }

  const gender = payload.gender;
  if (typeof gender !== "string" || gender.trim() === "") {
    errors.push("人群 gender 必填");
  }

  const relationship = parseOptionalText(
    payload.relationship,
    "relationship",
    errors,
  );
  const personality = parseOptionalText(
    payload.personality,
    "personality",
    errors,
  );
  const occupation = parseOptionalText(
    payload.occupation,
    "occupation",
    errors,
  );

  let interests: string[] = [];
  const parsedInterests = parseStringList(payload.interests, "interests");
  if (!parsedInterests.ok) {
    errors.push(...parsedInterests.errors);
  } else if (parsedInterests.value.length > MAX_INTERESTS) {
    errors.push(`interests 至多 ${MAX_INTERESTS} 项`);
  } else {
    interests = parsedInterests.value;
  }

  if (
    typeof summary === "string" &&
    typeof age === "number" &&
    Number.isInteger(age) &&
    !summary.includes(`${age}岁`)
  ) {
    errors.push(
      "summary 必须写出年龄，例如「25岁年轻女性，单身，INTJ，喜欢动漫」",
    );
  }

  if (typeof id === "string" && typeof version === "string") {
    rejectPathTraversal(id, version, errors);
    const stem = `${id}@${version}`;
    if (ctx.fileStem && ctx.fileStem !== stem) {
      errors.push(`写入路径必须是 ${stem}.json，且与内容 id/version 一致`);
    }
  }

  const scriptIds = new Set(ctx.scriptIds);
  const scriptRefs: string[] = [];
  if (Array.isArray(payload.expectedDiffScripts)) {
    for (const [index, ref] of payload.expectedDiffScripts.entries()) {
      if (typeof ref !== "string" || ref.trim() === "") {
        errors.push(`expectedDiffScripts[${index}] 必须是剧本 id`);
        continue;
      }
      scriptRefs.push(ref);
      if (!scriptIds.has(ref)) {
        errors.push(`expectedDiffScripts 中的「${ref}」找不到对应剧本`);
      }
    }
  }

  const behaviors: PersonBehavior[] = [];
  if (!Array.isArray(payload.behaviors)) {
    errors.push("人群 behaviors 必须是数组");
  } else if (payload.behaviors.length < 1) {
    errors.push("人群至少 1 条 behavior");
  } else if (payload.behaviors.length > MAX_BEHAVIORS) {
    errors.push(
      `人群至多 ${MAX_BEHAVIORS} 条 behavior；再多就该拆人或去改剧本`,
    );
  } else {
    const names = new Set<string>();
    for (const [index, raw] of payload.behaviors.entries()) {
      const parsed = parseBehavior(raw, index);
      if (!parsed.ok) {
        errors.push(...parsed.errors);
        continue;
      }
      if (names.has(parsed.value.name)) {
        errors.push(`behavior「${parsed.value.name}」重复`);
        continue;
      }
      names.add(parsed.value.name);
      behaviors.push(parsed.value);
    }
  }

  if (typeof expectedDiff === "string" && expectedDiff !== "") {
    for (const other of ctx.otherPeople) {
      if (typeof id === "string" && other.id === id) continue;
      if (other.expectedDiff === expectedDiff) {
        errors.push("两类人 expectedDiff 字符串完全相同，应合并，不准当两类");
        break;
      }
    }
  }

  if (errors.length > 0) return fail(errors);

  const person: Person = {
    id: id as string,
    name: name as string,
    version: version as string,
    immutable: true,
    summary: (summary as string).trim(),
    age: age as number,
    gender: (gender as string).trim(),
    interests,
    expectedDiff: expectedDiff as string,
    expectedDiffScripts: scriptRefs,
    behaviors,
  };
  if (relationship) person.relationship = relationship;
  if (personality) person.personality = personality;
  if (occupation) person.occupation = occupation;
  checkOverwrite(ctx.existingAtPath, person, errors);
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: person };
}


function parseEvent(raw: unknown, index: number): ParseResult<ScriptEvent> {
  const errors: string[] = [];
  if (!isRecord(raw)) return fail([`events[${index}] 必须是对象`]);
  for (const key of DIALOGUE_KEYS) {
    if (key in raw) {
      errors.push("剧本事件不得包含 user / lines / dialogue，台词不属于剧本");
      break;
    }
  }
  if (typeof raw.id !== "string" || raw.id === "")
    errors.push(`events[${index}] 缺少 id`);
  if (typeof raw.clock !== "string" || raw.clock === "") {
    errors.push(`事件 ${String(raw.id ?? index)} 必须带 clock`);
  }
  if (typeof raw.kind === "string" && raw.kind in RETIRED_KINDS) {
    errors.push(`事件 ${String(raw.id ?? index)}：${RETIRED_KINDS[raw.kind]}`);
  } else if (typeof raw.kind !== "string" || !ACTION_SET.has(raw.kind)) {
    errors.push(`事件 ${String(raw.id ?? index)} 的 kind 不在已登记动作表`);
  }
  if (raw.kind === "jump") {
    if (typeof raw.clock !== "string" || !isHhmm(raw.clock)) {
      errors.push(
        `事件 ${String(raw.id ?? index)} 必须带 clock（HH:MM）`,
      );
    }
  }
  if (raw.kind === "speak") {
    if (typeof raw.intent !== "string" || raw.intent.trim() === "") {
      errors.push(`说话事件 ${String(raw.id ?? index)} 必须有 intent`);
    }
  }
  if (raw.intent !== undefined && typeof raw.intent !== "string") {
    errors.push(`事件 ${String(raw.id ?? index)} 的 intent 必须是字符串`);
  }
  if (raw.tone !== undefined && typeof raw.tone !== "string") {
    errors.push(`事件 ${String(raw.id ?? index)} 的 tone 必须是字符串`);
  }
  if (raw.constraints !== undefined) {
    if (
      !Array.isArray(raw.constraints) ||
      raw.constraints.some((item) => typeof item !== "string")
    ) {
      errors.push(
        `事件 ${String(raw.id ?? index)} 的 constraints 必须是字符串数组`,
      );
    }
  }
  if (errors.length > 0) return fail(errors);
  const event: ScriptEvent = {
    id: raw.id as string,
    clock: raw.clock as string,
    kind: raw.kind as ActionKind,
  };
  if (typeof raw.intent === "string") event.intent = raw.intent;
  if (typeof raw.tone === "string" && raw.tone !== "") event.tone = raw.tone;
  if (
    Array.isArray(raw.constraints) &&
    raw.constraints.every((item) => typeof item === "string")
  ) {
    const constraints = raw.constraints.filter((item) => item.trim() !== "");
    if (constraints.length > 0) event.constraints = constraints;
  }
  return { ok: true, value: event };
}

export function parseScript(
  payload: unknown,
  ctx: ScriptContext,
): ParseResult<Script> {
  const errors: string[] = [];
  if (!isRecord(payload)) return fail(["剧本必须是 JSON 对象"]);

  if (looksLikeSnapshot(payload)) {
    errors.push("剧本不得携带冻结台词；台词不属于剧本");
  }
  for (const key of DIALOGUE_KEYS) {
    if (key in payload) {
      errors.push("剧本不得包含 user / lines / dialogue，台词不属于剧本");
      break;
    }
  }

  const id = payload.id;
  const name = payload.name;
  const version = payload.version;
  if (typeof id !== "string" || id.trim() === "") errors.push("剧本 id 必填");
  if (typeof name !== "string" || name.trim() === "")
    errors.push("剧本 name 必填");
  if (typeof version !== "string" || version.trim() === "")
    errors.push("剧本 version 必填");
  if (typeof id === "string" && typeof version === "string") {
    rejectPathTraversal(id, version, errors);
    const stem = `${id}@${version}`;
    if (ctx.fileStem && ctx.fileStem !== stem) {
      errors.push(`写入路径必须是 ${stem}.json，且与内容 id/version 一致`);
    }
  }

  const familyRaw = payload.family;
  if (FORBIDDEN_FAMILY_SET.has(String(familyRaw ?? ""))) {
    errors.push("剧本禁止 family identity-other-person（家里另一个人）");
  }
  if (typeof familyRaw !== "string" || !FAMILY_SET.has(familyRaw)) {
    errors.push("剧本 family 必须落在已登记失败家族");
  }

  if (!Array.isArray(payload.events)) {
    errors.push("剧本 events 必须是数组");
  }

  const events: ScriptEvent[] = [];
  if (Array.isArray(payload.events)) {
    if (payload.events.length === 0) errors.push("剧本至少要有一个事件");
    for (const [index, raw] of payload.events.entries()) {
      const parsed = parseEvent(raw, index);
      if (!parsed.ok) {
        errors.push(...parsed.errors);
        continue;
      }
      events.push(parsed.value);
    }
  }

  if (
    events.length > 0 &&
    typeof familyRaw === "string" &&
    FAMILY_SET.has(familyRaw)
  ) {
    // 单场连续时间：允许跨午夜（23:55 → 00:03 是合法的长夜对话），
    // 所以按「分钟 + 跨天取模」判，单拍跨度不得超过 12 小时——超过就说明是倒退或跳得太远。
    const minutesOf = (hhmm: string) =>
      Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
    for (let i = 1; i < events.length; i += 1) {
      let delta = minutesOf(events[i].clock) - minutesOf(events[i - 1].clock);
      if (delta < 0) delta += 24 * 60;
      if (delta > 12 * 60) {
        errors.push(
          `事件 ${events[i].id} 的 clock（${events[i].clock}）相对上一拍（${events[i - 1].clock}）倒退了，单场对话时间只能向前`,
        );
      }
    }
  }

  if (errors.length > 0) return fail([...new Set(errors)]);

  const script: Script = {
    id: id as string,
    name: name as string,
    version: version as string,
    family: familyRaw as FailureFamily,
    events,
  };
  checkOverwrite(ctx.existingAtPath, script, errors);
  if (errors.length > 0) return fail(errors);
  return { ok: true, value: script };
}

export function parseSnapshotFile(
  payload: unknown,
  fileStem?: string,
): ParseResult<Snapshot> {
  const errors: string[] = [];
  if (!isRecord(payload)) return fail(["快照必须是 JSON 对象"]);
  const keys = [
    "id",
    "personId",
    "personVersion",
    "scriptId",
    "scriptVersion",
    "sourceRunId",
  ] as const;
  for (const key of keys) {
    if (typeof payload[key] !== "string" || payload[key] === "") {
      errors.push(`快照缺少 ${key}`);
    }
  }
  if (!Array.isArray(payload.lines)) errors.push("快照 lines 必须是数组");
  const lines: SnapshotLine[] = [];
  if (Array.isArray(payload.lines)) {
    for (const [index, raw] of payload.lines.entries()) {
      if (!isRecord(raw)) {
        errors.push(`lines[${index}] 必须是对象`);
        continue;
      }
      if (
        typeof raw.eventId !== "string" ||
        typeof raw.clock !== "string" ||
        typeof raw.user !== "string"
      ) {
        errors.push(`lines[${index}] 必须包含 eventId、clock、user`);
        continue;
      }
      lines.push({ eventId: raw.eventId, clock: raw.clock, user: raw.user });
    }
  }
  if (fileStem && typeof payload.id === "string" && payload.id !== fileStem) {
    errors.push("快照文件名必须与内容 id 一致");
  }
  let personSnapshot: Person | undefined;
  let scriptSnapshot: Script | undefined;
  if (payload.personSnapshot !== undefined) {
    const raw = payload.personSnapshot;
    const parsed = parsePerson(raw, {
      scriptIds:
        isRecord(raw) && Array.isArray(raw.expectedDiffScripts)
          ? raw.expectedDiffScripts
          : [],
      otherPeople: [],
    });
    if (!parsed.ok) errors.push(...parsed.errors.map((e) => `人群快照：${e}`));
    else if (
      parsed.value.id !== payload.personId ||
      parsed.value.version !== payload.personVersion
    )
      errors.push("人群快照版本不匹配");
    else personSnapshot = parsed.value;
  }
  if (payload.scriptSnapshot !== undefined) {
    const parsed = parseScript(payload.scriptSnapshot, {});
    if (!parsed.ok) errors.push(...parsed.errors.map((e) => `剧本快照：${e}`));
    else if (
      parsed.value.id !== payload.scriptId ||
      parsed.value.version !== payload.scriptVersion
    )
      errors.push("剧本快照版本不匹配");
    else scriptSnapshot = parsed.value;
  }
  if (new Set(lines.map((line) => line.eventId)).size !== lines.length)
    errors.push("冻结台词的事件 id 重复");
  if (scriptSnapshot) {
    const speakEvents = scriptSnapshot.events.filter(
      (event) => event.kind === "speak",
    );
    if (
      speakEvents.length !== lines.length ||
      speakEvents.some(
        (event) =>
          !lines.some(
            (line) =>
              line.eventId === event.id &&
              line.clock === event.clock,
          ),
      )
    ) {
      errors.push("冻结台词必须逐一对应剧本的说话事件与仿真时间");
    }
  }
  if (errors.length > 0) return fail(errors);
  return {
    ok: true,
    value: {
      id: payload.id as string,
      personId: payload.personId as string,
      personVersion: payload.personVersion as string,
      scriptId: payload.scriptId as string,
      scriptVersion: payload.scriptVersion as string,
      sourceRunId: payload.sourceRunId as string,
      lines,
      ...(personSnapshot ? { personSnapshot } : {}),
      ...(scriptSnapshot ? { scriptSnapshot } : {}),
    },
  };
}
