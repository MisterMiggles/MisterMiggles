import http from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, publicConfig, CONFIG_PATH } from "./config.js";
import { checkAll } from "./status.js";
import { chat, resetSession, agentEnabled } from "./agent.js";

const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public");
// When true, every request must carry the header Cloudflare Access adds after login.
// Only safe if the hub is reachable *exclusively* through Cloudflare (tunnel, no open port).
const REQUIRE_CF_ACCESS = process.env.REQUIRE_CF_ACCESS === "true";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

const json = (res, code, body) => {
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
};

async function readBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

async function serveStatic(req, res, pathname) {
  const rel = pathname === "/" ? "index.html" : pathname.slice(1);
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 404, { error: "Not found" });
  try {
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(data);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

async function handleChat(req, res) {
  if (!agentEnabled()) return json(res, 503, { error: "Agent is not configured (set ANTHROPIC_API_KEY)." });
  const body = await readBody(req);
  const text = typeof body.text === "string" ? body.text.trim().slice(0, 8000) : "";
  if (!text) return json(res, 400, { error: "Message is empty." });

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    "x-accel-buffering": "no", // stop NPM/nginx from buffering the stream
  });
  const emit = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  try {
    await chat({ sessionId: body.sessionId, text }, emit);
    emit("done", {});
  } catch (err) {
    console.error("[agent]", err);
    emit("error", { message: err.status ? `API error ${err.status}: ${err.message}` : err.message });
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  try {
    if (pathname === "/healthz") return json(res, 200, { ok: true });
    if (REQUIRE_CF_ACCESS && !req.headers["cf-access-authenticated-user-email"]) {
      return json(res, 403, { error: "Cloudflare Access login required." });
    }
    if (pathname === "/api/config" && req.method === "GET") {
      const config = publicConfig(await loadConfig());
      return json(res, 200, {
        ...config,
        agent: { enabled: agentEnabled() },
        user: req.headers["cf-access-authenticated-user-email"] ?? null,
      });
    }
    if (pathname === "/api/status" && req.method === "GET") {
      return json(res, 200, await checkAll(await loadConfig()));
    }
    if (pathname === "/api/agent/chat" && req.method === "POST") return await handleChat(req, res);
    if (pathname === "/api/agent/reset" && req.method === "POST") {
      const { sessionId } = await readBody(req);
      if (sessionId) resetSession(sessionId);
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET") return await serveStatic(req, res, pathname);
    json(res, 405, { error: "Method not allowed" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) json(res, err.status ?? 500, { error: err.message });
    else res.end();
  }
});

server.listen(PORT, () => {
  console.log(`MisterMiggles Hub on :${PORT}`);
  console.log(`Services: ${CONFIG_PATH}`);
  console.log(`Agent: ${agentEnabled() ? "enabled" : "disabled (no ANTHROPIC_API_KEY)"}`);
});
