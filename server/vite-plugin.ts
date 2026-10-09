import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";

type HttpModule = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
};

function canSsrLoad(server: ViteDevServer | PreviewServer): server is ViteDevServer {
  return "ssrLoadModule" in server;
}

async function loadHttp(server: ViteDevServer | PreviewServer): Promise<HttpModule> {
  if (canSsrLoad(server)) {
    return (await server.ssrLoadModule("/server/http.ts")) as HttpModule;
  }
  return (await import("./http")) as HttpModule;
}

function mount(server: ViteDevServer | PreviewServer): void {
  server.middlewares.use((req, res, next) => {
    const url = req.url ?? "";
    const path = url.split("?")[0] ?? "";
    if (!path.startsWith("/api")) {
      next();
      return;
    }
    void (async () => {
      try {
        const mod = await loadHttp(server);
        await mod.handle(req, res);
      } catch (err) {
        if (res.headersSent || res.writableEnded) return;
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        const message = err instanceof Error ? err.message : "服务器内部错误";
        res.end(JSON.stringify({ error: message }));
      }
    })();
  });
}

export function simEvalApiPlugin(): Plugin {
  return {
    name: "sim-eval-api",
    async configureServer(server) {
      const mod = await loadHttp(server);
      await mod.start();
      server.httpServer?.once("close", () => { void mod.stop(); });
      mount(server);
    },
    async configurePreviewServer(server) {
      const mod = await loadHttp(server);
      await mod.start();
      server.httpServer.once("close", () => { void mod.stop(); });
      mount(server);
    },
  };
}
