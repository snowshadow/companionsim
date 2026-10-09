import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Person, Script } from "../shared/schema";
import { startHunt, getRun } from "./runtime";
import { writeJson } from "./store";
import {
  concurrencyKeyOf,
  memoryDomainOf,
  simulatedIdentity,
  supportsSimulatedIdentity,
} from "./sut";
import { withNamedLock } from "./jobs";

/**
 * 记忆域串行：同一 avatar 的局共享被测侧长程记忆，必须一个跑完再跑下一个；
 * 不同 avatar 是不同域，可以并行。不隔离就必须能审计，所以域与序号要写进记录。
 */

const person: Person = {
  id: "p-test",
  version: "v1",
  immutable: true,
  name: "测试者",
  age: 24,
  gender: "男",
  summary: "24岁年轻男性。",
  interests: ["篮球"],
  expectedDiff: "低落夜先提篮球",
  expectedDiffScripts: ["s-test"],
  behaviors: [
    { name: "兴趣先抛", instructions: ["开口带上篮球"], violations: ["不提"] },
  ],
};

const script: Script = {
  id: "s-test",
  version: "v1",
  name: "单拍测试",
  family: "short-term-memory",
  events: [
    { id: "e1", clock: "20:18", kind: "speak", intent: "低落开场" },
  ],
};

test("记忆域：按 avatar + 用户身份划分，其它传输不限", () => {
  // 同一 avatar 但不同用户身份 → 不同域（这正是完全隔离的依据）
  assert.equal(
    memoryDomainOf({ id: "a", transport: "soulpals", avatarId: "AVR-1" }, "soulpals-sim-x"),
    "soulpals:AVR-1:soulpals-sim-x",
  );
  assert.equal(
    memoryDomainOf({ id: "b", transport: "soulpals", avatarId: "AVR-1" }, "soulpals-sim-y"),
    "soulpals:AVR-1:soulpals-sim-y",
  );
  // 同一 avatar 且同一用户身份 → 同域，必须串行
  assert.equal(
    memoryDomainOf({ id: "c", transport: "soulpals", avatarId: "AVR-1" }, "pinned"),
    memoryDomainOf({ id: "d", transport: "soulpals", avatarId: "AVR-1" }, "pinned"),
  );
  // 没给身份时退化为服务端默认值，此时才是「所有局共用一个域」
  assert.equal(
    memoryDomainOf({ id: "e", transport: "soulpals", avatarId: "AVR-1" }),
    "soulpals:AVR-1:server-default",
  );
  // 进程内样例与无状态网关不共享服务端记忆
  assert.equal(memoryDomainOf({ id: "f", transport: "fixture" }), undefined);
  assert.equal(memoryDomainOf({ id: "g", transport: "sse" }), undefined);
});

test("仿真身份：跟着被测格式，但一眼看得出是仿真", () => {
  assert.equal(supportsSimulatedIdentity({ transport: "soulpals" }), true);
  // 带 sessionIdField 的 SSE 也算（本地轨迹 agent 要求每段对话一个会话 id）
  assert.equal(
    supportsSimulatedIdentity({ transport: "sse", sessionIdField: "session_id" }),
    true,
  );
  assert.equal(supportsSimulatedIdentity({ transport: "sse" }), false);
  assert.equal(
    simulatedIdentity({ transport: "soulpals" }, "abc"),
    "soulpals-sim-abc",
  );
  assert.equal(simulatedIdentity({ transport: "sse" }, "abc"), "sim-abc");
});

