import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import type { Actor } from "../shared/schema";
import { execute, query } from "./db";

/**
 * 给本地 Agent 用的 Key。明文只在创建响应里出现一次，库里只存 sha256。
 * 归属落在 key 主人身上——Agent 提交的产物因此能追到人。
 *
 * 权限有意留口：key 不能判定（纳入回归 / 驳回 / 无法判定）、不能改配置。
 * 「人只提意图、判卷、决定是否纳入回归」是骨架里的约定。
 */

export const KEY_SCOPES = ["read", "author", "run"] as const;
export type KeyScope = (typeof KEY_SCOPES)[number];

export type ApiKeyRecord = {
  id: string;
  name: string;
  ownerUserId: string;
  ownerName: string;
  prefix: string;
  scopes: KeyScope[];
  createdAt: string;
  createdByName: string;
  createdByKind: Actor["kind"];
  expiresAt?: string;
  lastUsedAt?: string;
  lastUsedIp?: string;
  revokedAt?: string;
  revokedByName?: string;
};

type KeyRow = RowDataPacket & {
  id: string;
  name: string;
  owner_user_id: string;
  owner_name: string;
  secret_hash: string;
  prefix: string;
  scopes: string;
  created_at: Date;
  created_by_kind: Actor["kind"];
  created_by_name: string;
  expires_at: Date | null;
  last_used_at: Date | null;
  last_used_ip: string | null;
  revoked_at: Date | null;
  revoked_by_name: string | null;
};

function toRecord(row: KeyRow): ApiKeyRecord {
  const record: ApiKeyRecord = {
    id: row.id,
    name: row.name,
    ownerUserId: row.owner_user_id,
    ownerName: row.owner_name,
    prefix: row.prefix,
    scopes: row.scopes
      .split(",")
      .map((item) => item.trim())
      .filter((item): item is KeyScope =>
        (KEY_SCOPES as readonly string[]).includes(item),
      ),
    createdAt: row.created_at.toISOString(),
    createdByName: row.created_by_name,
    createdByKind: row.created_by_kind,
  };
  if (row.expires_at) record.expiresAt = row.expires_at.toISOString();
  if (row.last_used_at) record.lastUsedAt = row.last_used_at.toISOString();
  if (row.last_used_ip) record.lastUsedIp = row.last_used_ip;
  if (row.revoked_at) record.revokedAt = row.revoked_at.toISOString();
  if (row.revoked_by_name) record.revokedByName = row.revoked_by_name;
  return record;
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** 形如 `simk_ab12cd34_<43 字符>`；只在创建时返回一次。 */
export function mintKey(): { id: string; secret: string; plain: string; prefix: string } {
  const id = randomBytes(4).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const plain = `simk_${id}_${secret}`;
  return { id, secret, plain, prefix: `simk_${id}_${secret.slice(0, 4)}` };
}

/**
 * `simk_<8 位 hex>_<secret>`。secret 是 base64url，**本身可能含下划线**，
 * 所以不能用 split("_")——按前两个下划线切。
 */
export function parseKey(plain: string): { id: string; secret: string } | undefined {
  const text = plain.trim();
  if (!text.startsWith("simk_")) return undefined;
  const second = text.indexOf("_", "simk_".length);
  if (second < 0) return undefined;
  const id = text.slice("simk_".length, second);
  const secret = text.slice(second + 1);
  if (!/^[0-9a-f]{8}$/.test(id)) return undefined;
  if (secret.length < 20 || !/^[A-Za-z0-9_-]+$/.test(secret)) return undefined;
  return { id, secret };
}

function secretMatches(secret: string, storedHash: string): boolean {
  const actual = Buffer.from(hashSecret(secret), "hex");
  const expected = Buffer.from(storedHash, "hex");
  if (actual.length !== expected.length || actual.length === 0) return false;
  return timingSafeEqual(actual, expected);
}

export async function createKey(input: {
  name: string;
  ownerUserId: string;
  ownerName: string;
  scopes: KeyScope[];
  expiresInDays?: number;
  actor: Actor;
}): Promise<{ record: ApiKeyRecord; plain: string }> {
  const { id, secret, plain, prefix } = mintKey();
  const now = new Date();
  const expiresAt =
    input.expiresInDays && input.expiresInDays > 0
      ? new Date(now.getTime() + input.expiresInDays * 86_400_000)
      : null;
  await execute(
    `INSERT INTO api_keys
       (id, name, owner_user_id, owner_name, secret_hash, prefix, scopes,
        created_at, created_by_kind, created_by_name, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name.trim(),
      input.ownerUserId,
      input.ownerName,
      hashSecret(secret),
      prefix,
      input.scopes.join(","),
      now,
      input.actor.kind,
      input.actor.name,
      expiresAt,
    ],
  );
  const rows = await query<KeyRow>("SELECT * FROM api_keys WHERE id = ?", [id]);
  return { record: toRecord(rows[0]), plain };
}

export async function listKeys(ownerUserId?: string): Promise<ApiKeyRecord[]> {
  const rows = ownerUserId
    ? await query<KeyRow>(
        "SELECT * FROM api_keys WHERE owner_user_id = ? ORDER BY created_at DESC",
        [ownerUserId],
      )
    : await query<KeyRow>("SELECT * FROM api_keys ORDER BY created_at DESC");
  return rows.map(toRecord);
}

export async function findKey(id: string): Promise<ApiKeyRecord | undefined> {
  const rows = await query<KeyRow>("SELECT * FROM api_keys WHERE id = ?", [id]);
  return rows[0] ? toRecord(rows[0]) : undefined;
}

/** 校验通过才算身份；失败一律当作未登录，不区分「不存在」与「已吊销」。 */
export async function verifyKey(
  plain: string,
  ip?: string,
): Promise<ApiKeyRecord | undefined> {
  const parsed = parseKey(plain);
  if (!parsed) return undefined;
  const rows = await query<KeyRow & { secret_hash: string }>(
    "SELECT * FROM api_keys WHERE id = ?",
    [parsed.id],
  );
  const row = rows[0];
  if (!row) return undefined;
  if (!secretMatches(parsed.secret, row.secret_hash)) return undefined;
  if (row.revoked_at) return undefined;
  if (row.expires_at && row.expires_at.getTime() <= Date.now()) return undefined;

  const now = new Date();
  const stale =
    !row.last_used_at || now.getTime() - row.last_used_at.getTime() > 60_000;
  if (stale) {
    await execute("UPDATE api_keys SET last_used_at = ?, last_used_ip = ? WHERE id = ?", [
      now,
      ip ?? null,
      parsed.id,
    ]);
  }
  const record = toRecord(row);
  record.lastUsedAt = now.toISOString();
  if (ip) record.lastUsedIp = ip;
  return record;
}

export async function revokeKey(
  id: string,
  actor: Actor,
): Promise<ApiKeyRecord | undefined> {
  const existing = await findKey(id);
  if (!existing) return undefined;
  if (!existing.revokedAt) {
    await execute(
      "UPDATE api_keys SET revoked_at = ?, revoked_by_name = ? WHERE id = ?",
      [new Date(), actor.name, id],
    );
  }
  return findKey(id);
}
