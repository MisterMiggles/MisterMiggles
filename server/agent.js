import os from "node:os";
import { statfs } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { loadConfig, allServices } from "./config.js";
import { checkService } from "./status.js";

const MODEL = process.env.AGENT_MODEL ?? "claude-opus-5-5";
const EFFORT = process.env.AGENT_EFFORT ?? "medium";
const MAX_TURNS = 10;
const MAX_SESSIONS = 50;

export const agentEnabled = () =>
  Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

let client;
const getClient = () => (client ??= new Anthropic());

const SYSTEM = `You are Miggles, the assistant built into a self-hosted home server dashboard.
You can look up the services on the server (media, security, home automation, apps,
infrastructure), check whether they are up, and read basic host stats. Domains are routed
through Cloudflare and Nginx Proxy Manager; each service's "via" field says which.
Use the tools rather than guessing about service state. Keep answers short and practical:
this is a chat panel, not a document. If something is down, say what you checked and
suggest the next thing the owner could look at (container logs, NPM proxy host, Cloudflare
tunnel/DNS, certificate).`;

// --- Tools (all read-only) --------------------------------------------------

const ListInput = z.object({ category: z.string().optional() });
const CheckInput = z.object({ names: z.array(z.string()).optional() });
const StatsInput = z.object({});

const tools = [
  {
    name: "list_services",
    description:
      "List services on the dashboard with their category, public URL, description and how they are routed (cloudflare/npm/lan). Optionally filter by category name.",
    input_schema: {
      type: "object",
      properties: { category: { type: "string", description: "Category name, e.g. Media" } },
    },
    eager_input_streaming: true,
  },
  {
    name: "check_services",
    description:
      "Ping services and return up/down/degraded state, HTTP code and latency. Pass service names to check specific ones, or omit to check everything.",
    input_schema: {
      type: "object",
      properties: { names: { type: "array", items: { type: "string" } } },
    },
    eager_input_streaming: true,
  },
  {
    name: "server_stats",
    description: "Read host uptime, load average, memory and root disk usage for the machine running the dashboard.",
    input_schema: { type: "object", properties: {} },
    eager_input_streaming: true,
  },
];

const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;

const handlers = {
  async list_services({ category }) {
    const services = allServices(await loadConfig()).filter(
      (s) => !category || s.category.toLowerCase() === category.toLowerCase(),
    );
    return services.map(({ name, category, url, description, via, tags }) => ({
      name, category, url, description, via, tags,
    }));
  },
  async check_services({ names }) {
    const wanted = names?.map((n) => n.toLowerCase());
    const services = allServices(await loadConfig()).filter(
      (s) => !wanted || wanted.includes(s.name.toLowerCase()),
    );
    if (services.length === 0) return { error: "No matching services. Call list_services for names." };
    const results = await Promise.all(services.map(checkService));
    return services.map((s, i) => ({ name: s.name, via: s.via, ...results[i] }));
  },
  async server_stats() {
    const disk = await statfs("/").catch(() => null);
    return {
      hostname: os.hostname(),
      uptimeHours: +(os.uptime() / 3600).toFixed(1),
      loadAverage: os.loadavg().map((n) => +n.toFixed(2)),
      cpus: os.cpus().length,
      memory: { total: gb(os.totalmem()), free: gb(os.freemem()) },
      rootDisk: disk && {
        total: gb(disk.blocks * disk.bsize),
        free: gb(disk.bavail * disk.bsize),
      },
      note: "When running in Docker these figures describe the container's view of the host.",
    };
  },
};

const schemas = { list_services: ListInput, check_services: CheckInput, server_stats: StatsInput };

async function runTool(block) {
  const schema = schemas[block.name];
  if (!schema) return { content: `Unknown tool ${block.name}`, is_error: true };
  // Eager input streaming means the server doesn't validate inputs - do it here.
  const parsed = schema.safeParse(block.input ?? {});
  if (!parsed.success) {
    return { content: JSON.stringify({ INVALID_JSON: JSON.stringify(block.input) }), is_error: true };
  }
  try {
    return { content: JSON.stringify(await handlers[block.name](parsed.data)) };
  } catch (err) {
    return { content: `Tool failed: ${err.message}`, is_error: true };
  }
}

// --- Sessions ----------------------------------------------------------------
// History stays server-side and is only ever appended to, so thinking blocks are
// passed back exactly as the API returned them.

const sessions = new Map();

function getSession(id) {
  if (id && sessions.has(id)) return { id, messages: sessions.get(id) };
  const newId = randomUUID();
  const messages = [];
  sessions.set(newId, messages);
  if (sessions.size > MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
  return { id: newId, messages };
}

export function resetSession(id) {
  sessions.delete(id);
}

// --- Chat loop ---------------------------------------------------------------

/**
 * Run one user turn. `emit(event, data)` streams progress to the browser.
 */
export async function chat({ sessionId, text }, emit) {
  const session = getSession(sessionId);
  emit("session", { id: session.id });
  const { messages } = session;
  const startLen = messages.length;
  messages.push({ role: "user", content: text });
  try {
    await runTurns(messages, emit);
  } catch (err) {
    messages.length = startLen; // roll back the failed turn so the session stays valid
    throw err;
  }
}

async function runTurns(messages, emit) {

  let jsonRetries = 0;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const stream = getClient().beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      system: SYSTEM,
      thinking: { type: "adaptive" },
      output_config: { effort: EFFORT },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default", // re-run on Anthropic's recommended model if a request is declined
      tools,
      messages,
    });
    stream.on("text", (delta) => emit("text", { delta }));

    let message;
    try {
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (err) {
      // Only an unparseable tool input is retried; API errors go to the caller.
      if (err instanceof Anthropic.APIError || jsonRetries++ >= 2) throw err;
      continue;
    }

    if (message.stop_reason === "refusal") {
      throw new Error("The model declined to answer that.");
    }

    messages.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "pause_turn") continue;

    const toolUses = message.content.filter((b) => b.type === "tool_use");
    if (toolUses.length === 0) return;

    if (message.stop_reason === "max_tokens") {
      throw new Error("Response was cut off while calling a tool.");
    }

    for (const t of toolUses) emit("tool", { name: t.name });
    const results = await Promise.all(toolUses.map(runTool));
    // All results go back in a single user message.
    messages.push({
      role: "user",
      content: toolUses.map((t, i) => ({ type: "tool_result", tool_use_id: t.id, ...results[i] })),
    });
  }
  emit("text", { delta: "\n\n_(Stopped after too many tool steps.)_" });
}
