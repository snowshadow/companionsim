import type { RowDataPacket } from "mysql2/promise";
import type { Actor } from "../shared/schema";
import { databaseConfigured, execute, query } from "./db";

/**
 * 操作人留痕。产物（人群 / 剧本）本身不改一个字段，谁添加的记在这里，
 * 目录接口按 target 取最后一条挂到视图上。
 *
 * 约定：要留痕的操作「先写审计再执行」，写失败就拒绝该操作
 * （配置变更、判定、纳入回归、配额调整属这类）。读操作不记。
 */

export const AUDIT_ACTIONS = [
  "auth.login",
  "auth.logout",
  "user.create",
  "user.role",
  "user.status",
  "key.create",
  "key.revoke",
  "artifact.submit",
  "run.start",
  "run.decide",
  "run.review",
  "run.rejudge",
  "config.update",
  "quota.adjust",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export type AuditEntry = {
  actor: Actor;
  action: AuditAction;
  /** 例：`person:p-001@v1`、`run:r-026`、`config:judge`、`key:<id>`、`quota:<userId>`。 */
  target: string;
  detail?: unknown;
  ip?: string;
  ua?: string;
};

let warnedNoDb = false;

/**
 * 没有数据库时审计降级为空操作（本地开发与用例）。
 * 配置了数据库却写不进去时照常抛错——「要留痕的操作先写审计再执行」靠这个保证。
 */
async function dbReady(): Promise<boolean> {
  if (await databaseConfigured()) return true;
  if (!warnedNoDb) {
    warnedNoDb = true;
    console.warn("[audit] 未配置数据库，操作人留痕不生效。生产环境请配置 config/platform.json。");
  }
  return false;
}

export function resetAuditWarning(): void {
  warnedNoDb = false;
}

export async function appendAudit(entry: AuditEntry): Promise<void> {
  if (!(await dbReady())) return;
  await execute(
    `INSERT INTO audit_log
       (at, actor_kind, actor_user_id, actor_name, actor_key_id, actor_key_name,
        action, target, detail, ip, ua)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      new Date(),
      entry.actor.kind,
      entry.actor.userId ?? null,
      entry.actor.name,
      entry.actor.keyId ?? null,
      entry.actor.keyName ?? null,
      entry.action,
      entry.target,
      entry.detail === undefined ? null : JSON.stringify(entry.detail),
      entry.ip ?? null,
      entry.ua ?? null,
    ],
  );
}

export type AuditRecord = {
  id: number;
  at: string;
  actor: Actor;
  action: string;
  target: string;
  detail?: unknown;
  ip?: string;
};

type AuditRow = RowDataPacket & {
  id: number;
  at: Date;
  actor_kind: Actor["kind"];
  actor_user_id: string | null;
  actor_name: string;
  actor_key_id: string | null;
  actor_key_name: string | null;
  action: string;
  target: string;
  detail: unknown;
  ip: string | null;
};

function toRecord(row: AuditRow): AuditRecord {
  const actor: Actor = { kind: row.actor_kind, name: row.actor_name };
  if (row.actor_user_id) actor.userId = row.actor_user_id;
  if (row.actor_key_id) actor.keyId = row.actor_key_id;
  if (row.actor_key_name) actor.keyName = row.actor_key_name;
  const record: AuditRecord = {
    id: Number(row.id),
    at: row.at.toISOString(),
    actor,
    action: row.action,
    target: row.target,
  };
  if (row.detail !== null && row.detail !== undefined) record.detail = row.detail;
  if (row.ip) record.ip = row.ip;
  return record;
}

export async function recentAudit(limit = 100): Promise<AuditRecord[]> {
  if (!(await dbReady())) return [];
  const capped = Math.min(Math.max(limit, 1), 500);
  const rows = await query<AuditRow>(
    "SELECT * FROM audit_log ORDER BY id DESC LIMIT ?",
    [capped],
  );
  return rows.map(toRecord);
}

/**
 * 按 target 取最后一次操作人，给人群 / 剧本列表显示「谁添加的」。
 * target 形如 `person:p-001@v1`；不存在的 target 就是「未记录」。
 */
export async function latestActorsByTarget(
  targets: string[],
): Promise<Map<string, { actor: Actor; at: string }>> {
  const out = new Map<string, { actor: Actor; at: string }>();
  if (targets.length === 0) return out;
  if (!(await dbReady())) return out;
  const placeholders = targets.map(() => "?").join(", ");
  const rows = await query<AuditRow>(
    `SELECT * FROM audit_log
      WHERE action = 'artifact.submit' AND target IN (${placeholders})
      ORDER BY id DESC`,
    targets,
  );
  for (const row of rows) {
    if (out.has(row.target)) continue;
    const record = toRecord(row);
    out.set(record.target, { actor: record.actor, at: record.at });
  }
  return out;
}