test("SSE 适配器：把本局身份注入请求体指定字段", async () => {
  const seen: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    let text = "";
    for await (const chunk of req) text += String(chunk);
    seen.push(JSON.parse(text || "{}") as Record<string, unknown>);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: "嗯。" } }] })}\n\n`,
    );
    res.end(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  try {
    const { createSseChatBrain } = await import("./sut-sse");
    const brain = createSseChatBrain(
      {
        id: "local-agent",
        name: "本地 agent",
        transport: "sse",
        url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
        body: "openai-chat",
        parse: "openai-chat",
        model: "heyan-trajectory",
        sessionIdField: "session_id",
        runtimeUserId: "sim-abc",
      },
      { chat: true, inbox: false, memory: false },
    );
    await brain.handleUser("你好");
    assert.equal(seen[0].session_id, "sim-abc", "会话 id 必须进请求体");
    assert.equal(seen[0].model, "heyan-trajectory");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("命名锁：同键串行，异键可并行", async () => {
  const order: string[] = [];
  const job = (name: string, key: string, ms: number) =>
    withNamedLock(key, async () => {
      order.push(`${name}:start`);
      await new Promise((resolve) => setTimeout(resolve, ms));
      order.push(`${name}:end`);
    });
  await Promise.all([
    job("a1", "acct-1", 80),
    job("a2", "acct-1", 10),
    job("b1", "acct-2", 10),
  ]);
  assert.ok(
    order.indexOf("a1:end") < order.indexOf("a2:start"),
    `同键必须串行，实际：${order.join(" → ")}`,
  );
  assert.ok(
    order.indexOf("b1:start") < order.indexOf("a1:end"),
    `异键应可并行，实际：${order.join(" → ")}`,
  );
});

test("并发键：按账号区分，不把凭据明文写进键", () => {
  // 运行时拿到的是被测快照：里面有 credentialRef，没有 headers
  const sameAccountA = concurrencyKeyOf({
    transport: "soulpals",
    url: "https://s/",
    credentialRef: "${SOULPALS_SESSION}",
  });
  const sameAccountB = concurrencyKeyOf({
    transport: "soulpals",
    url: "https://s/",
    credentialRef: "${SOULPALS_SESSION}",
  });
  const otherAccount = concurrencyKeyOf({
    transport: "soulpals",
    url: "https://s/",
    credentialRef: "${OTHER_SESSION}",
  });
  assert.ok(sameAccountA);
  assert.equal(sameAccountA, sameAccountB, "同一账号的不同登记必须共用一个键");
  assert.notEqual(sameAccountA, otherAccount, "不同账号互不影响");
  assert.equal(sameAccountA.includes("SOULPALS_SESSION="), false);
  // 直接给 record（无 credentialRef）时退回用 headers 指纹
  assert.equal(
    concurrencyKeyOf({ transport: "soulpals", url: "https://s/", headers: { Cookie: "c=1" } }),
    concurrencyKeyOf({ transport: "soulpals", url: "https://s/", headers: { Cookie: "c=1" } }),
  );
  // 其它传输没有这个约束
  assert.equal(
    concurrencyKeyOf({ transport: "fixture", url: "" }),
    undefined,
  );
});

/** 建一个隔离的临时产物目录，写入最小可用的人群与剧本。 */
async function tempRoot(prefix: string, suts: unknown[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  process.env.NODE_ENV = "test";
  process.env.SIM_EVAL_TEST_ROOT = root;
  await Promise.all([
    writeJson(path.join(root, "artifacts/people/p-test@v1.json"), person),
    writeJson(path.join(root, "artifacts/scripts/s-test@v1.json"), script),
    writeJson(path.join(root, "config/suts.json"), {
      default: "fixture",
      suts,
    }),
  ]);
  return root;
}

test("记忆域：进程内样例不写域，也不受串行限制", async () => {
  await tempRoot("sim-eval-nodomain-", [
    { id: "fixture", name: "内置样例", transport: "fixture" },
  ]);
  const started = await startHunt({
    mode: "hunt",
    generator: "template",
    personId: person.id,
    personVersion: person.version,
    scriptId: script.id,
    scriptVersion: script.version,
    sutId: "fixture",
  });
  assert.ok(started.ok);
  assert.equal(started.value.memoryDomain, undefined);
  assert.equal(started.value.memorySequence, undefined);
});

test("记忆域：默认每局一个独立仿真身份，域唯一、可并行", async () => {
  await tempRoot("sim-eval-isolated-", [
    { id: "fixture", name: "内置样例", transport: "fixture" },
    {
      id: "llm",
      name: "不可达被测",
      transport: "soulpals",
      url: "http://127.0.0.1:1",
      environment: "test",
      avatarId: "AVR-1",
    },
  ]);
  const start = () =>
    startHunt({
      mode: "hunt",
      generator: "template",
      personId: person.id,
      personVersion: person.version,
      scriptId: script.id,
      scriptVersion: script.version,
      sutId: "llm",
    });
  const first = await start();
  const second = await start();
  assert.ok(first.ok && second.ok);
  const a = await getRun(first.value.id);
  const b = await getRun(second.value.id);
  assert.ok(a && b);
  // 各自身份独立：域不同，都是首局，没有前序
  assert.match(a.memoryDomain ?? "", /^soulpals:AVR-1:soulpals-sim-/);
  assert.match(b.memoryDomain ?? "", /^soulpals:AVR-1:soulpals-sim-/);
  assert.notEqual(a.memoryDomain, b.memoryDomain);
  assert.equal(a.memorySequence, 1);
  assert.equal(b.memorySequence, 1);
  assert.equal(a.priorRunIds, undefined);
  // 身份要写进被测快照，便于审计一局用的是哪个身份
  assert.match(a.sutSnapshot?.runtimeUserId ?? "", /^soulpals-sim-/);
});

test("记忆域：只在登记里钉住身份时才共享，并记下前序局", async () => {
  // 指向必然连不上的端口：对话会失败，但开局记录的域信息要看得到。
  await tempRoot("sim-eval-shared-", [
    { id: "fixture", name: "内置样例", transport: "fixture" },
    {
      id: "llm",
      name: "共享身份被测",
      transport: "soulpals",
      url: "http://127.0.0.1:1",
      environment: "test",
      avatarId: "AVR-1",
      runtimeUserId: "pinned-user",
    },
  ]);
  const domain = "soulpals:AVR-1:pinned-user";
  await writeJson(
    path.join(process.env.SIM_EVAL_TEST_ROOT as string, "artifacts/runs/r-900.json"),
    {
      id: "r-900",
      mode: "hunt",
      status: "pending",
      createdAt: "2026-09-19T00:00:00.000Z",
      memoryDomain: domain,
      personId: person.id,
      personVersion: person.version,
      personName: person.name,
      scriptId: script.id,
      scriptVersion: script.version,
      scriptName: script.name,
      clock: "—",
      presence: "available",
      turns: [],
      facts: [],
    },
  );
  const started = await startHunt({
    mode: "hunt",
    generator: "template",
    personId: person.id,
    personVersion: person.version,
    scriptId: script.id,
    scriptVersion: script.version,
    sutId: "llm",
  });
  assert.ok(started.ok);
  const run = await getRun(started.value.id);
  assert.ok(run);
  assert.equal(run.memoryDomain, domain);
  assert.equal(run.memorySequence, 2, "旧局也算同域历史，本局是第 2 局");
  assert.deepEqual(run.priorRunIds, ["r-900"]);
});
