import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CONFIG_PATH = process.env.SERVICES_CONFIG
  ? path.resolve(process.env.SERVICES_CONFIG)
  : existsSync(path.join(root, "config/services.yaml"))
    ? path.join(root, "config/services.yaml")
    : path.join(root, "config/services.example.yaml");

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

// Re-read on every call so edits apply without a restart.
export async function loadConfig() {
  const raw = YAML.parse(await readFile(CONFIG_PATH, "utf8")) ?? {};
  const categories = (raw.categories ?? []).map((cat) => ({
    name: cat.name,
    icon: cat.icon ?? "",
    services: (cat.services ?? [])
      .filter((s) => s?.name && s?.url)
      .map((s) => ({
        id: slug(`${cat.name}-${s.name}`),
        name: s.name,
        url: s.url,
        check: s.check === false ? null : (s.check ?? s.url),
        icon: s.icon ?? "",
        description: s.description ?? "",
        via: s.via ?? "",
        insecure: Boolean(s.insecure),
        tags: s.tags ?? [],
        category: cat.name,
      })),
  }));
  return {
    title: raw.title ?? "Home Server",
    subtitle: raw.subtitle ?? "",
    categories,
  };
}

export const allServices = (config) => config.categories.flatMap((c) => c.services);

// Strip internal check URLs before sending config to the browser.
export function publicConfig(config) {
  return {
    ...config,
    categories: config.categories.map((c) => ({
      ...c,
      services: c.services.map(({ check, insecure, ...rest }) => ({ ...rest, monitored: Boolean(check) })),
    })),
  };
}
