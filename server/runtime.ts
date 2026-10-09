import { withRuntimeConfiguration } from "./config-center";
import type {
  Actor,
  Person,
  QueueStatus,
  Run,
  RunTokenUsage,
  Script,
  ScriptEvent,
  Snapshot,
  StartHuntRequest,
  StartReplayRequest,
  SutSnapshot,
  SutTransport,
  TokenUsage,
  UserGenerationRecord,
  UserGeneratorConfigSnapshot,
  JudgeConfigSnapshot,
  RejudgeRequest,
  RequestTrace,
  Turn,
} from "../shared/schema";
import { phaseOf } from "../shared/run-state";
import { createClock } from "./clock";
import { generateUserLine } from "./fake-user";
import { generateUserLineLLM, UserGeneratorError } from "./fake-user-llm";
import { SutRequestError } from "./sut-common";
import { captureUserGeneratorConfig, userGeneratorHeaders } from "./fake-user-config";
import { checkFacts } from "./facts";
import {
  trackJob,
  withNamedLock,
  withRunIdLock,
  withRunLock,
} from "./jobs";
import { personFile, runFile, scriptFile, snapshotFile } from "./paths";
import { captureJudgeConfig, hashEvidence } from "./judge-config";
import {
  checkQuota,
  estimateHuntTokens,
  estimateReplayTokens,
  quotaSettings,
  recordRunStart,
  recordRunUsage,
} from "./quota";
import { executeJudge, judgeInput, JUDGE_TIMEOUT_MS } from "./judge";
import { freezeHuntRun } from "./snapshot";
import {
  listJsonFiles,
  nextNumberedId,
  parseIdVersionStem,
  readJson,
  readJsonIfExists,
  writeJson,
} from "./store";
import {
  concurrencyKeyOf,
  memoryDomainOf,
  resolveSut as resolveSutConnection,
  type SutBrain,
  type SutEffect,
} from "./sut";
import {
  isRecord,
  parsePerson,
  parseScript,
  parseSnapshotFile,
} from "./validate";

export type ApiFail = {
  ok: false;
  status: number;
  error: string;
  errors?: string[];
};
export type ApiOk<T> = { ok: true; value: T };
export type ApiResult<T> = ApiOk<T> | ApiFail;

const NO_REPLAY = "没有快照，不能回归对比。没有冻结台词的剧本不能做版本对比。";
const NO_FREEZE_REPLAY = "回归局不会再冻结";

function fail(status: number, error: string, errors?: string[]): ApiFail {
  return errors && errors.length > 0
    ? { ok: false, status, error, errors }
    : { ok: false, status, error };
}

/**
 * 配额主体：人的登录身份，或 key 的主人。超级管理员没有 users 记录，
 * 记在一个固定主体上，避免无人认账。
 */
export function quotaSubjectOf(actor: Actor | undefined): string | undefined {
  if (!actor) return undefined;
  if (actor.userId) return actor.userId;
  if (actor.kind === "superadmin") return "superadmin";
  return undefined;
}

function mergeRunUsage(
  current: RunTokenUsage | undefined,
  usage: TokenUsage,
): RunTokenUsage {
  const next: RunTokenUsage = current
    ? {
        promptTokens: current.promptTokens + usage.promptTokens,
        completionTokens: current.completionTokens + usage.completionTokens,
        totalTokens: current.totalTokens + usage.totalTokens,
        source:
          current.source === "reported" && usage.source === "reported"
            ? "reported"
            : "estimated",
        byPhase: { ...current.byPhase },
      }
    : {
        // 第一次记账：从这一笔用量起算，别从全零起算（那样汇总会永远是 0）。
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        source: usage.source,
        byPhase: { simAgent: 0, judge: 0 },
      };
  return next;
}

/**
 * 记一局的用量：写进 Run（给人看）并累加到当日配额（用于拦截）。
 * 记账失败不拖垮正在跑的局——配额是账本，不是裁判。
 */
