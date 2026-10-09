import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {parse} from "yaml";
import {parseSutConfig, resolveSutHeaders, applySseSutInput,addSseSut,updateSseSutRecord,loadSutRecords} from "./sut-config";
import {sutView} from "./sut-evidence";

const connection = {id:"opencode",name:"OpenCode",transport:"sse",url:"https://opencode.ai/zen/go/v1/chat/completions"};
const read = (extra:Record<string,unknown>) => parseSutConfig({default:"opencode",suts:[{...connection,...extra}]}).records[0];

test("raw API keys generate Bearer and fixed OpenCode headers without exposing credentials", () => {
  const record=read({apiKey:"sk-private-test"});
  assert.deepEqual(resolveSutHeaders(record), {Authorization:"Bearer sk-private-test","x-opencode-session":"sim-eval-ui","User-Agent":"sim-eval-ui/0.1"});
  const view=sutView(record,{chat:true,inbox:false,memory:false});
  assert.equal(view.credentialConfigured,true);
  assert.equal(JSON.stringify(view).includes("sk-private-test"),false);
  assert.deepEqual(resolveSutHeaders({...record,url:"https://example.test/chat"}),{Authorization:"Bearer sk-private-test"});
});

test("legacy Authorization and prefixed API keys are rejected; only raw values are accepted", () => {
  for(const value of ["Bearer sk-secret","bearer spk-secret","raw\nkey","raw key"])
    assert.throws(()=>read({apiKey:value}),/密钥/);
  assert.throws(()=>read({headers:{Authorization:"Bearer old"}}),/apiKey/);
  assert.throws(()=>read({headers:{authorization:"old"}}),/apiKey/);
  assert.equal(read({apiKey:"  spk-test  "}).apiKey,"spk-test");
  assert.equal(resolveSutHeaders(read({apiKey:""})).Authorization,undefined);
});

test("environment references resolve raw keys and reject prefixed environment values", () => {
  const previous=process.env.SIM_CREDENTIAL_UNIT_TEST;
  try {
    const record=read({apiKey:"${SIM_CREDENTIAL_UNIT_TEST}"});
    process.env.SIM_CREDENTIAL_UNIT_TEST="spk-first";
    assert.equal(resolveSutHeaders(record).Authorization,"Bearer spk-first");
    process.env.SIM_CREDENTIAL_UNIT_TEST="Bearer spk-first";
    assert.throws(()=>resolveSutHeaders(record),/密钥/);
  } finally {
    if(previous===undefined)delete process.env.SIM_CREDENTIAL_UNIT_TEST;
    else process.env.SIM_CREDENTIAL_UNIT_TEST=previous;
  }
});

test("editing changes or clears only the API key and leaves other connection fields intact", () => {
  const original=read({apiKey:"sk-old",headers:{"X-Tenant":"tenant"}});
  const kept=applySseSutInput({name:original.name,url:original.url!,apiKey:""},original);
  assert.equal(kept.apiKey,"sk-old");
  const changed=applySseSutInput({name:original.name,url:original.url!,apiKey:"sk-new"},original);
  assert.equal(changed.apiKey,"sk-new");assert.deepEqual(changed.headers,original.headers);
  const cleared=applySseSutInput({name:original.name,url:original.url!,clearApiKey:true},original);
  assert.equal(cleared.apiKey,undefined);
});

test("Nacos template uses raw apiKey values without fixed request headers", () => {
  const text = fs.readFileSync(new URL("../config/nacos/sim-eval-ui.example.yaml", import.meta.url), "utf8");
  const config = parse(text);
  const suts = config.runtime["suts.json"].suts;
  assert.ok(suts.some((sut: { id?: string; apiKey?: string }) => sut.id === "openai" && sut.apiKey));
  assert.ok(suts.some((sut: { id?: string; apiKey?: string }) => sut.id === "anthropic" && sut.apiKey));
  for (const sut of suts) {
    assert.equal(sut.headers, undefined);
    if (sut.transport === "sse" && sut.id !== "mock-sse") assert.equal(typeof sut.apiKey, "string");
  }
  assert.equal(text.includes("soulpals.com"), false);
  assert.equal(text.includes("aliyuncs.com"), false);
  assert.equal(/cli_[0-9a-f]{10,}/.test(text), false);
});

const shared = () => ({default:"bot-a",chatbot:{url:"https://chatbot.example.test",apiKey:"spk-shared"},suts:[
  {id:"bot-a",name:"A",transport:"soulpals-service",environment:"test",avatarId:"A"},
  {id:"bot-b",name:"B",transport:"soulpals-service",environment:"test",avatarId:"B"},
]});
test("all chatbot roles share one bound endpoint and key; per-role overrides are rejected", () => {
  const raw=shared();const before=parseSutConfig(raw);
  for(const record of before.records){assert.equal(record.url,raw.chatbot.url);assert.equal(resolveSutHeaders(record).Authorization,"Bearer spk-shared");assert.equal(JSON.stringify(sutView(record,{chat:true,inbox:false,memory:true})).includes("spk-shared"),false);}
  raw.chatbot.apiKey="spk-rotated";const after=parseSutConfig(raw);
  assert.ok(after.records.every(r=>r.apiKey==="spk-rotated"));assert.ok(before.records.every(r=>r.apiKey==="spk-shared"));
  for(const field of ["apiKey","url"]){const invalid=shared();Object.assign(invalid.suts[0],{[field]:"override"});assert.throws(()=>parseSutConfig(invalid),/公共连接/);}
  assert.throws(()=>parseSutConfig({suts:raw.suts}),/公共连接/);
});

test("adding and editing roles preserve only the common credential, and switching providers cannot leak it", async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"shared-chatbot-"));
  const keys=["NODE_ENV","SIM_EVAL_TEST_ROOT","SIM_EVAL_CONFIG_SOURCE"];
  const old=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
  Object.assign(process.env,{NODE_ENV:"test",SIM_EVAL_TEST_ROOT:root,SIM_EVAL_CONFIG_SOURCE:"file"});
  try {
    fs.mkdirSync(path.join(root,"config"));const file=path.join(root,"config","suts.json");fs.writeFileSync(file,JSON.stringify(shared()));
    const created=await addSseSut({name:"C",style:"soulpals-service",url:"https://ignored.example.test",avatarId:"C",environment:"test"});
    assert.equal(created.url,shared().chatbot.url);assert.equal(created.apiKey,"spk-shared");
    await updateSseSutRecord(created.id,{name:"renamed",url:"",avatarId:"D"});
    const stored=JSON.parse(fs.readFileSync(file,"utf8"));assert.deepEqual(stored.chatbot,shared().chatbot);
    assert.ok(stored.suts.every((r:any)=>r.apiKey===undefined&&r.url===undefined));
    await assert.rejects(addSseSut({name:"bad",style:"soulpals-service",url:"",avatarId:"E",apiKey:"spk-private"}),/公共密钥/);
    const switched=await updateSseSutRecord(created.id,{name:"other",url:"https://other.example.test/chat",style:"openai-chat"});
    assert.equal(switched.apiKey,undefined);assert.equal(resolveSutHeaders(switched).Authorization,undefined);
    assert.equal((await loadSutRecords()).chatbot?.apiKey,"spk-shared");
  } finally {for(const k of keys){if(old[k]===undefined)delete process.env[k];else process.env[k]=old[k];}fs.rmSync(root,{recursive:true,force:true});}
});
