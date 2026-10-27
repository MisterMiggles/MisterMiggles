import http from "node:http";
import https from "node:https";
import { allServices } from "./config.js";

const TIMEOUT_MS = Number(process.env.STATUS_TIMEOUT_MS ?? 5000);
const CACHE_MS = Number(process.env.STATUS_CACHE_MS ?? 20000);
const cache = new Map(); // id -> { at, result }

function probe(service) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(service.check);
    } catch {
      return resolve({ state: "unknown", detail: "invalid check URL" });
    }
    const lib = url.protocol === "https:" ? https : http;
    const started = performance.now();
    const req = lib.request(
      url,
      {
        method: "GET",
        timeout: TIMEOUT_MS,
        rejectUnauthorized: !service.insecure,
        headers: { "user-agent": "MisterMiggles-Hub/1.0" },
      },
      (res) => {
        res.resume(); // drain, we only need the status code
        const ms = Math.round(performance.now() - started);
        // 401/403 still means the app answered (it is just behind auth).
        const state = res.statusCode < 500 ? "up" : "degraded";
        resolve({ state, code: res.statusCode, ms });
      },
    );
    req.on("timeout", () => req.destroy(new Error("timed out")));
    req.on("error", (err) => resolve({ state: "down", detail: err.code ?? err.message }));
    req.end();
  });
}

export async function checkService(service) {
  if (!service.check) return { state: "unmonitored" };
  const hit = cache.get(service.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;
  const result = { ...(await probe(service)), checkedAt: new Date().toISOString() };
  cache.set(service.id, { at: Date.now(), result });
  return result;
}

export async function checkAll(config) {
  const services = allServices(config);
  const results = await Promise.all(services.map(checkService));
  return Object.fromEntries(services.map((s, i) => [s.id, results[i]]));
}
