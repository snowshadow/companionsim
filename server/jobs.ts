import { runFile } from "./paths";
import { listJsonFiles, readJson, writeJson } from "./store";
import { isRecord } from "./validate";

type JobsGlobal = typeof globalThis & {
  __simEvalRunJobs?: Map<string, Promise<void>>;
  __simEvalIdChain?: Promise<unknown>;
  __simEvalRecovered?: boolean;
  __simEvalRunLocks?: Map<string, Promise<unknown>>;
  __simEvalNamedLocks?: Map<string, Promise<unknown>>;
};

function jobs(): Map<string, Promise<void>> {
  const g = globalThis as JobsGlobal;
  if (!g.__simEvalRunJobs) g.__simEvalRunJobs = new Map();
  return g.__simEvalRunJobs;
}

/** 分配跑局 id 期间串行，避免并行开局抢到同一个编号。 */
export async function withRunIdLock<T>(fn: () => Promise<T>): Promise<T> {
  const g = globalThis as JobsGlobal;
  const prev = g.__simEvalIdChain ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  g.__simEvalIdChain = prev.then(() => held);
  await prev;
  try {
    return await fn();
  } finally {
    release();
  }
}

/**
 * 通用命名锁：同一个 key 上的任务一次只跑一个，不同 key 互不相干。
 * 用来表达「某个外部资源同一时刻只能被一个调用占用」。
 */
export async function withNamedLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const g = globalThis as JobsGlobal;
  const locks = (g.__simEvalNamedLocks ??= new Map());
  const prev = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = prev.then(() => held);
  locks.set(key, next);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === next) locks.delete(key);
  }
}

/**
 * 按记忆域串行：同一域内的对话一次只跑一个，保证记忆写入顺序确定。
 * 只用于对话段：评审不碰被测记忆，不该被这个锁拖住。
 */
export function withMemoryDomainLock<T>(
  domain: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withNamedLock(`memory-domain:${domain}`, fn);
}

export function trackJob(id: string, job: Promise<void>): void {
  const map = jobs();
  map.set(id, job);
  const cleanup = () => {
    if (map.get(id) === job) map.delete(id);
  };
  void job.then(cleanup, cleanup);
}

export async function withRunLock<T>(
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const g = globalThis as JobsGlobal;
  const locks = (g.__simEvalRunLocks ??= new Map());
  const previous = locks.get(id) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => held);
  locks.set(id, next);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(id) === next) locks.delete(id);
  }
}

/**
 * 进程重启后，磁盘上仍标 running 的局其实已经没人在跑。
 * HMR 不走这里：在跑的 Promise 挂在 globalThis 上。
 */
export async function recoverOrphanedRuns(): Promise<void> {
  const g = globalThis as JobsGlobal;
  if (g.__simEvalRecovered) return;
  g.__simEvalRecovered = true;
  const live = jobs();
  for (const file of await listJsonFiles("runs")) {
    let raw: unknown;
    try {
      raw = await readJson(file.absPath);
    } catch {
      continue;
    }
    if (!isRecord(raw) || typeof raw.id !== "string" || raw.phase !== "running")
      continue;
    if (live.has(raw.id)) continue;
    raw.phase = "failed";
    if (raw.stage === "judging") {
      raw.evaluationStatus = "failed";
      raw.error = "服务重启，评审中断；对话已保留，可仅重试评审";
      if (Array.isArray(raw.evaluations)) {
        const last: unknown = raw.evaluations.at(-1);
        if (isRecord(last) && last.status === "running") {
          last.status = "failed";
          last.error = raw.error;
          last.completedAt = new Date().toISOString();
        }
      }
    } else {
      if (raw.dialogueStatus) raw.dialogueStatus = "failed";
      raw.error = "服务重启，对话中断了";
    }
    await writeJson(runFile(raw.id), raw);
  }
}

/** Graceful shutdown waits for admitted jobs; the HTTP entrypoint bounds this wait. */
export async function waitForJobs(): Promise<void> {
  await Promise.allSettled([...jobs().values()]);
}
