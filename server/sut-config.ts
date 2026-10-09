import { nacosEnabled, readRuntimeConfig, writeRuntimeConfig } from "./config-center";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { dataRoot, sutConfigFile } from "./paths";
import { isRecord } from "./validate";
import { safeUrl } from "./sut-evidence";
import type {
  CreateSutRequest,
  SseBodyStyle,
  SseParseStyle,
  SutStyle,
  SutTransport,
} from "../shared/schema";

export type SutRecord = {
  id: string;
  name: string;
  transport: SutTransport;
  note?: string;
  url?: string;
  /** OpenAI 兼容网关的 model，例如 Cherry Studio 的 `providerId:modelId`。 */
  model?: string;
  /** 模型接口。缺省 openai。 */
  api?: "openai" | "anthropic";
  /** 助手人设。Cherry 本地网关不认助手名，要靠这句带过去。 */
  systemPrompt?: string;
  headers?: Record<string, string>;
  apiKey?: string;
  body?: SseBodyStyle;
  parse?: SseParseStyle;
  environment?: string;
  /** Soulpals：Agent / Avatar 标识。 */
  avatarId?: string;
  /** 本局的仿真身份；留空则按被测能力自动生成或用服务端默认。 */
  runtimeUserId?: string;
  /** SSE：把本局仿真身份放进请求体的哪个字段。 */
  sessionIdField?: string;
  description?: string;
  agentVersion?: string;
  metaUrl?: string;
  promptVersion?: string;
  temperature?: number;
  topP?: number;
  session?: string;
  initialMemory?: string;
  tools?: string;
};

export type SutConfigInput = CreateSutRequest;

export type SutConfigFile = {
  defaultId: string;
  records: SutRecord[];
  chatbot?: { url: string; apiKey: string };
};

const BUILTIN: SutConfigFile = {
  defaultId: "fixture",
  records: [
    {
      id: "fixture",
      name: "内置样例",
      transport: "fixture",
      note: "故意不完美的本地大脑，用来先把评测跑通。不是产品。",
    },
  ],
};

const BODY_STYLES = new Set<SseBodyStyle>(["openai-chat", "message"]);
const STYLES = new Set<SutStyle>(["openai-chat", "message", "soulpals", "soulpals-service"]);
const PARSE_STYLES = new Set<SseParseStyle>(["openai-chat", "text", "raw"]);
const TRANSPORTS = new Set<SutTransport>([
  "fixture",
  "sse",
  "soulpals",
  "soulpals-service",
  "http",
  "websocket",
]);

let envLocalLoaded = false;

function loadEnvLocal(): void {
  if (envLocalLoaded) return;
  envLocalLoaded = true;
  const abs = path.join(dataRoot(), ".env.local");
  let text: string;
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function interpolateEnv(value: string): string {
  loadEnvLocal();
  return value.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_all, name: string) => {
    const found = process.env[name];
    if (found === undefined) {
      throw new Error(
        `环境变量 ${name} 未设置。把密钥写进仓库根目录 .env.local，不要写进 suts.json。`,
      );
    }
    return found;
  });
}

function rawApiKey(value: string): string {
  const text = value.trim();
  if (/\s/.test(text) || /^Bearer$/i.test(text)) throw new Error("API Key 只需填写密钥，不要添加前缀或空白字符");
  return text;
}

/** 把 apiKey 里的环境变量展开成原始密钥。没有占位符时不读本地环境文件。 */
export function resolvedSutApiKey(record: Pick<SutRecord, "apiKey">): string | undefined {
  if (!record.apiKey) return undefined;
  const value = record.apiKey.includes("${") ? interpolateEnv(record.apiKey) : record.apiKey;
  const key = rawApiKey(value);
  return key || undefined;
}

export function resolveSutHeaders(record: SutRecord): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record.headers ?? {})) {
    if (key.toLowerCase() !== "authorization") headers[key] = interpolateEnv(raw);
  }
  if ((record.api ?? "openai") === "anthropic") return headers;
  if (record.apiKey) {
    const key = rawApiKey(interpolateEnv(record.apiKey));
    if (key) headers.Authorization = `Bearer ${key}`;
  }
  if (record.url && new URL(interpolateEnv(record.url)).hostname === "opencode.ai") {
    headers["x-opencode-session"] = "sim-eval-ui";
    headers["User-Agent"] = "sim-eval-ui/0.1";
  }
  return headers;
}

