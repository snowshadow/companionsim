import { randomBytes } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import type { Role, User } from "../shared/schema";
import { execute, query } from "./db";

/**
 * 用户表。账号由管理员创建，或由启动时的首个管理员种子写入。
 * admin 只看 users.role。历史 feishu_* 列仍可读，新登录不再写入。
 */

type UserRow = RowDataPacket & {
  id: string;
  username: string | null;
  password_hash: string | null;
  feishu_open_id: string | null;
  feishu_union_id: string | null;
  name: string;
  avatar_url: string | null;
  email: string | null;
  role: Role;
  status: "active" | "disabled";
  created_at: Date;
  last_login_at: Date | null;
  login_count: number;
};

export class DuplicateUsernameError extends Error {
  constructor() {
    super("该用户名已存在");
    this.name = "DuplicateUsernameError";
  }
}

function toUser(row: UserRow): User {
  const user: User = {
    id: row.id,
    name: row.name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    loginCount: Number(row.login_count ?? 0),
  };
  if (row.username) user.username = row.username;
  if (row.feishu_open_id) user.feishuOpenId = row.feishu_open_id;
  if (row.feishu_union_id) user.feishuUnionId = row.feishu_union_id;
  if (row.avatar_url) user.avatarUrl = row.avatar_url;
  if (row.email) user.email = row.email;
  if (row.last_login_at) user.lastLoginAt = row.last_login_at.toISOString();
  return user;
}

function newUserId(): string {
  return `u-${randomBytes(6).toString("hex")}`;
}

function isDuplicateKey(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === "ER_DUP_ENTRY"
  );
}

export async function findUserById(id: string): Promise<User | undefined> {
  const rows = await query<UserRow>("SELECT * FROM users WHERE id = ?", [id]);
  return rows[0] ? toUser(rows[0]) : undefined;
}

export async function findLoginAccount(
  username: string,
): Promise<{ user: User; passwordHash: string | null } | undefined> {
  const rows = await query<UserRow>("SELECT * FROM users WHERE username = ?", [
    username,
  ]);
  const row = rows[0];
  if (!row) return undefined;
  return { user: toUser(row), passwordHash: row.password_hash };
}

export async function createPasswordUser(input: {
  username: string;
  passwordHash: string;
  name: string;
  role: Role;
}): Promise<User> {
  const id = newUserId();
  const now = new Date();
  try {
    await execute(
      `INSERT INTO users
         (id, username, password_hash, name, role, status, created_at, login_count)
       VALUES (?, ?, ?, ?, ?, 'active', ?, 0)`,
      [id, input.username, input.passwordHash, input.name, input.role, now],
    );
  } catch (err) {
    if (isDuplicateKey(err)) throw new DuplicateUsernameError();
    throw err;
  }
  const created = await findUserById(id);
  if (!created) throw new Error("用户写入后读不回来");
  return created;
}

/**
 * 按配置里的用户名写入首个管理员。
 * 该用户名已属于别的 id 时更新那一行；否则固定用 id user-admin。
 * 密码哈希原样入库，不在这里重算。
 */
export async function ensureSeedAdmin(
  username: string,
  passwordHash: string,
): Promise<boolean> {
  const name = username.trim();
  const hash = passwordHash.trim();
  if (name === "" || hash === "") return false;
  const byName = await findLoginAccount(name);
  if (byName) {
    await execute(
      `UPDATE users
          SET password_hash = ?, name = ?, role = 'admin', status = 'active'
        WHERE id = ?`,
      [hash, name, byName.user.id],
    );
    return true;
  }
  const reserved = await findUserById("user-admin");
  if (reserved) {
    await execute(
      `UPDATE users
          SET username = ?, password_hash = ?, name = ?, role = 'admin', status = 'active'
        WHERE id = ?`,
      [name, hash, name, reserved.id],
    );
    return true;
  }
  await execute(
    `INSERT INTO users
       (id, username, password_hash, name, role, status, created_at, login_count)
     VALUES ('user-admin', ?, ?, ?, 'admin', 'active', ?, 0)`,
    [name, hash, name, new Date()],
  );
  return true;
}

export async function recordLogin(id: string): Promise<void> {
  await execute(
    "UPDATE users SET last_login_at = ?, login_count = login_count + 1 WHERE id = ?",
    [new Date(), id],
  );
}

export async function listUsers(): Promise<User[]> {
  const rows = await query<UserRow>("SELECT * FROM users ORDER BY created_at ASC");
  return rows.map(toUser);
}

export async function setUserRole(
  id: string,
  role: Role,
): Promise<User | undefined> {
  await execute("UPDATE users SET role = ? WHERE id = ?", [role, id]);
  return findUserById(id);
}

export async function setUserStatus(
  id: string,
  status: "active" | "disabled",
): Promise<User | undefined> {
  await execute("UPDATE users SET status = ? WHERE id = ?", [status, id]);
  return findUserById(id);
}

export function isAdminUser(user: User): boolean {
  return user.role === "admin";
}
