import type { IncomingMessage, ServerResponse } from "node:http";

/** HTTP 面的公共部分：发送与读体。路由与鉴权在 http.ts，认证接口在 auth-http.ts。 */

export const JSON_TYPE = "application/json; charset=utf-8";
export const MAX_BODY = 1_000_000;

export function send(res: ServerResponse, status: number, body: unknown): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", JSON_TYPE);
  res.end(JSON.stringify(body));
}

export function sendFail(
  res: ServerResponse,
  fail: { status: number; error: string; errors?: string[] },
): void {
  send(res, fail.status, { error: fail.error, errors: fail.errors });
}

/** 二进制下载（zip 这类）。文件名只放 ASCII，避免各家浏览器解码不一致。 */
export function sendFile(
  res: ServerResponse,
  status: number,
  body: Buffer,
  options: { contentType: string; filename: string },
): void {
  if (res.writableEnded) return;
  res.statusCode = status;
  res.setHeader("Content-Type", options.contentType);
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${options.filename}"; filename*=UTF-8''${encodeURIComponent(options.filename)}`,
  );
  res.setHeader("Content-Length", String(body.length));
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

export function redirect(res: ServerResponse, location: string, cookie?: string): void {
  if (res.writableEnded) return;
  res.statusCode = 302;
  res.setHeader("Location", location);
  if (cookie) res.setHeader("Set-Cookie", cookie);
  res.end();
}

export function pathnameOf(req: IncomingMessage): string {
  const raw = req.url ?? "/";
  const url = new URL(raw, "http://127.0.0.1");
  const path = url.pathname;
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

export function queryOf(req: IncomingMessage): URLSearchParams {
  return new URL(req.url ?? "/", "http://127.0.0.1").searchParams;
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > MAX_BODY) {
        reject(new Error("请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export type BodyResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

export async function parseJsonBody(
  req: IncomingMessage,
): Promise<BodyResult> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "无法读取请求体",
    };
  }
  if (raw.trim() === "") return { ok: false, error: "请求体不能为空" };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, error: "JSON 无法解析" };
  }
}