function parseRecord(raw: unknown, index: number): SutRecord {
  if (!isRecord(raw)) throw new Error(`suts[${index}] 必须是对象`);
  if (typeof raw.id !== "string" || raw.id.trim() === "")
    throw new Error(`suts[${index}] 缺少 id`);
  if (typeof raw.name !== "string" || raw.name.trim() === "")
    throw new Error(`suts[${index}] 缺少 name`);
  if (
    typeof raw.transport !== "string" ||
    !TRANSPORTS.has(raw.transport as SutTransport)
  ) {
    throw new Error(
      `suts[${index}] 的 transport 必须是 fixture / sse / http / websocket`,
    );
  }
  const record: SutRecord = {
    id: raw.id.trim(),
    name: raw.name.trim(),
    transport: raw.transport as SutTransport,
  };
  if (typeof raw.note === "string" && raw.note.trim() !== "")
    record.note = raw.note.trim();
  if (typeof raw.url === "string" && raw.url.trim() !== "")
    record.url = raw.url.trim();
  if (typeof raw.model === "string" && raw.model.trim() !== "")
    record.model = raw.model.trim();
  if (raw.api !== undefined) {
    if (raw.api !== "openai" && raw.api !== "anthropic") {
      throw new Error(`suts[${index}] 的 api 必须是 openai 或 anthropic`);
    }
    record.api = raw.api;
  }
  if (typeof raw.systemPrompt === "string" && raw.systemPrompt.trim() !== "") {
    record.systemPrompt = raw.systemPrompt;
  }
  if (raw.headers !== undefined) {
    if (!isRecord(raw.headers))
      throw new Error(`suts[${index}] 的 headers 必须是对象`);
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.headers)) {
      if (typeof value !== "string")
        throw new Error(`suts[${index}] headers.${key} 必须是字符串`);
      if (key.toLowerCase() === "authorization") {
        throw new Error("请将原始密钥填写到 apiKey，请求头由平台生成");
      }
      headers[key] = value;
    }
    record.headers = headers;
  }
  if (raw.apiKey !== undefined) {
    if (typeof raw.apiKey !== "string") throw new Error(`suts[${index}] 的 apiKey 必须是字符串`);
    const key = rawApiKey(raw.apiKey);
    if (key) record.apiKey = key;
  }
  if (raw.body !== undefined) {
    if (
      typeof raw.body !== "string" ||
      !BODY_STYLES.has(raw.body as SseBodyStyle)
    ) {
      throw new Error(`suts[${index}] 的 body 必须是 openai-chat 或 message`);
    }
    record.body = raw.body as SseBodyStyle;
  }
  if (raw.parse !== undefined) {
    if (
      typeof raw.parse !== "string" ||
      !PARSE_STYLES.has(raw.parse as SseParseStyle)
    ) {
      throw new Error(
        `suts[${index}] 的 parse 必须是 openai-chat / text / raw`,
      );
    }
    record.parse = raw.parse as SseParseStyle;
  }
  for (const field of [
    "environment",
    "avatarId",
    "runtimeUserId",
    "sessionIdField",
    "description",
    "agentVersion",
    "metaUrl",
    "promptVersion",
    "session",
    "initialMemory",
    "tools",
  ] as const) {
    if (raw[field] !== undefined && typeof raw[field] !== "string")
      throw new Error(`suts[${index}] 的 ${field} 必须是字符串`);
    if (typeof raw[field] === "string" && raw[field].trim() !== "")
      record[field] = raw[field].trim();
  }
  for (const field of ["temperature", "topP"] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    const max = field === "topP" ? 1 : 2;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > max
    ) {
      throw new Error(`${field} 必须是 0 到 ${max} 之间的数值`);
    }
    record[field] = value;
  }
  if (record.metaUrl) parseHttpUrl(record.metaUrl);
  if ((record.transport === "sse" || (record.transport === "soulpals" || record.transport === "soulpals-service")) && !record.url) {
    throw new Error(`suts[${index}] ${record.transport} 被测必须有 url`);
  }
  if (record.sessionIdField && record.transport !== "sse") {
    throw new Error(`suts[${index}] 的 sessionIdField 只对 SSE 有意义`);
  }
  if (record.sessionIdField && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(record.sessionIdField)) {
    throw new Error(`suts[${index}] 的 sessionIdField 必须是合法字段名`);
  }
  if ((record.transport === "soulpals" || record.transport === "soulpals-service") && !record.avatarId) {
    throw new Error(`suts[${index}] Soulpals 被测必须有 avatarId`);
  }
  return record;
}

