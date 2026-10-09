import mysql from "mysql2/promise";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { ExecuteValues } from "mysql2";
import { platformConfig, platformConfigStatus } from "./platform-config";

/**
 * MySQL 连接池。平台自身的状态（用户、会话、Key、审计、配额）在库里；
 * 领域产物（人群 / 剧本 / 快照 / 跑局）仍然是文件，见 paths.ts 的说明。
 */

let pool: Pool | undefined;
let poolKey = "";

function keyOf(settings: {
  host: string;
  port: number;
  user: string;
  database: string;
}): string {
  return `${settings.user}@${settings.host}:${settings.port}/${settings.database}`;
}

/**
 * 数据库是否可用。缺 platform.json = 没有数据库（本地开发/用例），
 * 此时配额与审计降级为空操作；配置有误则大声抛错，不静默降级。
 */
export async function databaseConfigured(): Promise<boolean> {
  const status = await platformConfigStatus();
  if (status.state === "ok") return true;
  if (status.state === "invalid") throw new Error(status.error);
  return false;
}

export async function getPool(): Promise<Pool> {
  const config = await platformConfig();
  const key = keyOf(config.mysql);
  if (pool && poolKey === key) return pool;
  if (pool) await pool.end();
  pool = mysql.createPool({
    host: config.mysql.host,
    port: config.mysql.port,
    user: config.mysql.user,
    password: config.mysql.password,
    database: config.mysql.database,
    connectionLimit: config.mysql.connectionLimit,
    waitForConnections: true,
    charset: "utf8mb4_general_ci",
    timezone: "Z",
    supportBigNumbers: true,
    dateStrings: false,
  });
  poolKey = key;
  return pool;
}

export async function query<T extends RowDataPacket>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const active = await getPool();
  const [rows] = await active.query<T[]>(sql, params);
  return rows;
}

export async function execute(
  sql: string,
  params: unknown[] = [],
): Promise<{ affectedRows: number; insertId: number }> {
  const active = await getPool();
  const [result] = await active.execute(sql, params as ExecuteValues[]);
  const header = result as { affectedRows?: number; insertId?: number };
  return {
    affectedRows: header.affectedRows ?? 0,
    insertId: Number(header.insertId ?? 0),
  };
}

export async function withTransaction<T>(
  fn: (conn: PoolConnection) => Promise<T>,
): Promise<T> {
  const active = await getPool();
  const conn = await active.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {
      /* 连接已断时回滚也会失败，保留原始错误 */
    }
    throw err;
  } finally {
    conn.release();
  }
}

export type DbHealth = {
  ok: boolean;
  key: string;
  version?: string;
  error?: string;
};

/** 健康检查与就绪探针用：连不上不该让进程崩，只回状态。 */
export async function databaseHealth(): Promise<DbHealth> {
  let key = "";
  try {
    const config = await platformConfig();
    key = keyOf(config.mysql);
    const rows = await query<RowDataPacket & { version: string }>(
      "SELECT VERSION() AS version",
    );
    return { ok: true, key, version: rows[0]?.version };
  } catch (err) {
    return {
      ok: false,
      key,
      error: err instanceof Error ? err.message : "数据库连接失败",
    };
  }
}

export async function closePool(): Promise<void> {
  if (!pool) return;
  const active = pool;
  pool = undefined;
  poolKey = "";
  await active.end();
}
