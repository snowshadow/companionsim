import { parseNacosDocument } from "./config-format";
import { parseDocument } from "yaml";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";

export type RuntimeFile = "suts.json" | "fake-user.json" | "judge.json" | "quota.json";
export type ConfigDocument = { schemaVersion: 1; platform: Record<string, unknown>; runtime: Record<RuntimeFile, unknown> };
export type ConfigStatus = { source: "file" | "nacos"; state: "ready" | "unavailable" | "degraded" | "pending_restart"; revision?: string; reason?: string; checkedAt?: string };
type Validator = (value: unknown) => ConfigDocument;
export type NacosOptions = { url: string; namespace: string; group: string; dataId: string; username?: string; password?: string; timeoutMs?: number; pollMs?: number };
const digest = (body: string) => createHash("md5").update(body).digest("hex");
const fingerprint = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + fingerprint((value as Record<string, unknown>)[k])).join(",")}}`;
  return JSON.stringify(value);
};

/** One authority, one validated document, no persistent secret/config fallback. */
export class NacosConfigCenter {
  private active?: ConfigDocument;
  private activeMd5?: string;
  private activeContent = "";
  private observedMd5 = "";
  private startup?: string;
  private token?: { value: string; until: number };
  private stopped = false;
  private controller = new AbortController();
  private loop?: Promise<void>;
  private serial: Promise<unknown> = Promise.resolve();
  private statusValue: ConfigStatus = { source: "nacos", state: "unavailable" };
  constructor(private options: NacosOptions, private validate: Validator, private fetcher: typeof fetch = fetch) {}
  status(): ConfigStatus { return { ...this.statusValue }; }
  snapshot(): ConfigDocument {
    if (!this.active) throw new Error("Nacos 配置尚未就绪");
    return structuredClone(this.active);
  }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.serial.then(fn, fn); this.serial = result.catch(() => {}); return result;
  }
  private async accessToken(): Promise<string | undefined> {
    if (!this.options.username) return undefined;
    if (this.token && this.token.until > Date.now()) return this.token.value;
    const r = await this.fetcher(`${this.options.url}/v1/auth/login`, {
      method: "POST", body: new URLSearchParams({ username: this.options.username, password: this.options.password ?? "" }),
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(this.options.timeoutMs ?? 5000)]), redirect: "error",
    });
    if (!r.ok) throw new Error("nacos_auth_failed");
    const data = await r.json() as { accessToken?: string; tokenTtl?: number };
    if (!data.accessToken) throw new Error("nacos_auth_failed");
    this.token = { value: data.accessToken, until: Date.now() + Math.max(1, (data.tokenTtl ?? 300) - 30) * 1000 };
    return data.accessToken;
  }
  private async request(method: string, suffix: string, body?: URLSearchParams, wait = 0): Promise<string> {
    const token = await this.accessToken();
    const url = new URL(`${this.options.url}/v1/cs/configs${suffix}`);
    const params = body ?? new URLSearchParams({ dataId: this.options.dataId, group: this.options.group, tenant: this.options.namespace });
    if (token) params.set("accessToken", token);
    if (method === "GET") url.search = params.toString();
    const r = await this.fetcher(url, { method, ...(method === "GET" ? {} : { body: params }),
      headers: wait ? { "Long-Pulling-Timeout": String(wait) } : {}, redirect: "error",
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(wait + (this.options.timeoutMs ?? 5000))]),
    });
    if (!r.ok) { if (r.status === 403 || r.status === 401) this.token = undefined; throw new Error(`nacos_http_${r.status}`); }
    // Bound decompressed bytes, including chunked responses.
    const reader = r.body?.getReader(); if (!reader) throw new Error("nacos_empty_response");
    const chunks: Uint8Array[] = []; let size = 0;
    for (;;) { const item = await reader.read(); if (item.done) break; size += item.value.length;
      if (size > 1_048_576) { await reader.cancel(); throw new Error("nacos_document_too_large"); } chunks.push(item.value); }
    return Buffer.concat(chunks).toString("utf8");
  }
  private accept(body: string): void {
    this.observedMd5 = digest(body);
    let doc: ConfigDocument;
    try { doc = this.validate(parseNacosDocument(body)); } catch { throw new Error("nacos_invalid_document"); }
    const boot = fingerprint(doc.platform);
    if (this.startup !== undefined && boot !== this.startup) {
      this.statusValue = { source: "nacos", state: "pending_restart", revision: this.activeMd5, reason: "startup_config_changed", checkedAt: new Date().toISOString() };
      return; // Never partially apply a document containing startup changes.
    }
    this.startup = boot; this.active = structuredClone(doc); this.activeMd5 = this.observedMd5;
    this.activeContent = body;
    this.statusValue = { source: "nacos", state: "ready", revision: this.activeMd5, checkedAt: new Date().toISOString() };
  }
  async refresh(): Promise<void> {
    return this.locked(async () => {
      try { this.accept(await this.request("GET", "")); }
      catch (err) { this.statusValue = { ...this.statusValue, state: this.active ? "degraded" : "unavailable", reason: err instanceof Error && /^nacos_[a-z0-9_]+$/.test(err.message) ? err.message : "nacos_unavailable", checkedAt: new Date().toISOString() }; throw new Error(this.statusValue.reason); }
    });
  }
  async start(): Promise<void> {
    if (this.active) return;
    await this.refresh(); // Startup must fetch live valid content; never fall back to files.
    this.loop = this.watch();
  }
  private async watch(): Promise<void> {
    while (!this.stopped) {
      try {
        const wait = this.options.pollMs ?? 30_000;
        await this.request("POST", "/listener", new URLSearchParams({ "Listening-Configs": [this.options.dataId, this.options.group, this.observedMd5, this.options.namespace].join("\x02") + "\x01" }), wait);
        if (!this.stopped) await this.refresh(); // Also reconciles when a notification is lost.
      } catch {
        if (this.stopped) break;
        if (this.statusValue.state !== "degraded") this.statusValue = { ...this.statusValue, state: "degraded", reason: "nacos_unavailable" };
        await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); this.controller.signal.removeEventListener("abort", done); resolve(); }; const timer = setTimeout(done, 1000); timer.unref(); this.controller.signal.addEventListener("abort", done, { once: true }); });
        if (!this.stopped) await this.refresh().catch(() => {});
      }
    }
  }
  async write(name: RuntimeFile, value: unknown): Promise<void> {
    return this.locked(async () => {
      if (!this.active || this.statusValue.state !== "ready") throw new Error("配置中心尚未就绪或待重启，暂不能编辑");
      const prior = this.activeMd5!;
      const candidate = this.validate({ ...this.snapshot(), runtime: { ...this.active.runtime, [name]: value } });
      const document = parseDocument(this.activeContent);
      document.setIn(["runtime", name], document.createNode(candidate.runtime[name]));
      const body = document.toString({ lineWidth: 0 });
      const result = await this.request("POST", "", new URLSearchParams({ dataId: this.options.dataId, group: this.options.group, tenant: this.options.namespace, content: body, type: "yaml", casMd5: prior }));
      if (result.trim() !== "true") throw new Error("配置已被其他人修改，请刷新后重试");
      const expected = digest(body);
      const deadline = Date.now() + (this.options.timeoutMs ?? 5000);
      // Nacos publishes asynchronously into its read cache. A successful CAS may
      // briefly read back the previous revision; it is not a competing edit.
      for (;;) {
        const observed = await this.request("GET", "");
        const revision = digest(observed);
        if (revision === expected) { this.accept(observed); return; }
        if (revision !== prior) { this.accept(observed); throw new Error("配置发布后再次发生变更，请刷新确认"); }
        if (Date.now() >= deadline) {
          this.statusValue = { ...this.statusValue, state: "degraded", reason: "nacos_publish_confirmation_pending" };
          throw new Error("配置已发布，尚未确认生效，请稍后刷新确认");
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    });
  }
  async close(): Promise<void> { this.stopped = true; this.controller.abort(); await this.loop; }
}

function options(): NacosOptions | undefined {
  const mode = process.env.SIM_EVAL_CONFIG_SOURCE ?? "file";
  if (mode === "file") return undefined;
  if (mode !== "nacos") throw new Error("SIM_EVAL_CONFIG_SOURCE 必须为 file 或 nacos");
  const raw = process.env.SIM_EVAL_NACOS_URL;
  if (!raw) throw new Error("缺少 SIM_EVAL_NACOS_URL");
  const url = new URL(raw);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("Nacos 地址无效");
  const namespace = process.env.SIM_EVAL_NACOS_NAMESPACE;
  const group = process.env.SIM_EVAL_NACOS_GROUP;
  const dataId = process.env.SIM_EVAL_NACOS_DATA_ID;
  if (namespace === undefined || !group || !dataId || [namespace, group, dataId].some(v => /[\x00-\x1f]/.test(v))) throw new Error("缺少或无效的 Nacos namespace/group/dataId");
  return { url: url.href.replace(/\/$/, ""), namespace, group, dataId, username: process.env.SIM_EVAL_NACOS_USERNAME, password: process.env.SIM_EVAL_NACOS_PASSWORD };
}
// Vite dev SSR reloads must not create duplicate Nacos listeners.
const runtimeContext = new AsyncLocalStorage<ConfigDocument>();
const globals = globalThis as typeof globalThis & { __simEvalConfigCenter?: { center: NacosConfigCenter; ready: Promise<void> } };
export function nacosEnabled(): boolean { return process.env.SIM_EVAL_CONFIG_SOURCE === "nacos"; }
export async function ensureConfiguration(): Promise<void> {
  const config = options(); if (!config) return;
  if (!globals.__simEvalConfigCenter) {
    const { validateConfigDocument } = await import("./config-validation");
    if (!globals.__simEvalConfigCenter) {
      const center = new NacosConfigCenter(config, validateConfigDocument);
      globals.__simEvalConfigCenter = { center, ready: center.start() };
    }
  }
  await globals.__simEvalConfigCenter.ready;
}
export function configurationStatus(): ConfigStatus { return globals.__simEvalConfigCenter?.center.status() ?? { source: nacosEnabled() ? "nacos" : "file", state: nacosEnabled() ? "unavailable" : "ready" }; }
export async function remotePlatform(): Promise<unknown> { await ensureConfiguration(); return globals.__simEvalConfigCenter!.center.snapshot().platform; }
export async function readRuntimeConfig(name: RuntimeFile): Promise<unknown> {
  const pinned = runtimeContext.getStore();
  if (pinned) return structuredClone(pinned.runtime[name]);
  await ensureConfiguration(); return globals.__simEvalConfigCenter!.center.snapshot().runtime[name];
}
export async function withRuntimeConfiguration<T>(action: () => Promise<T>): Promise<T> {
  if (!nacosEnabled()) return action();
  await ensureConfiguration();
  return runtimeContext.run(globals.__simEvalConfigCenter!.center.snapshot(), action);
}
export async function writeRuntimeConfig(name: RuntimeFile, value: unknown): Promise<void> { await ensureConfiguration(); await globals.__simEvalConfigCenter!.center.write(name, value); }
export async function closeConfiguration(): Promise<void> { const current = globals.__simEvalConfigCenter; delete globals.__simEvalConfigCenter; await current?.center.close(); }
