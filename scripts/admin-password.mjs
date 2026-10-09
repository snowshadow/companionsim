#!/usr/bin/env node
/**
 * 生成超级管理员密码哈希（scrypt）。哈希填进 config/platform.json 的
 * superadmin.passwordHash，明文不要写进任何文件。
 *
 *   npm run admin-password -- <密码>
 */
import { randomBytes, scryptSync } from "node:crypto";

const plain = process.argv[2];
if (!plain || plain.length < 8) {
  console.error("用法：npm run admin-password -- <密码>（至少 8 位）");
  process.exit(1);
}
const N = 16384;
const r = 8;
const p = 1;
const salt = randomBytes(16);
const hash = scryptSync(plain, salt, 32, { N, r, p });
console.log(`scrypt$${N}$${r}$${p}$${salt.toString("hex")}$${hash.toString("hex")}`);
