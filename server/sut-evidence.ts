import { createHash } from "node:crypto";
import type {
  RemoteMetadata,
  SutCaps,
  SutSnapshot,
  SutView,
} from "../shared/schema";
import type { SutRecord } from "./sut-config";

export const SUT_ADAPTER_VERSION = "sse-chat-v2";
export const SOULPALS_ADAPTER_VERSION = "soulpals-rest-v1";
const SECRET_QUERY =
  /token|key|password|secret|auth|signature|credential|^sig$/i;
const META_FIELDS = [
  "model",
  "build",
  "release",
  "commit",
  "promptVersion",
  "toolsVersion",
  "memoryVersion",
] as const;

export function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = "[redacted]";
    if (url.password) url.password = "[redacted]";
    for (const key of [...url.searchParams.keys()]) {
      if (SECRET_QUERY.test(key)) url.searchParams.set(key, "[redacted]");
    }
    url.hash = "";
    return url.toString();
  } catch {
    return "[未解析的地址]";
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function credentialInfo(
  record: SutRecord,
): Pick<SutView, "credentialConfigured" | "credentialRef"> {
  const values = [...Object.values(record.headers ?? {}), record.apiKey ?? ""];
  const refs = [
    ...new Set(
      [...values, record.url ?? ""].flatMap((value) =>
        [...value.matchAll(/\$\{([A-Z][A-Z0-9_]*)\}/g)].map(
          (match) => `\${${match[1]}}`,
        ),
      ),
    ),
  ];
  let hasUrlCredential = false;
  try {
    const url = new URL(record.url ?? "");
    hasUrlCredential = Boolean(
      url.username ||
      url.password ||
      [...url.searchParams.keys()].some((key) => SECRET_QUERY.test(key)),
    );
  } catch {
    /* A missing URL on a fixture has no credentials. */
  }
  return {
    credentialConfigured:
      values.some((value) => value.trim() !== "") || hasUrlCredential,
    ...(refs.length ? { credentialRef: refs.join(", ") } : {}),
  };
}

export function sutView(
  record: SutRecord,
  caps: SutCaps,
  credentialRecord = record,
): SutView {
  const view: SutView = {
    id: record.id,
    name: record.name,
    transport: record.transport,
    caps: { ...caps },
    ...credentialInfo(credentialRecord),
  };
  for (const field of [
    "note",
    "model",
    "environment",
    "avatarId",
    "runtimeUserId",
    "sessionIdField",
    "description",
    "agentVersion",
    "systemPrompt",
    "promptVersion",
    "session",
    "initialMemory",
    "tools",
  ] as const) {
    if (record[field] !== undefined) view[field] = record[field];
  }
  if (record.url) view.url = safeUrl(record.url);
  if (record.metaUrl) view.metaUrl = safeUrl(record.metaUrl);
  if (record.transport === "sse") {
    view.body = record.body ?? "openai-chat";
    view.parse = record.parse ?? "openai-chat";
  }
  if (record.api) view.api = record.api;
  if (record.temperature !== undefined) view.temperature = record.temperature;
  if (record.topP !== undefined) view.topP = record.topP;
  return view;
}

export function freezeDeep<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) freezeDeep(item);
    Object.freeze(value);
  }
  return value;
}

export function sutSnapshot(
  record: SutRecord,
  caps: SutCaps,
  credentialRecord = record,
): SutSnapshot {
  const view = sutView(record, caps, credentialRecord);
  const adapterVersion =
    record.transport === "fixture"
      ? "fixture-v1"
      : record.transport === "soulpals"
        ? SOULPALS_ADAPTER_VERSION
        : SUT_ADAPTER_VERSION;
  return {
    ...view,
    capturedAt: new Date().toISOString(),
    source: "platform-config",
    adapterVersion,
    configHash: sha256(JSON.stringify({ ...view, adapterVersion })),
    ...(record.systemPrompt ? { promptHash: sha256(record.systemPrompt) } : {}),
    declaredVersionSource: "human-unverified",
  };
}

function stringField(
  raw: Record<string, unknown>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    if (typeof raw[key] === "string" && raw[key].trim())
      return raw[key].slice(0, 512);
  }
  return undefined;
}

/** Only recognized identity fields are retained; never copy arbitrary server payloads. */
export function metadataFromObject(
  value: unknown,
  source: RemoteMetadata["source"],
): RemoteMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const raw = value as Record<string, unknown>;
  const nested =
    raw.metadata &&
    typeof raw.metadata === "object" &&
    !Array.isArray(raw.metadata)
      ? (raw.metadata as Record<string, unknown>)
      : {};
  const fields = { ...raw, ...nested };
  const result: RemoteMetadata = {
    source,
    capturedAt: new Date().toISOString(),
  };
  const aliases: Record<(typeof META_FIELDS)[number], string[]> = {
    model: ["model"],
    build: ["build", "build_id", "buildId"],
    release: ["release", "release_id", "releaseId"],
    commit: ["commit", "commit_sha", "commitSha"],
    promptVersion: ["promptVersion", "prompt_version"],
    toolsVersion: ["toolsVersion", "tools_version"],
    memoryVersion: ["memoryVersion", "memory_version"],
  };
  for (const field of META_FIELDS) {
    const value = stringField(fields, aliases[field]);
    if (value) result[field] = value;
  }
  return META_FIELDS.some((field) => result[field] !== undefined)
    ? result
    : undefined;
}

export function metadataFromHeaders(
  headers: Headers,
): RemoteMetadata | undefined {
  const object: Record<string, string> = {};
  for (const [field, header] of Object.entries({
    model: "x-model",
    build: "x-build",
    release: "x-release",
    commit: "x-commit",
    prompt_version: "x-prompt-version",
    tools_version: "x-tools-version",
    memory_version: "x-memory-version",
  })) {
    const value = headers.get(header);
    if (value) object[field] = value;
  }
  return metadataFromObject(object, "response");
}

export function metadataDrift(
  previous: RemoteMetadata | undefined,
  current: RemoteMetadata | undefined,
): string[] {
  if (!previous || !current) return [];
  return META_FIELDS.flatMap((field) =>
    previous[field] && current[field] && previous[field] !== current[field]
      ? [`${field}: ${previous[field]} → ${current[field]}`]
      : [],
  );
}

export async function collectSutMetadata(
  record: SutRecord,
): Promise<{ remoteMetadata?: RemoteMetadata; metaError?: string }> {
  if (!record.metaUrl) return {};
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const sameOrigin =
      record.url &&
      new URL(record.url).origin === new URL(record.metaUrl).origin;
    const response = await fetch(record.metaUrl, {
      headers: {
        Accept: "application/json",
        ...(sameOrigin ? record.headers : {}),
      },
      signal: controller.signal,
    });
    if (!response.ok) return { metaError: `Meta HTTP ${response.status}` };
    const remoteMetadata = metadataFromObject(
      await response.json(),
      "meta-endpoint",
    );
    return remoteMetadata
      ? { remoteMetadata }
      : { metaError: "Meta 未提供可识别的模型或版本信息" };
  } catch {
    return {
      metaError: controller.signal.aborted ? "Meta 采集超时" : "Meta 采集失败",
    };
  } finally {
    clearTimeout(timer);
  }
}
