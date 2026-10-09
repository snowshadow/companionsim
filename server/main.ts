/** Production HTTP entrypoint. Vite remains a build/development tool. */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "./http";
import { ensurePlatformReady } from "./bootstrap";
import { closeConfiguration, configurationStatus } from "./config-center";
import { closePool } from "./db";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist");
const mime: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2" };
await ensurePlatformReady();
if (configurationStatus().state === "unavailable") throw new Error("Configuration unavailable");
const server = createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname === "/api/health/live") { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"ok":true}'); return; }
    if (pathname.startsWith("/api")) { await handle(req, res); return; }
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
    const relative = decodeURIComponent(pathname).replace(/^\/+/, "");
    let file = path.resolve(root, relative);
    if (!file.startsWith(root + path.sep) && file !== root) { res.writeHead(404);res.end();return; }
    try { if (!(await stat(file)).isFile()) file = path.join(root, "index.html"); }
    catch { if (path.extname(relative)) {res.writeHead(404);res.end();return;} file = path.join(root, "index.html"); }
    const body = await readFile(file);
    res.writeHead(200, { "Content-Type": mime[path.extname(file)] ?? "application/octet-stream", "Content-Length": body.length, "X-Content-Type-Options": "nosniff", "Cache-Control": file.includes(`${path.sep}assets${path.sep}`) ? "public, max-age=31536000, immutable" : "no-cache" });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch { if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });res.end('{"error":"服务器内部错误"}'); }
});
const port = Number(process.env.PORT ?? 5260);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
server.listen(port, process.env.HOST ?? "0.0.0.0", () => console.log(`sim-eval-ui listening on ${port}`));
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  const deadline = setTimeout(() => process.exit(1), 40_000);deadline.unref();
  server.close();
  const { waitForJobs } = await import("./jobs");
  await waitForJobs();
  await closeConfiguration();await closePool();clearTimeout(deadline);process.exit(0);
}
process.on("SIGTERM", () => { void stop(); });process.on("SIGINT", () => { void stop(); });
