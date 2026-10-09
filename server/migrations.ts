import { execute, query } from "./db";
import type { RowDataPacket } from "mysql2/promise";

/**
 * 建表迁移。按版本号顺序执行，已应用的跳过。
 * 改表就往后追加一条，不要改已发布的条目。
 */
export type Migration = { version: number; name: string; statements: string[] };

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "users-sessions-keys-audit-quota",
    statements: [
      `CREATE TABLE IF NOT EXISTS users (
        id VARCHAR(40) NOT NULL PRIMARY KEY,
        feishu_open_id VARCHAR(64) NULL,
        feishu_union_id VARCHAR(64) NULL,
        name VARCHAR(120) NOT NULL,
        avatar_url VARCHAR(500) NULL,
        email VARCHAR(200) NULL,
        role ENUM('admin','member') NOT NULL DEFAULT 'member',
        status ENUM('active','disabled') NOT NULL DEFAULT 'active',
        created_at DATETIME(3) NOT NULL,
        last_login_at DATETIME(3) NULL,
        login_count INT NOT NULL DEFAULT 0,
        UNIQUE KEY uniq_feishu_open_id (feishu_open_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS sessions (
        token_hash CHAR(64) NOT NULL PRIMARY KEY,
        user_id VARCHAR(40) NULL,
        kind ENUM('feishu','superadmin') NOT NULL,
        created_at DATETIME(3) NOT NULL,
        expires_at DATETIME(3) NOT NULL,
        last_seen_at DATETIME(3) NOT NULL,
        ip VARCHAR(64) NULL,
        ua VARCHAR(300) NULL,
        KEY idx_sessions_user (user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS api_keys (
        id VARCHAR(32) NOT NULL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        owner_user_id VARCHAR(40) NOT NULL,
        owner_name VARCHAR(120) NOT NULL,
        secret_hash CHAR(64) NOT NULL,
        prefix VARCHAR(24) NOT NULL,
        scopes VARCHAR(200) NOT NULL,
        created_at DATETIME(3) NOT NULL,
        created_by_kind VARCHAR(20) NOT NULL,
        created_by_name VARCHAR(120) NOT NULL,
        expires_at DATETIME(3) NULL,
        last_used_at DATETIME(3) NULL,
        last_used_ip VARCHAR(64) NULL,
        revoked_at DATETIME(3) NULL,
        revoked_by_name VARCHAR(120) NULL,
        KEY idx_api_keys_owner (owner_user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS audit_log (
        id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
        at DATETIME(3) NOT NULL,
        actor_kind VARCHAR(20) NOT NULL,
        actor_user_id VARCHAR(40) NULL,
        actor_name VARCHAR(120) NOT NULL,
        actor_key_id VARCHAR(32) NULL,
        actor_key_name VARCHAR(120) NULL,
        action VARCHAR(40) NOT NULL,
        target VARCHAR(200) NOT NULL,
        detail JSON NULL,
        ip VARCHAR(64) NULL,
        ua VARCHAR(300) NULL,
        KEY idx_audit_at (at),
        KEY idx_audit_target (target, at),
        KEY idx_audit_action (action, at)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS quota_daily (
        day DATE NOT NULL,
        user_id VARCHAR(40) NOT NULL,
        estimated_tokens BIGINT NOT NULL DEFAULT 0,
        actual_tokens BIGINT NOT NULL DEFAULT 0,
        prompt_tokens BIGINT NOT NULL DEFAULT 0,
        completion_tokens BIGINT NOT NULL DEFAULT 0,
        runs INT NOT NULL DEFAULT 0,
        PRIMARY KEY (day, user_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,

      `CREATE TABLE IF NOT EXISTS quota_overrides (
        user_id VARCHAR(40) NOT NULL PRIMARY KEY,
        daily_tokens BIGINT NOT NULL,
        updated_at DATETIME(3) NOT NULL,
        updated_by_name VARCHAR(120) NOT NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },
  {
    version: 2,
    name: "password-login",
    statements: [
      `ALTER TABLE users
        ADD COLUMN username VARCHAR(64) NULL,
        ADD COLUMN password_hash VARCHAR(200) NULL,
        ADD UNIQUE KEY uniq_username (username)`,
      `ALTER TABLE sessions
        MODIFY COLUMN kind ENUM('feishu','superadmin','password') NOT NULL`,
    ],
  },
];

export async function migrate(): Promise<number[]> {
  await execute(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      version INT NOT NULL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      applied_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  );
  const applied = new Set(
    (
      await query<RowDataPacket & { version: number }>(
        "SELECT version FROM schema_migrations",
      )
    ).map((row) => Number(row.version)),
  );
  const done: number[] = [];
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    for (const statement of migration.statements) await execute(statement);
    await execute(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
      [migration.version, migration.name, new Date()],
    );
    done.push(migration.version);
  }
  return done;
}

export function migrationCount(): number {
  return MIGRATIONS.length;
}
