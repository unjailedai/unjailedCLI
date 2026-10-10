import fs from "node:fs";

/** The one place to change the API endpoint. Override with UNJAILED_BASE_URL or "baseUrl" in config.json. */
export const DEFAULT_BASE_URL = "https://unjailedai.com/v1";

/** Used until the user picks one with /model (falls back to the first model the API lists). */
export const DEFAULT_MODEL = "glm-5.3";

/** Agent tools for a fresh install: the full coding toolkit, with every write,
 *  launch and command confirmed by the user. Change with /tools. */
export const DEFAULT_TOOLS = "cmds" as const;

export const BRAND_BLUE = "#7DD3FC";
export const BRAND_DARK = "#0C4A6E";

const timeoutEnv = Number(process.env.UNJAILED_TIMEOUT);
/** Seconds to wait for the server to respond. Default 120 — reasoning models
 *  think for 30-60s+ BEFORE the first token; a 30s header timeout killed
 *  legit requests ("Timed out waiting for unjailedai.com"). UNJAILED_TIMEOUT overrides. */
const TIMEOUT_S = Number.isFinite(timeoutEnv) && timeoutEnv > 0 ? timeoutEnv : 120;
export const REQUEST_TIMEOUT_MS = TIMEOUT_S * 1000; // waiting for response headers
export const STREAM_IDLE_TIMEOUT_MS = TIMEOUT_S * 1000; // max silence mid-stream

export const VERSION: string = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return String(pkg.version);
  } catch {
    return "0.0.0";
  }
})();
