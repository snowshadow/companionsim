import type { Run, Snapshot, SnapshotLine } from "../shared/schema";

/**
 * 从探索局用户句 + 当时假时钟冻结快照。回归局不得走这里。
 */
export function freezeHuntRun(run: Run, snapshotId: string): Snapshot {
  if (run.mode !== "hunt") {
    throw new Error("回归局不会再冻结");
  }
  if (
    run.dialogueStatus
      ? run.dialogueStatus !== "done"
      : run.phase === "running" || run.phase === "failed"
  ) {
    throw new Error("没跑完的局不能冻结");
  }
  const lines: SnapshotLine[] = [];
  let lastClock = run.clock;
  for (const turn of run.turns) {
    if (turn.kind === "clock") {
      const matched = turn.text.match(/假时钟\s+(D[123]\s+\d{2}:\d{2})/);
      if (matched) lastClock = matched[1];
    }
    if (turn.kind !== "user") continue;
    const eventId =
      turn.eventId ??
      (turn.id.startsWith("user-") ? turn.id.slice("user-".length) : turn.id);
    lines.push({
      eventId,
      clock: turn.simulationTime ?? lastClock,
      user: turn.text,
    });
  }
  return {
    id: snapshotId,
    personId: run.personId,
    personVersion: run.personVersion,
    scriptId: run.scriptId,
    scriptVersion: run.scriptVersion,
    sourceRunId: run.id,
    lines,
    ...(run.personSnapshot
      ? { personSnapshot: structuredClone(run.personSnapshot) }
      : {}),
    ...(run.scriptSnapshot
      ? { scriptSnapshot: structuredClone(run.scriptSnapshot) }
      : {}),
  };
}
