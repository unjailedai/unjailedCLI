import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_BASE_URL } from "./constants.js";

export interface StoredConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  saveSessions?: boolean;
  effort?: Effort;
  tools?: "off" | "read" | "cmds" | "yolo";
  autoMode?: "ask" | "auto";
  plan?: boolean;
  /** Fun visual effects (startup wink, side snow, finish sparkle). Default on. */
  fx?: boolean;
  /** Show the model's thinking, subagent steps and full tool output (/verbose). */
  verbose?: boolean;
  /** true = a broken UNJAILED_API_KEY env var was bypassed; the saved key wins. */
  ignoreEnvKey?: boolean;
}

/** Reasoning effort sent as `reasoning_effort`; "auto" sends nothing and lets the model decide. */
export const EFFORTS = ["auto", "low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

export type KeySource = "env" | "config" | null;

/** ~/.unjailed on every OS (C:\Users\<you>\.unjailed on Windows). UNJAILED_HOME overrides. */
export function configDir(): string {
  return process.env.UNJAILED_HOME || path.join(os.homedir(), ".unjailed");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

// Written by the earlier `uj` CLI; read so existing users stay logged in.
function legacyAuthPath(): string {
  return path.join(configDir(), "auth.json");
}

function readJson(file: string): Record<string, unknown> {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

export function readConfig(): StoredConfig {
  const raw = readJson(configPath());
  const cfg: StoredConfig = {};
  if (typeof raw.apiKey === "string") cfg.apiKey = raw.apiKey;
  if (typeof raw.baseUrl === "string") cfg.baseUrl = raw.baseUrl;
  else if (typeof raw.base === "string") cfg.baseUrl = raw.base;
  if (typeof raw.model === "string") cfg.model = raw.model;
  if (typeof raw.saveSessions === "boolean") cfg.saveSessions = raw.saveSessions;
  if (typeof raw.effort === "string" && (EFFORTS as readonly string[]).includes(raw.effort)) cfg.effort = raw.effort as Effort;
  if (raw.tools === "off" || raw.tools === "read" || raw.tools === "cmds" || raw.tools === "yolo") cfg.tools = raw.tools;
  if (raw.autoMode === "auto" || raw.autoMode === "ask") cfg.autoMode = raw.autoMode;
  if (typeof raw.plan === "boolean") cfg.plan = raw.plan;
  if (typeof raw.fx === "boolean") cfg.fx = raw.fx;
  if (typeof raw.verbose === "boolean") cfg.verbose = raw.verbose;
  if (raw.ignoreEnvKey === true) cfg.ignoreEnvKey = true;
  if (!cfg.apiKey) {
    const legacy = readJson(legacyAuthPath());
    if (typeof legacy.key === "string") cfg.apiKey = legacy.key;
  }
  return cfg;
}

export function writeConfig(patch: Partial<StoredConfig>): void {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const current = readJson(configPath());
  const next: Record<string, unknown> = { ...current, ...patch };
  for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
  const file = configPath();
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  }
}

export function deleteKey(): void {
  writeConfig({ apiKey: undefined });
  try {
    fs.rmSync(legacyAuthPath());
  } catch {
    /* not present */
  }
}

export function resolveKey(): { key: string | null; source: KeySource } {
  const ignoreEnv = readConfig().ignoreEnvKey === true;
  const env = ignoreEnv ? null : process.env.UNJAILED_API_KEY?.trim();
  if (env) return { key: env, source: "env" };
  const k = readConfig().apiKey?.trim();
  return k ? { key: k, source: "config" } : { key: null, source: null };
}

export function resolveBaseUrl(): string {
  const url = process.env.UNJAILED_BASE_URL?.trim() || readConfig().baseUrl || DEFAULT_BASE_URL;
  return url.replace(/\/+$/, "");
}

/** sk-…a1b2 — never show more than the last four characters. */
export function maskKey(key: string | null | undefined): string {
  if (!key) return "none";
  const tail = key.length > 8 ? key.slice(-4) : "";
  const prefix = key.startsWith("sk-") ? "sk-" : "";
  return `${prefix}…${tail}`;
}
