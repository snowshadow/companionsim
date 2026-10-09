import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * 密码只存 scrypt 哈希。格式：`scrypt$N$r$p$saltHex$hashHex`。
 * 首个管理员的哈希用 `npm run admin-password` 生成，绝不存明文。
 */

const N = 16384;
const R = 8;
const P = 1;
const KEY_LEN = 32;

export function hashPassword(plain: string): string {
  if (plain.length < 8) throw new Error("密码至少 8 位");
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, KEY_LEN, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return false;
  }
  let expected: Buffer;
  let salt: Buffer;
  try {
    salt = Buffer.from(parts[4], "hex");
    expected = Buffer.from(parts[5], "hex");
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  let actual: Buffer;
  try {
    actual = scryptSync(plain, salt, expected.length, { N: n, r, p });
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

export function passwordHashLooksValid(stored: string): boolean {
  return /^scrypt\$\d+\$\d+\$\d+\$[0-9a-f]+\$[0-9a-f]+$/.test(stored);
}