export async function loadSutRecords(): Promise<SutConfigFile> {
  if (nacosEnabled()) return parseSutConfig(await readRuntimeConfig("suts.json"));
  const abs = sutConfigFile();
  let raw: unknown;
  try {
    const content = await fsp.readFile(abs, "utf8");
    try {
      raw = JSON.parse(content);
    } catch {
      throw new Error("config/suts.json 不是合法 JSON");
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return BUILTIN;
    throw err;
  }
  return parseSutConfig(raw);
}

export function parseSutConfig(raw: unknown): SutConfigFile {
  if (!isRecord(raw) || !Array.isArray(raw.suts) || raw.suts.length === 0) {
    throw new Error("config/suts.json 必须有非空 suts 数组");
  }
  let chatbot: SutConfigFile["chatbot"];
  if (raw.chatbot !== undefined) {
    if (!isRecord(raw.chatbot) || typeof raw.chatbot.url !== "string" || typeof raw.chatbot.apiKey !== "string")
      throw new Error("Chatbot 公共连接需要 url 和 apiKey");
    chatbot = { url: parseHttpUrl(raw.chatbot.url), apiKey: rawApiKey(raw.chatbot.apiKey) };
  }
  const records = raw.suts.map((item, index) => {
    if (isRecord(item) && item.transport === "soulpals-service") {
      if (!chatbot?.apiKey) throw new Error("请先配置 Chatbot 公共连接和密钥");
      if (item.apiKey !== undefined || item.url !== undefined) throw new Error("Chatbot 角色使用公共连接，不单独配置 url 或 apiKey");
      return parseRecord({ ...item, ...chatbot }, index);
    }
    return parseRecord(item, index);
  });
  const ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error(`被测 id 重复：${record.id}`);
    ids.add(record.id);
  }
  const defaultId =
    typeof raw.default === "string" && raw.default.trim() !== ""
      ? raw.default.trim()
      : records[0].id;
  if (!ids.has(defaultId))
    throw new Error(`default 被测 ${defaultId} 不在列表里`);
  return { defaultId, records, ...(chatbot ? { chatbot } : {}) };
}

function recordToJson(record: SutRecord): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: record.id,
    name: record.name,
    transport: record.transport,
  };
  if (record.note) out.note = record.note;
  if (record.url && record.transport !== "soulpals-service") out.url = record.url;
  if (record.model) out.model = record.model;
  if (record.api) out.api = record.api;
  if (record.systemPrompt) out.systemPrompt = record.systemPrompt;
  if (record.headers && Object.keys(record.headers).length) out.headers = record.headers;
  if (record.apiKey && record.transport !== "soulpals-service") out.apiKey = record.apiKey;
  if (record.body) out.body = record.body;
  if (record.parse) out.parse = record.parse;
  for (const field of [
    "environment",
    "avatarId",
    "runtimeUserId",
    "sessionIdField",
    "description",
    "agentVersion",
    "metaUrl",
    "promptVersion",
    "temperature",
    "topP",
    "session",
    "initialMemory",
    "tools",
  ] as const) {
    if (record[field] !== undefined) out[field] = record[field];
  }
  return out;
}

function nextExtId(records: SutRecord[]): string {
  let n = 1;
  const ids = new Set(records.map((item) => item.id));
  while (ids.has(`ext-${String(n).padStart(3, "0")}`)) n += 1;
  return `ext-${String(n).padStart(3, "0")}`;
}

function parseHttpUrl(raw: string): string {
  const text = raw.trim();
  if (text === "") throw new Error("对话地址不能为空");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error("对话地址不是合法 URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("对话地址必须是 http 或 https");
  }
  return text;
}

