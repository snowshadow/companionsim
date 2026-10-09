// Explicit protocol fixture for local integration only. It never grades model quality.
import { createServer } from "node:http";
const dims = ["记忆诚实", "主动与边界", "关系与人设", "能力诚实", "出戏"];
createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404).end(); return; }
  try {
    let raw = "";
    for await (const chunk of req) { raw += chunk; if (raw.length > 1_000_000) throw Error("too large"); }
    const body = JSON.parse(raw);
    const context = JSON.parse(body.messages.at(-1).content);
    const content = body.model === "local-smoke-judge"
      ? JSON.stringify({summary: "本地协议联调：模拟模型输出，不代表真实评测结论。",
          dimensions: dims.map(dim => ({dim, verdict: "untestable", value: null,
            reason: "本地模拟模型，仅验证接口与存储。", evidenceTurnIds: []})),
          simulator: {verdict: "untestable", reason: "协议联调，非真实仿真。", evidenceTurnIds: []}})
      : "本地联调：" + String(context.this_beat?.intent || "你好").slice(0, 100);
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({id: "local-protocol-fixture", model: body.model,
      choices: [{message: {role: "assistant", content}, finish_reason: "stop"}]}));
  } catch { res.writeHead(400).end('{"error":"invalid local fixture request"}'); }
}).listen(18082, "127.0.0.1", () => console.log("Protocol fixture only (no real model): http://127.0.0.1:18082"));
