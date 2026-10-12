import type { ToolDef } from "./tools.js";

/**
 * /loop — run a prompt (or slash command) again and again.
 *
 *   /loop 5m check the deploy      fixed interval (compact: 30s, 5m, 2h, 1h30m; 10s to 7d), from the end of each run
 *   /loop check the deploy every 2h
 *   /loop babysit the PR           self-paced: the agent picks each delay (60s-1h) with schedule_next; default 10m
 *   /loop                          show status
 *   /loop resume                   continue a loop paused by stopping a run
 *   /loop stop                     cancel
 */
export interface LoopSpec {
  prompt: string;
  /** null = self-paced (the model chooses each delay). */
  intervalMs: number | null;
}

export interface LoopState extends LoopSpec {
  id: number;
  iteration: number;
  startedAt: number;
  /** When the next run is due; null while a run is in progress. */
  nextAt: number | null;
  lastReason?: string;
}

export const MIN_INTERVAL_MS = 10_000;
export const MAX_INTERVAL_MS = 7 * 24 * 3600_000;
export const DYNAMIC_MIN_S = 60;
export const DYNAMIC_MAX_S = 3600;
/** Self-paced loops that never call schedule_next run again after this. */
export const DYNAMIC_DEFAULT_S = 600;

const UNIT: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "90s", "5m", "1h30m", "2 hours" → milliseconds; null if not a duration. */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase();
  const re = /(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h|days?|d)/gy;
  let total = 0;
  let matched = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    total += Number(m[1]) * UNIT[m[2]![0]!]!;
    matched = re.lastIndex;
    while (t[re.lastIndex] === " ") re.lastIndex++;
  }
  return matched && t.slice(matched).trim() === "" && total > 0 ? Math.round(total) : null;
}

export function parseLoopArgs(arg: string): LoopSpec | { error: string } {
  const text = arg.trim();
  if (!text) return { error: "Usage: /loop [interval] <prompt or /command> — e.g. /loop 5m check the build" };
  let intervalMs: number | null = null;
  let prompt = text;
  // A leading interval must be compact ("5m", "1h30m") so a prompt that starts
  // with a number ("2 hours of logs to scan") isn't mistaken for one.
  const lead = text.match(/^(\d+(?:\.\d+)?[smhd](?:\d+(?:\.\d+)?[smhd])*)\s+([\s\S]+)$/i);
  const trail = text.match(/^([\s\S]+?)\s+every\s+(\d+(?:\.\d+)?\s*[a-z]+(?:\s*\d+(?:\.\d+)?\s*[a-z]+)*)$/i);
  if (lead && parseDuration(lead[1]!) !== null) {
    intervalMs = parseDuration(lead[1]!);
    prompt = lead[2]!.trim();
  } else if (trail && parseDuration(trail[2]!) !== null) {
    intervalMs = parseDuration(trail[2]!);
    prompt = trail[1]!.trim();
  } else if (parseDuration(text) !== null) {
    return { error: "Add what to run after the interval, e.g. /loop 5m check the build" };
  }
  if (intervalMs !== null && intervalMs < MIN_INTERVAL_MS) return { error: `The shortest interval is ${formatDuration(MIN_INTERVAL_MS)}.` };
  if (intervalMs !== null && intervalMs > MAX_INTERVAL_MS) return { error: `The longest interval is ${formatDuration(MAX_INTERVAL_MS)}.` };
  if (/^\/loop\b/i.test(prompt)) return { error: "A loop can't start another loop." };
  return { prompt, intervalMs };
}

/** 65_000 → "1m 5s", 3_600_000 → "1h". */
export function formatDuration(ms: number): string {
  let s = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts = [d && `${d}d`, h && `${h}h`, m && `${m}m`, s && `${s}s`].filter(Boolean) as string[];
  return parts.slice(0, 2).join(" ") || "0s";
}

export function clampDynamicDelay(seconds: unknown): number {
  const n = typeof seconds === "number" ? seconds : Number(seconds);
  if (!Number.isFinite(n)) return DYNAMIC_DEFAULT_S;
  return Math.min(DYNAMIC_MAX_S, Math.max(DYNAMIC_MIN_S, Math.round(n)));
}

/** Offered to the model only during a self-paced /loop run. */
export const SCHEDULE_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "schedule_next",
    description: `You are running inside a self-paced /loop. Call this once, at the end of the run, to choose when the next run starts (${DYNAMIC_MIN_S}–${DYNAMIC_MAX_S} seconds; pick it from how fast the thing you are watching changes), or with stop:true when the loop's job is finished and it should end. If you never call it, the next run starts in ${DYNAMIC_DEFAULT_S / 60} minutes.`,
    parameters: {
      type: "object",
      properties: {
        delay_seconds: { type: "integer", minimum: DYNAMIC_MIN_S, maximum: DYNAMIC_MAX_S },
        reason: { type: "string", description: "One short sentence: why this delay, or why stopping." },
        stop: { type: "boolean", description: "End the loop instead of scheduling another run." },
      },
      additionalProperties: false,
    },
  },
};

/** Context line added to the system prompt for a loop run. */
export function loopSystemNote(loop: LoopState): string {
  const pace = loop.intervalMs === null
    ? "It is self-paced: finish the run, then call schedule_next to choose the delay (or stop:true when the job is done)."
    : `It repeats every ${formatDuration(loop.intervalMs)}; you do not schedule it.`;
  return `This turn is run ${loop.iteration} of a recurring /loop started by the user (prompt: ${JSON.stringify(loop.prompt.slice(0, 300))}). ${pace} Keep the reply short: report what changed since the previous run.`;
}