export function applySseSutInput(
  input: SutConfigInput,
  previous: SutRecord,
): SutRecord {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name === "") throw new Error("名称不能为空");
  // A redacted URL shown by the UI is not a replacement for its secret-bearing original.
  let url: string;
  if (
    typeof input.url === "string" &&
    /\[redacted\]|%5Bredacted%5D/i.test(input.url)
  ) {
    if (!previous.url || input.url !== safeUrl(previous.url))
      throw new Error("修改含凭据的地址时，请重新填写完整地址");
    url = previous.url;
  } else url = parseHttpUrl(typeof input.url === "string" ? input.url : "");
  const requested: SutStyle | undefined =
    input.style === undefined ? undefined : input.style;
  if (requested !== undefined && !STYLES.has(requested))
    throw new Error("请求格式必须是 openai-chat / message / soulpals");
  const previousStyle: SutStyle =
    (previous.transport === "soulpals" || previous.transport === "soulpals-service")
      ? previous.transport
      : previous.body ?? "openai-chat";
  const style: SutStyle = requested ?? previousStyle;
  if (style === "soulpals-service" && (input.apiKey || input.clearApiKey))
    throw new Error("Chatbot 角色使用公共密钥，请在 Nacos 的 chatbot.apiKey 中统一配置");
  const soulpals = style === "soulpals" || style === "soulpals-service";
  if (input.parse !== undefined && !PARSE_STYLES.has(input.parse))
    throw new Error("响应格式必须是 openai-chat / text / raw");
  const parse: SseParseStyle | undefined = soulpals
    ? undefined
    : input.parse ??
      (input.style === undefined && previous.parse
        ? previous.parse
        : style === "message"
          ? "text"
          : "openai-chat");
  const record: SutRecord = {
    ...previous,
    name,
    transport: soulpals ? style as "soulpals" | "soulpals-service" : "sse",
    url,
    body: soulpals ? undefined : (style as SseBodyStyle),
    parse,
    note: soulpals
      ? "轮询适配器。本版只对接对话与记忆。"
      : "外部 Agent。本版只对接对话。",
  };
  if (soulpals) delete record.api;
  else if (input.api !== undefined) {
    if (input.api !== "openai" && input.api !== "anthropic") {
      throw new Error("api 必须是 openai 或 anthropic");
    }
    record.api = input.api;
  }
  if (previous.transport === "soulpals-service" && style !== "soulpals-service") delete record.apiKey;
  for (const field of [
    "model",
    "environment",
    "avatarId",
    "runtimeUserId",
    "sessionIdField",
    "description",
    "agentVersion",
    "metaUrl",
    "systemPrompt",
    "promptVersion",
    "session",
    "initialMemory",
    "tools",
  ] as const) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== "string")
      throw new Error(`${field} 必须是字符串`);
    const value = field === "systemPrompt" ? input[field] : input[field].trim();
    if (field === "metaUrl" && /\[redacted\]|%5Bredacted%5D/i.test(value)) {
      if (!previous.metaUrl || value !== safeUrl(previous.metaUrl))
        throw new Error("修改含凭据的 Meta 地址时，请重新填写完整地址");
      continue;
    }
    if (value === "") delete record[field];
    else record[field] = value;
  }
  for (const field of ["temperature", "topP"] as const) {
    if (input[field] === null) delete record[field];
    else if (input[field] !== undefined) record[field] = input[field];
  }
  if (input.apiKey !== undefined && typeof input.apiKey !== "string") throw new Error("apiKey 必须是字符串");
  const apiKey = typeof input.apiKey === "string" ? rawApiKey(input.apiKey) : "";
  record.headers = { ...previous.headers };
  if (style === "soulpals-service") {
    for (const key of Object.keys(record.headers)) {
      if (key.toLowerCase() === "cookie") delete record.headers[key];
    }
  }
  if (apiKey !== "") record.apiKey = apiKey;
  else if (input.clearApiKey) delete record.apiKey;
  return parseRecord(record, 0);
}

let configWrite: Promise<unknown> = Promise.resolve();

function withConfigWrite<T>(action: () => Promise<T>): Promise<T> {
  const result = configWrite.then(action, action);
  configWrite = result.catch(() => undefined);
  return result;
}

async function saveConfig(config: SutConfigFile): Promise<void> {
  const serialized = { default: config.defaultId, ...(config.chatbot ? { chatbot: config.chatbot } : {}), suts: config.records.map(recordToJson) };
  if (nacosEnabled()) {
    await writeRuntimeConfig("suts.json", serialized);
    return;
  }
  const file = sutConfigFile();
  const temporary = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(
    temporary,
    `${JSON.stringify(serialized, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fsp.rename(temporary, file);
}

export async function addSseSut(input: SutConfigInput): Promise<SutRecord> {
  return withConfigWrite(async () => {
    const loaded = await loadSutRecords();
    if (input.style === "soulpals-service" && !loaded.chatbot?.apiKey) throw new Error("请先配置 Chatbot 公共连接和密钥");
    const record = applySseSutInput(input.style === "soulpals-service" ? { ...input, url: loaded.chatbot!.url } : input, {
      id: nextExtId(loaded.records),
      name: "",
      transport: "sse",
    });
    if (record.transport === "soulpals-service") record.apiKey = loaded.chatbot!.apiKey;
    const next: SutConfigFile = {
      ...loaded,
      defaultId: loaded.defaultId,
      records: [...loaded.records, record],
    };
    await saveConfig(next);
    return record;
  });
}

export async function updateSseSutRecord(
  id: string,
  input: SutConfigInput,
): Promise<SutRecord> {
  return withConfigWrite(async () => {
    const loaded = await loadSutRecords();
    const previous = loaded.records.find((record) => record.id === id);
    if (!previous) throw new Error("找不到被测 Agent");
    if (previous.transport !== "sse" && previous.transport !== "soulpals" && previous.transport !== "soulpals-service")
      throw new Error("本版仅支持编辑 SSE 或 Soulpals 接入");
    const service = (input.style ?? previous.transport) === "soulpals-service";
    if (service && !loaded.chatbot?.apiKey) throw new Error("请先配置 Chatbot 公共连接和密钥");
    const record = applySseSutInput(service ? { ...input, url: loaded.chatbot!.url } : input, previous);
    if (service) record.apiKey = loaded.chatbot!.apiKey;
    await saveConfig({
      ...loaded,
      records: loaded.records.map((item) => (item.id === id ? record : item)),
    });
    return record;
  });
}
