import { parseNacosDocument, serializeNacosDocument } from "./config-format";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { NacosConfigCenter, type ConfigDocument } from "./config-center";
import { validateConfigDocument } from "./config-validation";

const md5 = (s: string) => createHash("md5").update(s).digest("hex");
function document(): ConfigDocument { return {
  schemaVersion: 1,
  platform: { mysql: { host: "localhost", user: "test", password: "secret-never-log", database: "eval" }, feishu: {}, superadmin: {}, session: {} },
  runtime: {
    "suts.json": { default: "model", suts: [{ id: "model", name: "Model", transport: "sse", url: "http://localhost:1/chat", apiKey: "private-value" }] },
    "fake-user.json": { connectionSutId: "model", model: "a", temperature: 1, promptVersion: "fake-user-v3", maxAttempts: 2, backoffBaseMs: 1, attemptTimeoutMs: 1000, totalTimeoutMs: 2000 },
    "judge.json": { connectionSutId: "model", model: "b", temperature: 0, rubricVersion: "companion-v1" },
    "quota.json": { dailyTokensPerUser: 100, dayTimezone: "UTC", estimate: { simAgentFixed: 1, simAgentPerHistoricalTurn: 1, simAgentPerBeat: 1, judgeFixed: 1, judgePerTurn: 1, safetyFactor: 1 } },
  },
}; }
async function harness(t: import("node:test").TestContext) {
  const remote = { content: JSON.stringify(document()), fail: false, listeners: 0, writes: 0, staleRead: "" };
  const server = createServer(async (req, res) => {
    if (remote.fail) { res.writeHead(503);res.end("secret-never-log"); return; }
    const url = new URL(req.url!, "http://localhost");
    assert.equal(url.pathname.startsWith("/nacos/v1/cs/configs"), true);
    const chunks: Buffer[]=[];for await (const c of req) chunks.push(Buffer.from(c));
    const body = new URLSearchParams(Buffer.concat(chunks).toString());
    if (url.pathname.endsWith("/listener")) { remote.listeners++; await new Promise(r=>setTimeout(r,50));res.end("");return; }
    if (req.method === "POST") { remote.writes++;if (body.get("casMd5") !== md5(remote.content)) {res.end("false");return;}remote.staleRead=remote.content;remote.content=body.get("content")!;res.end("true");return; }
    if (remote.staleRead) { const old=remote.staleRead;remote.staleRead="";res.end(old);return; }
    res.end(remote.content);
  });
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const address=server.address();assert.ok(address&&typeof address!=="string");
  const center=new NacosConfigCenter({url:`http://127.0.0.1:${address.port}/nacos`,namespace:"isolated",group:"eval",dataId:"config.json",pollMs:50},validateConfigDocument);
  t.after(async()=>{await center.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  return {remote,center};
}
async function eventually(check: ()=>boolean) {for(let i=0;i<100;i++){if(check())return;await new Promise(r=>setTimeout(r,20));}assert.fail("configuration did not converge");}

test("Nacos initial fetch fails closed with redacted errors and validates whole documents", async t=>{
  const {remote,center}=await harness(t);remote.content="not-json secret-never-log";
  await assert.rejects(center.start(),/nacos_invalid_document/);assert.throws(()=>center.snapshot());
  assert.equal(JSON.stringify(center.status()).includes("secret-never-log"),false);
});

test("Nacos hot reload, pending restart, invalid update and outage retain the last good snapshot", async t=>{
  const {remote,center}=await harness(t);await center.start();
  const first=center.snapshot();const changed=document();(changed.runtime['judge.json'] as any).model="hot-model";
  remote.content=JSON.stringify(changed);
  await eventually(()=>(center.snapshot().runtime['judge.json'] as any).model==="hot-model");
  assert.equal((first.runtime['judge.json'] as any).model,"b");assert.ok(remote.listeners>0);
  const validRevision=center.status().revision;
  const invalid=structuredClone(changed);(invalid.runtime['judge.json'] as any).connectionSutId="missing";
  remote.content=JSON.stringify(invalid);await assert.rejects(center.refresh());
  assert.equal(center.status().state,"degraded");assert.equal(center.status().revision,validRevision);
  const restart=structuredClone(changed);(restart.platform.mysql as any).password="new-password";(restart.runtime['judge.json'] as any).model="must-not-partially-apply";
  remote.content=JSON.stringify(restart);await center.refresh();assert.equal(center.status().state,"pending_restart");
  assert.equal((center.snapshot().runtime['judge.json'] as any).model,"hot-model");
  await assert.rejects(center.write('judge.json',changed.runtime['judge.json']),/待重启/);
  remote.fail=true;await assert.rejects(center.refresh(),/nacos_http_503/);assert.equal(center.status().revision,validRevision);
  remote.fail=false;remote.content=JSON.stringify(changed);await center.refresh();assert.equal(center.status().state,"ready");
});

test("Nacos admin edits write through CAS and do not silently overwrite external changes", async t=>{
  const {remote,center}=await harness(t);await center.refresh();
  const next={...(document().runtime['judge.json'] as object),model:'admin-change'};
  await center.write('judge.json',next);assert.equal((parseNacosDocument(remote.content) as any).runtime['judge.json'].model,'admin-change');assert.equal(remote.writes,1);
  // Change storage before the listener can observe it. CAS must reject the stale writer.
  remote.content=JSON.stringify({...document(),platform:{...document().platform,session:{ttlHours:24}}});
  await assert.rejects(center.write('judge.json',{...next,model:'stale'}),/其他人修改/);
  assert.equal((parseNacosDocument(remote.content) as any).platform.session.ttlHours,24);
});

test("platform config ignores leftover feishu fields and does not require them", () => {
  const bare = document();
  delete (bare.platform as { feishu?: unknown }).feishu;
  const parsed = validateConfigDocument(bare);
  assert.equal(parsed.platform.feishu, undefined);
  const legacy = document();
  (legacy.platform as { feishu: unknown }).feishu = { appSecret: "${SECRET}", redirectUri: "not-a-url" };
  (legacy.platform as { adminFeishuOpenIds: unknown }).adminFeishuOpenIds = "ignored";
  const checked = validateConfigDocument(legacy);
  assert.equal(
    (checked.platform as { feishu?: { appSecret?: string } }).feishu?.appSecret,
    "${SECRET}",
  );
});

test("remote config rejects local env references, invalid timezone, unknown fields and bad connection references",()=>{
  for(const mutate of [
    (d:ConfigDocument)=>{(d.platform.mysql as any).password='${PASSWORD}';},
    (d:ConfigDocument)=>{(d.runtime['quota.json'] as any).dayTimezone='invalid';},
    (d:ConfigDocument)=>{(d as any).typo=true;},
    (d:ConfigDocument)=>{(d.runtime['fake-user.json'] as any).connectionSutId='absent';},
  ]){const d=document();mutate(d);assert.throws(()=>validateConfigDocument(d));}
});

test("editing runtime credentials preserves comments on administrator and startup settings", async t=>{
  const {remote,center}=await harness(t);
  remote.content="# 管理员姓名注释需要保留\n"+serializeNacosDocument(document());
  await center.refresh();
  await center.write("suts.json",{default:"model",suts:[{id:"model",name:"Model",transport:"sse",url:"http://localhost:1/chat",apiKey:"rotated-raw-key"}]});
  assert.match(remote.content,/# 管理员姓名注释需要保留/);
  assert.equal((parseNacosDocument(remote.content) as any).runtime['suts.json'].suts[0].apiKey,"rotated-raw-key");
});

test("admitted work pins one runtime configuration while later work sees hot updates", async t=>{
  const {remote,center}=await harness(t);await center.refresh();
  const {withRuntimeConfiguration,readRuntimeConfig}=await import('./config-center');
  const g=globalThis as any;const old=g.__simEvalConfigCenter;const mode=process.env.SIM_EVAL_CONFIG_SOURCE;
  const saved=Object.fromEntries(['URL','NAMESPACE','GROUP','DATA_ID'].map(k=>[k,process.env['SIM_EVAL_NACOS_'+k]]));
  process.env.SIM_EVAL_CONFIG_SOURCE='nacos';Object.assign(process.env,{SIM_EVAL_NACOS_URL:'http://localhost:8848/nacos',SIM_EVAL_NACOS_NAMESPACE:'test',SIM_EVAL_NACOS_GROUP:'test',SIM_EVAL_NACOS_DATA_ID:'test'});
  g.__simEvalConfigCenter={center,ready:Promise.resolve()};
  try {
    await withRuntimeConfiguration(async()=>{
      assert.equal((await readRuntimeConfig('judge.json') as any).model,'b');
      const changed=document();(changed.runtime['judge.json'] as any).model='next-model';remote.content=JSON.stringify(changed);await center.refresh();
      assert.equal((await readRuntimeConfig('judge.json') as any).model,'b');
    });
    assert.equal((await readRuntimeConfig('judge.json') as any).model,'next-model');
  } finally {
    if(old)g.__simEvalConfigCenter=old;else delete g.__simEvalConfigCenter;
    if(mode===undefined)delete process.env.SIM_EVAL_CONFIG_SOURCE;else process.env.SIM_EVAL_CONFIG_SOURCE=mode;
    for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env['SIM_EVAL_NACOS_'+key];else process.env['SIM_EVAL_NACOS_'+key]=value;}
  }
});


test("YAML documents activate, key reordering needs no restart, duplicate keys and aliases are rejected", async t=>{
  const {remote,center}=await harness(t);
  const doc=document();remote.content=serializeNacosDocument(doc);await center.refresh();
  const reordered={...doc,platform:Object.fromEntries(Object.entries(doc.platform).reverse())};
  remote.content=serializeNacosDocument(reordered);await center.refresh();assert.equal(center.status().state,'ready');
  assert.throws(()=>parseNacosDocument('schemaVersion: 1\nschemaVersion: 2\n'));
  assert.throws(()=>parseNacosDocument('a: &key [1,2]\nb: *key\n'));
});