async function chargeRunUsage(
  run: Run,
  usage: TokenUsage | undefined,
  phase: "simAgent" | "judge",
): Promise<void> {
  if (!usage) return;
  const merged = mergeRunUsage(run.tokenUsage, usage);
  merged.byPhase[phase] += usage.totalTokens;
  run.tokenUsage = merged;
  const subject = quotaSubjectOf(run.createdBy);
  if (!subject) return;
  try {
    await recordRunUsage(subject, usage);
  } catch (err) {
    console.warn(
      `[quota] 用量记账失败（不影响本局）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export async function collectScriptIds(
  extra: string[] = [],
): Promise<Set<string>> {
  const ids = new Set(extra);
  for (const file of await listJsonFiles("scripts")) {
    const parsed = parseIdVersionStem(file.stem);
    if (parsed) ids.add(parsed.id);
  }
  return ids;
}

export async function collectPeopleBrief(): Promise<
  { id: string; expectedDiff: string }[]
> {
  const out: { id: string; expectedDiff: string }[] = [];
  for (const file of await listJsonFiles("people")) {
    try {
      const raw = await readJson(file.absPath);
      if (
        isRecord(raw) &&
        typeof raw.id === "string" &&
        typeof raw.expectedDiff === "string"
      ) {
        out.push({ id: raw.id, expectedDiff: raw.expectedDiff });
      }
    } catch {
      // 无效文件由 catalog 记入 issues
    }
  }
  return out;
}

export async function loadPerson(
  id: string,
  version: string,
): Promise<ApiResult<Person>> {
  const abs = personFile(id, version);
  const raw = await readJsonIfExists(abs);
  if (raw === undefined) {
    return fail(400, `找不到人群 ${id}@${version}，不准改用最新版`);
  }
  const parsed = parsePerson(raw, {
    scriptIds: await collectScriptIds(),
    otherPeople: await collectPeopleBrief(),
    fileStem: `${id}@${version}`,
  });
  if (!parsed.ok) return fail(400, "人群校验失败，不准跑", parsed.errors);
  return { ok: true, value: parsed.value };
}

export async function loadScript(
  id: string,
  version: string,
): Promise<ApiResult<Script>> {
  const abs = scriptFile(id, version);
  const raw = await readJsonIfExists(abs);
  if (raw === undefined) {
    return fail(400, `找不到剧本 ${id}@${version}，不准改用最新版`);
  }
  const parsed = parseScript(raw, {
    fileStem: `${id}@${version}`,
  });
  if (!parsed.ok) return fail(400, "剧本校验失败，不准跑", parsed.errors);
  return { ok: true, value: parsed.value };
}

export async function loadSnapshot(id: string): Promise<ApiResult<Snapshot>> {
  const abs = snapshotFile(id);
  const raw = await readJsonIfExists(abs);
  if (raw === undefined) return fail(400, NO_REPLAY);
  const parsed = parseSnapshotFile(raw, id);
  if (!parsed.ok) return fail(400, "快照文件无效，不能回归对比", parsed.errors);
  return { ok: true, value: parsed.value };
}

function appendEffect(
  turns: Turn[],
  eventId: string,
  effect: SutEffect,
  context: Pick<Turn, "simulationTime" | "requestTraceId"> = {},
): void {
  const recordedAt = new Date().toISOString();
  effect.memoryLogs.forEach((text, index) => {
    turns.push({
      id: `memory-${eventId}-${index}`,
      kind: "memory",
      text,
      eventId,
      recordedAt,
      ...context,
    });
  });
  if (effect.reply) {
    turns.push({
      id: `agent-${eventId}`,
      kind: "agent",
      text: effect.reply,
      eventId,
      recordedAt,
      ...context,
    });
  }
  effect.proactive.forEach((text, index) => {
    turns.push({
      id: `proactive-${eventId}-${index}`,
      kind: "proactive",
      text,
      eventId,
      recordedAt,
      ...context,
    });
  });
}

function hydrateRun(raw: unknown): Run | undefined {
  if (!isRecord(raw) || typeof raw.id !== "string") return undefined;
  const run = raw as Run;
  if (run.phase !== "running" && run.phase !== "failed") {
    run.phase = "done";
  }
  return run;
}

function snapshotRun(run: Run): Run {
  return structuredClone(run);
}

function seedRun(input: {
  id: string;
  mode: "hunt" | "replay";
  actor?: Actor;
  person: Person;
  script: Script;
  snapshot?: Snapshot;
  sut: SutSnapshot;
  createdAt: string;
  userGenerator: Run["userGenerator"];
  generatorSnapshot?: UserGeneratorConfigSnapshot;
  memoryDomain?: string;
  memorySequence?: number;
  priorRunIds?: string[];
  concurrencyKey?: string;
}): Run {
  return {
    id: input.id,
    mode: input.mode,
    status: "pending",
    createdAt: input.createdAt,
    ...(input.actor ? { createdBy: input.actor } : {}),
    phase: "running",
    stage: "dialogue",
    dialogueStatus: "running",
    evaluationStatus: "pending",
    dialogueStartedAt: new Date().toISOString(),
    personSnapshot: structuredClone(input.person),
    scriptSnapshot: structuredClone(input.script),
    sutSnapshot: structuredClone(input.sut),
    userGenerator: input.userGenerator,
    // 新开局一律第 3 代；旧文件由 runGeneration() 推导。
    generation: 3,
    ...(input.memoryDomain ? { memoryDomain: input.memoryDomain } : {}),
    ...(input.concurrencyKey ? { concurrencyKey: input.concurrencyKey } : {}),
    ...(input.memorySequence ? { memorySequence: input.memorySequence } : {}),
    ...(input.priorRunIds?.length ? { priorRunIds: input.priorRunIds } : {}),
    ...(input.generatorSnapshot
      ? { generatorSnapshot: structuredClone(input.generatorSnapshot) }
      : {}),
    generations: [],
    requests: [],
    evaluations: [],
    decisions: [],
    eventTotal: input.script.events.length,
    eventDone: 0,
    personId: input.person.id,
    personVersion: input.person.version,
    personName: input.person.name,
    scriptId: input.script.id,
    scriptVersion: input.script.version,
    scriptName: input.script.name,
    snapshotId: input.snapshot?.id,
    sutId: input.sut.id,
    sutName: input.sut.name,
    sutTransport: input.sut.transport,
    sutCaps: input.sut.caps,
    clock: "—",
    presence: "available",
    turns: [],
    facts: [],
    scores: [],
    memories: [],
    inbox: [],
  };
}

async function saveRun(run: Run): Promise<void> {
  await withRunLock(run.id, async () => {
    const current = await readJsonIfExists(runFile(run.id));
    if (isRecord(current)) {
      // Evaluation completion must never overwrite concurrent human decisions.
      if (Array.isArray(current.decisions) && current.decisions.length > 0) {
        run.decisions = structuredClone(current.decisions) as Run["decisions"];
        run.status = current.status as QueueStatus;
        if (typeof current.snapshotId === "string")
          run.snapshotId = current.snapshotId;
      }
      if (typeof current.reviewNote === "string")
        run.reviewNote = current.reviewNote;
      if (typeof current.reviewedAt === "string")
        run.reviewedAt = current.reviewedAt;
    }
    await writeJson(runFile(run.id), run);
  });
}

function finishRunTiming(run: Run, runStarted?: number): void {
  if (!run.completedAt) {
    run.completedAt = new Date().toISOString();
    if (runStarted !== undefined)
      run.durationMs = performance.now() - runStarted;
  }
}

async function failRun(
  run: Run,
  error: string,
  runStarted?: number,
): Promise<void> {
  run.phase = "failed";
  if (run.stage === "dialogue") run.dialogueStatus = "failed";
  run.error = error;
  finishRunTiming(run, runStarted);
  await saveRun(run);
}

async function evaluateRun(
  run: Run,
  config: JudgeConfigSnapshot | undefined,
  configError?: string,
  runStarted?: number,
  actor?: Actor,
): Promise<void> {
  const started = performance.now();
  const attempts = (run.evaluations ??= []);
  const number = attempts.length + 1;
  const attempt: NonNullable<Run["evaluations"]>[number] = {
    timeoutMs: JUDGE_TIMEOUT_MS,
    id: `${run.id}-judge-${number}`,
    number,
    status: "running",
    startedAt: new Date().toISOString(),
    ...(actor ? { attemptedBy: actor } : {}),
    config: config
      ? { ...structuredClone(config), inputHash: hashEvidence(judgeInput(run)) }
      : undefined,
  };
  attempts.push(attempt);
  run.phase = "running";
  run.stage = "judging";
  run.evaluationStatus = "running";
  delete run.error;
  await saveRun(run);
  try {
    if (!attempt.config)
      throw new Error(configError || "评审未配置，请设置后仅重试评审");
    if (config?.inputHash && config.inputHash !== attempt.config.inputHash)
      throw new Error("评审输入与原始记录不一致，不能覆盖原结论");
    const reply = await executeJudge(attempt.config, run, {
      timeoutMs: attempt.timeoutMs,
    });
    attempt.result = reply.result;
    attempt.rawResult = reply.rawResult;
    attempt.evidenceConstraints = reply.constraints;
    attempt.requestId = reply.requestId;
    attempt.returnedModel = reply.returnedModel;
    if (reply.usage) attempt.usage = reply.usage;
    attempt.status = "done";
    run.evaluationStatus = "done";
    run.phase = "done";
    run.stage = "complete";
  } catch (err) {
    attempt.status = "failed";
    attempt.error = err instanceof Error ? err.message : "评审失败";
    run.evaluationStatus = "failed";
    run.phase = "failed";
    run.error = attempt.error;
  }
  if (attempt.status === "done") await chargeRunUsage(run, attempt.usage, "judge");
  attempt.completedAt = new Date().toISOString();
  attempt.durationMs = performance.now() - started;
  finishRunTiming(run, runStarted);
  await saveRun(run);
}

export async function retryJudgeRun(
  id: string,
  body: RejudgeRequest = {},
  actor?: Actor,
): Promise<ApiResult<Run>> {
  return withRunLock(id, async () => {
    const run = await getRun(id);
    if (!run) return fail(404, "未找到该局");
    if (run.phase === "running") return fail(409, "本局仍在运行或评审中");
    if (
      run.dialogueStatus
        ? run.dialogueStatus !== "done"
        : phaseOf(run) !== "done"
    )
      return fail(400, "对话未完成，不能评审");
    // A requested re-evaluation establishes this stage transition; old snapshots/times remain absent.
    run.dialogueStatus ??= "done";
    let config: JudgeConfigSnapshot | undefined;
    let error: string | undefined;
    const previous = run.evaluations?.at(-1)?.config;
    try {
      config = body.settings
        ? await captureJudgeConfig(body.settings)
        : previous
          ? structuredClone(previous)
          : await captureJudgeConfig();
    } catch (err) {
      error = err instanceof Error ? err.message : "评审配置无效";
    }
    // Reserve before launching; a concurrent retry sees running and cannot duplicate it.
    run.phase = "running";
    run.stage = "judging";
    run.evaluationStatus = "running";
    delete run.error;
    await writeJson(runFile(id), run);
    const job = evaluateRun(run, config, error, undefined, actor).catch(
      async (err) =>
        failRun(run, err instanceof Error ? err.message : "评审意外中断"),
    );
    trackJob(run.id, job);
    return { ok: true, value: snapshotRun(run) };
  });
}

/**
 * 探索的一拍台词。配置了 LLM 就必须用 LLM：失败整局停下，
 * 不用模板顶替，否则一局里混两种生成器，判卷没法归因。
 */
async function huntUserLine(
  run: Run,
  person: Person,
  event: ScriptEvent,
  simulationTime: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const snapshot = run.generatorSnapshot;
  if (!snapshot) {
    return { ok: true, text: generateUserLine(person, event, "hunt") };
  }
  const priorTurns = run.turns
    .filter((turn) => turn.kind === "user" || turn.kind === "agent")
    .slice(-(snapshot.priorTurnsLimit ?? 12))
    .map((turn) => ({
      role: turn.kind === "user" ? ("user" as const) : ("agent" as const),
      text: turn.text,
    }));
  const startedAt = new Date().toISOString();
  try {
    // 凭据在调用时解析，可用轮换后的环境变量；地址与模型仍用本局冻结值。
    const headers = await userGeneratorHeaders(snapshot);
    const result = await generateUserLineLLM(
      snapshot,
      { person, event, simulationTime, priorTurns },
      { headers },
    );
    const record: UserGenerationRecord = {
      eventId: event.id,
      attempts: result.attempts,
      startedAt,
      finishedAt: new Date().toISOString(),
      latencyMs: result.latencyMs,
      outcome: "completed",
      ...(result.requestId ? { requestId: result.requestId } : {}),
      ...(result.returnedModel ? { returnedModel: result.returnedModel } : {}),
      ...(result.usage ? { usage: result.usage } : {}),
    };
    (run.generations ??= []).push(record);
    await chargeRunUsage(run, result.usage, "simAgent");
    return { ok: true, text: result.text };
  } catch (err) {
    const attempts = err instanceof UserGeneratorError ? err.attempts : 1;
    const latencyMs =
      err instanceof UserGeneratorError ? err.latencyMs : 0;
    const message = err instanceof Error ? err.message : "仿真 agent 失败";
    const record: UserGenerationRecord = {
      eventId: event.id,
      attempts,
      startedAt,
      finishedAt: new Date().toISOString(),
      latencyMs,
      outcome: "failed",
      error: message,
    };
    (run.generations ??= []).push(record);
    await saveRun(run);
    return {
      ok: false,
      error: `事件 ${event.id} 的仿真 agent 台词生成失败：${message}`,
    };
  }
}

/**
 * 一局所属的记忆域。memoryDomain 是后来才加的字段，旧局没有，
 * 所以按当时的被测快照反推——否则会把一个已经被写过多次的记忆域
 * 记成「首局、记忆干净」，那比不记还坏。
 */
function domainOfRun(raw: Record<string, unknown>): string | undefined {
  if (typeof raw.memoryDomain === "string" && raw.memoryDomain !== "")
    return raw.memoryDomain;
  const snap = isRecord(raw.sutSnapshot) ? raw.sutSnapshot : undefined;
  const transport = (snap?.transport ?? raw.sutTransport) as
    | SutTransport
    | undefined;
  const id =
    typeof snap?.id === "string"
      ? snap.id
      : typeof raw.sutId === "string"
        ? raw.sutId
        : undefined;
  if (!transport || !id) return undefined;
  const avatarId = typeof snap?.avatarId === "string" ? snap.avatarId : undefined;
  return memoryDomainOf({ id, transport, avatarId });
}

/**
 * 同域已跑过的局，按创建时间排序。用来写 memorySequence 与 priorRunIds：
 * 既然记忆无法隔离，至少让读者看得出这一局站在多少累积记忆之上。
 */
async function priorRunsInDomain(domain: string): Promise<string[]> {
  const files = await listJsonFiles("runs");
  const found: { id: string; createdAt: string }[] = [];
  for (const file of files) {
    try {
      const raw = await readJson(file.absPath);
      if (!isRecord(raw)) continue;
      if (typeof raw.id !== "string") continue;
      if (domainOfRun(raw) !== domain) continue;
      found.push({
        id: raw.id,
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "",
      });
    } catch {
      // 坏文件不影响排期
    }
  }
  found.sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
  return found.map((item) => item.id);
}

/**
 * 每局单独 openSut，会话互不共享。被测按支持多会话并发来对接。
 * 但共享记忆域的局必须串行，见 memoryDomainOf。
 */
async function executeDialogue(
  run: Run,
  person: Person,
  script: Script,
  snapshot: Snapshot | undefined,
  sut: SutBrain,
  clock: ReturnType<typeof createClock>,
  runStarted: number,
): Promise<void> {
  const dialogueStarted = performance.now();
  try {
    for (const event of script.events) {
      clock.set(event.clock);
      run.clock = clock.label();
      run.turns.push({
        id: `clock-${event.id}`,
        kind: "clock",
        eventId: event.id,
        simulationTime: clock.label(),
        recordedAt: new Date().toISOString(),
        text: `${clock.label()} · 会话内标注，不注入被测`,
      });

      if (event.kind === "leave") {
        run.turns.push({
          id: `event-${event.id}`,
          kind: "event",
          text: "离开会话",
          eventId: event.id,
          simulationTime: clock.label(),
          recordedAt: new Date().toISOString(),
        });
        appendEffect(run.turns, event.id, await sut.leave(), {
          simulationTime: clock.label(),
        });
      } else if (event.kind === "silence") {
        run.turns.push({
          id: `event-${event.id}`,
          kind: "event",
          text: "沉默",
          eventId: event.id,
          simulationTime: clock.label(),
          recordedAt: new Date().toISOString(),
        });
        appendEffect(run.turns, event.id, await sut.onSilence(), {
          simulationTime: clock.label(),
        });
      } else if (event.kind !== "speak") {
        run.dialogueDurationMs = performance.now() - dialogueStarted;
        await failRun(run, `事件 ${event.id} 的动作未登记，不准跑`, runStarted);
        return;
      } else {
        let userLine: string;
        if (run.mode === "replay") {
          const frozen = snapshot?.lines.find(
            (line) => line.eventId === event.id,
          );
          if (!frozen) {
            run.dialogueDurationMs = performance.now() - dialogueStarted;
            await failRun(
              run,
              `快照缺少事件 ${event.id} 的冻结台词，不能回归`,
              runStarted,
            );
            return;
          }
          userLine = frozen.user;
        } else {
          const generated = await huntUserLine(
            run,
            person,
            event,
            clock.label(),
          );
          if (!generated.ok) {
            run.dialogueDurationMs = performance.now() - dialogueStarted;
            await failRun(run, generated.error, runStarted);
            return;
          }
          userLine = generated.text;
        }

        const userTurn: Turn = {
          id: `user-${event.id}`,
          kind: "user",
          text: userLine,
          eventId: event.id,
          simulationTime: clock.label(),
          recordedAt: new Date().toISOString(),
        };
        run.turns.push(userTurn);
        await saveRun(run);
        const previousRequests = sut.requests().length;
        const captureRequests = (): RequestTrace | undefined => {
          const added = sut
            .requests()
            .slice(previousRequests)
            .map((request) => ({
              ...request,
              eventId: event.id,
              simulationTime: clock.label(),
            }));
          (run.requests ??= []).push(...added);
          const last = added.at(-1);
          if (last) userTurn.requestTraceId = last.id;
          return last;
        };
        try {
          const effect = await sut.handleUser(userLine);
          const request = captureRequests();
          appendEffect(run.turns, event.id, effect, {
            simulationTime: clock.label(),
            requestTraceId: request?.id,
          });
        } catch (err) {
          const request = captureRequests();
          // 两个适配器现在共用 SutRequestError，不必再猜字段。
          const partial = err instanceof SutRequestError ? err.partialReply : "";
          if (partial) {
            run.turns.push({
              id: `agent-${event.id}`,
              kind: "agent",
              text: partial,
              eventId: event.id,
              simulationTime: clock.label(),
              recordedAt: new Date().toISOString(),
              requestTraceId: request?.id,
            });
          }
          const message = err instanceof Error ? err.message : "被测对话失败";
          run.turns.push({
            id: `event-${event.id}-fail`,
            kind: "event",
            text: message,
            eventId: event.id,
            simulationTime: clock.label(),
            recordedAt: new Date().toISOString(),
          });
          run.dialogueDurationMs = performance.now() - dialogueStarted;
          await failRun(run, message, runStarted);
          return;
        }
      }

      run.eventDone = (run.eventDone ?? 0) + 1;
      await saveRun(run);
    }
  } catch (err) {
    run.dialogueDurationMs = performance.now() - dialogueStarted;
    await failRun(
      run,
      err instanceof Error ? err.message : "仿真对话中断",
      runStarted,
    );
    return;
  }

  if (phaseOf(run) === "failed") return;

  run.memories = sut.memories();
  run.inbox = sut.inbox();
  run.presence = sut.presence();
  run.clock = clock.label();
  run.facts = checkFacts({
    turns: run.turns,
    memories: run.memories,
    inbox: run.inbox,
    script,
    caps: sut.caps,
  });
  run.dialogueStatus = "done";
  run.dialogueCompletedAt = new Date().toISOString();
  run.dialogueDurationMs = performance.now() - dialogueStarted;
  await saveRun(run);
}

function launchRun(
  run: Run,
  person: Person,
  script: Script,
  snapshot: Snapshot | undefined,
  sut: SutBrain,
  clock: ReturnType<typeof createClock>,
  judgeConfig: JudgeConfigSnapshot | undefined,
  judgeConfigError: string | undefined,
  runStarted: number,
  actor?: Actor,
): void {
  // 记忆隔离靠每局独立仿真身份；并发限制来自被测账号本身（soulpals 只允许一个
  // 可写会话），所以按账号锁整段对话——锁单轮不够，轮与轮之间会被抢走会话。
  const dialogue = () =>
    executeDialogue(run, person, script, snapshot, sut, clock, runStarted);
  const job = (run.concurrencyKey
    ? withNamedLock(run.concurrencyKey, dialogue)
    : dialogue()
  )
    .then(async () => {
      // 对话失败时 executeDialogue 已经记过原因，不再评审。
      if (phaseOf(run) === "failed") return;
      await evaluateRun(run, judgeConfig, judgeConfigError, runStarted, actor);
    })
    .catch(async (err) => {
    await failRun(
      run,
      err instanceof Error ? err.message : "这一局意外中断",
      runStarted,
    );
  });
  trackJob(run.id, job);
}

function enqueueRun(input: Parameters<typeof enqueueRunWithConfig>[0]): Promise<ApiResult<Run>> {
  return withRuntimeConfiguration(() => enqueueRunWithConfig(input));
}

async function enqueueRunWithConfig(input: {
  mode: "hunt" | "replay";
  person: Person;
  script: Script;
  snapshot?: Snapshot;
  sutId: string | undefined;
  generator?: "llm" | "template";
  actor?: Actor;
}): Promise<ApiResult<Run>> {
  const runStarted = performance.now();
  const createdAt = new Date().toISOString();
  const clock = createClock();
  // 每局一个独立仿真身份：记忆域唯一，既不污染别的局也不被污染，因此可并行。
  const sut = await resolveSutConnection(input.sutId, clock, {
    isolatedIdentity: true,
  });
  if (!sut.ok) return sut;
  let judgeConfig: JudgeConfigSnapshot | undefined;
  let judgeConfigError: string | undefined;
  try {
    judgeConfig = await captureJudgeConfig();
  } catch (err) {
    judgeConfigError = err instanceof Error ? err.message : "评审未配置";
  }
  // 探索台词来源在开局冻结：配置了 LLM 就用 LLM，缺配置直接拒绝，不静默回退。
  let userGenerator: Run["userGenerator"] = "frozen";
  let generatorSnapshot: UserGeneratorConfigSnapshot | undefined;
  if (input.mode === "hunt") {
    if (input.generator === "template") {
      userGenerator = "template-v1";
    } else {
      try {
        generatorSnapshot = await captureUserGeneratorConfig();
        userGenerator = "llm-v1";
      } catch (err) {
        return fail(
          400,
          err instanceof Error ? err.message : "仿真 agent 未配置",
        );
      }
    }
  }
  // 开跑前预估用量并检查当日额度：超了就拒绝，并给出三个数（预估 / 已用 / 上限）。
  const quota = await quotaSettings();
  const estimatedTokens =
    input.mode === "hunt"
      ? estimateHuntTokens(
          input.script,
          generatorSnapshot?.priorTurnsLimit ?? 0,
          quota,
        )
      : estimateReplayTokens(input.script, quota);
  const subject = quotaSubjectOf(input.actor);
  const decision = await checkQuota(subject, estimatedTokens);
  if (!decision.ok) return fail(409, decision.error);

  const memoryDomain = memoryDomainOf(
    sut.value.snapshot,
    sut.value.snapshot.runtimeUserId,
  );
  const concurrencyKey = concurrencyKeyOf(sut.value.snapshot);
  const run = await withRunIdLock(async () => {
    const id = await nextNumberedId("runs", "r");
    const priorRunIds = memoryDomain
      ? await priorRunsInDomain(memoryDomain)
      : undefined;
    const seeded = seedRun({
      id,
      mode: input.mode,
      actor: input.actor,
      person: input.person,
      script: input.script,
      snapshot: input.snapshot,
      sut: sut.value.snapshot,
      createdAt,
      userGenerator,
      generatorSnapshot,
      memoryDomain,
      memorySequence: priorRunIds ? priorRunIds.length + 1 : undefined,
      priorRunIds,
      concurrencyKey,
    });
    await saveRun(seeded);
    return seeded;
  });
  if (subject) await recordRunStart(subject, estimatedTokens);
  launchRun(
    run,
    input.person,
    input.script,
    input.snapshot,
    sut.value.brain,
    clock,
    judgeConfig,
    judgeConfigError,
    runStarted,
    input.actor,
  );
  return { ok: true, value: snapshotRun(run) };
}

export async function startHunt(
  body: StartHuntRequest,
  options: { actor?: Actor } = {},
): Promise<ApiResult<Run>> {
  if (
    !body.personId ||
    !body.personVersion ||
    !body.scriptId ||
    !body.scriptVersion
  ) {
    return fail(400, "探索必须指定人群与剧本的 id 和 version");
  }
  const person = await loadPerson(body.personId, body.personVersion);
  if (!person.ok) return person;
  const script = await loadScript(body.scriptId, body.scriptVersion);
  if (!script.ok) return script;
  return enqueueRun({
    mode: "hunt",
    person: person.value,
    script: script.value,
    sutId: body.sutId,
    generator: body.generator ?? "llm",
    actor: options.actor,
  });
}

export async function startReplay(
  body: StartReplayRequest,
  options: { actor?: Actor } = {},
): Promise<ApiResult<Run>> {
  if (!body.snapshotId) return fail(400, NO_REPLAY);
  const snapshot = await loadSnapshot(body.snapshotId);
  if (!snapshot.ok) return snapshot;
  const snap = snapshot.value;
  const person: ApiResult<Person> = snap.personSnapshot
    ? { ok: true, value: snap.personSnapshot }
    : await loadPerson(snap.personId, snap.personVersion);
  if (!person.ok) return person;
  const script: ApiResult<Script> = snap.scriptSnapshot
    ? { ok: true, value: snap.scriptSnapshot }
    : await loadScript(snap.scriptId, snap.scriptVersion);
  if (!script.ok) return script;
  const speakEvents = script.value.events.filter(
    (event) => event.kind === "speak",
  );
  if (
    speakEvents.length !== snap.lines.length ||
    speakEvents.some(
      (event) =>
        !snap.lines.some(
          (line) =>
            line.eventId === event.id &&
            line.clock === event.clock,
        ),
    )
  ) {
    return fail(
      400,
      "剧本事件与冻结台词的时间或编号不一致，不能用当前内容冒充原始回归",
    );
  }
  return enqueueRun({
    mode: "replay",
    person: person.value,
    script: script.value,
    snapshot: snap,
    sutId: body.sutId,
    actor: options.actor,
  });
}

export async function listRuns(): Promise<Run[]> {
  const files = await listJsonFiles("runs");
  const runs: Run[] = [];
  for (const file of files) {
    try {
      const run = hydrateRun(await readJson(file.absPath));
      if (run) runs.push(run);
    } catch {
      // 坏文件不让列表挂掉
    }
  }
  runs.sort((a, b) => {
    const time = b.createdAt.localeCompare(a.createdAt);
    return time !== 0 ? time : b.id.localeCompare(a.id);
  });
  return runs;
}

export async function getRun(id: string): Promise<Run | undefined> {
  const raw = await readJsonIfExists(runFile(id));
  if (raw === undefined) return undefined;
  return hydrateRun(raw);
}

export async function decideRun(
  id: string,
  status: QueueStatus,
  reason = "",
  evidenceTurnIds: string[] = [],
  evaluationAttemptId?: string,
  actor?: Actor,
): Promise<ApiResult<Run>> {
  if (status !== "accepted" && status !== "rejected" && status !== "unclear") {
    return fail(400, "判定只能是纳入回归、驳回或无法判定");
  }
  return withRunLock(id, async () => {
    const run = await getRun(id);
    if (!run) return fail(404, "未找到该局");
    if (run.mode === "replay") return fail(400, NO_FREEZE_REPLAY);
    if (
      run.dialogueStatus
        ? run.dialogueStatus !== "done"
        : phaseOf(run) !== "done"
    )
      return fail(400, "对话未完成，不能判定");
    if (run.status !== "pending" && run.status !== "unclear")
      return fail(400, "本局已作最终判定");
    if (
      typeof reason !== "string" ||
      !Array.isArray(evidenceTurnIds) ||
      evidenceTurnIds.some(
        (turnId) =>
          typeof turnId !== "string" ||
          !run.turns.some((turn) => turn.id === turnId),
      )
    )
      return fail(400, "判定理由或发言引用无效");
    if (
      evaluationAttemptId &&
      !run.evaluations?.some((item) => item.id === evaluationAttemptId)
    )
      return fail(400, "指定的评审尝试不属于本局");
    if (status === "accepted") {
      await withRunIdLock(async () => {
        const snapshotId = await nextNumberedId("snapshots", "snap");
        const snap = freezeHuntRun(run, snapshotId);
        await writeJson(snapshotFile(snap.id), snap);
        run.snapshotId = snap.id;
      });
    }
    (run.decisions ??= []).push({
      status,
      reason: reason.trim(),
      evidenceTurnIds: [...new Set(evidenceTurnIds)],
      decidedAt: new Date().toISOString(),
      ...(actor ? { decidedBy: actor } : {}),
      evaluationAttemptId: evaluationAttemptId ?? run.evaluations?.at(-1)?.id,
    });
    run.status = status;
    await writeJson(runFile(id), run);
    return { ok: true, value: run };
  });
}

export async function markReplayReviewed(
  id: string,
  note: string,
  actor?: Actor,
): Promise<ApiResult<Run>> {
  return withRunLock(id, async () => {
    const run = await getRun(id);
    if (!run) return fail(404, "未找到该局");
    if (run.mode !== "replay") return fail(400, "只有回归结果可以标记查看");
    if (
      run.dialogueStatus
        ? run.dialogueStatus !== "done"
        : phaseOf(run) !== "done"
    )
      return fail(400, "对话未完成，不能确认查看");
    if (typeof note !== "string") return fail(400, "人工说明必须是文本");
    run.reviewNote = note.trim();
    run.reviewedAt = new Date().toISOString();
    if (actor) run.reviewedBy = actor;
    await writeJson(runFile(id), run);
    return { ok: true, value: run };
  });
}

/** 单场连续对话的时间跨度，例如 `20:18 → 21:40`。 */
export function scriptSpan(script: Script): string {
  if (script.events.length === 0) return "空";
  const first = script.events[0];
  const last = script.events[script.events.length - 1];
  if (first.clock === last.clock) return `${first.clock} 一场`;
  return `${first.clock} → ${last.clock}`;
}
