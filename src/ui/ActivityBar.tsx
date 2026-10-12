import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import stringWidth from "string-width";
import { colorLevel, theme, tone } from "../theme.js";
import { clip } from "./tool-format.js";

/**
 * The live status shown for the whole of a turn, so it is always clear what
 * every agent is doing:
 *
 *   ✻ Coordinating agents… (1m 12s · ↓ 3.4k tokens · esc esc to stop · ctrl+t agents)
 *     ⎿  ◐ Find auth call sites  Search("login")   14s · ↑8.2k ↓1.1k
 *        ✓ Review tests  done                      31s · ↑5k ↓900
 *
 * Ctrl+T expands it into a table with every agent's status, time, tool uses
 * and input / output / reasoning tokens (the main agent included).
 */

export type Phase = "waiting" | "thinking" | "writing" | "tool" | "approval" | "subagents" | "evaluating" | "retrying";

export interface Activity {
  phase: Phase;
  /** What is happening right now, e.g. a tool title. Already formatted. */
  detail?: string;
  startedAt: number;
  /** Output tokens this turn across all agents (reported where available, else estimated). */
  tokens: number;
  retry?: { until: number; attempt: number; reason: string };
}

/** Live statistics for one agent: the main agent or a subagent. */
export interface AgentStat {
  id: string;
  label: string;
  main?: boolean;
  status: "queued" | "running" | "done" | "failed";
  /** What a running agent is doing. */
  state?: Phase;
  detail?: string;
  startedAt: number;
  endedAt?: number;
  toolUses?: number;
  /** Prompt tokens summed over the agent's requests. */
  tokensIn?: number;
  /** Completion tokens (reported, or estimated while streaming). */
  tokens?: number;
  /** Reasoning tokens (reported by the server, or estimated from streamed thinking). */
  reasoning?: number;
  phase?: string;
  /** Requests sent and transient failures retried (verbose stats). */
  requests?: number;
  retries?: number;
}

/** A task in the panel is one agent's stats. */
export type Task = AgentStat;

export interface TaskGroup {
  title: string;
  phase?: string;
  tasks: AgentStat[];
}

export interface LiveView {
  activity: Activity;
  main: AgentStat;
  groups: TaskGroup[];
  /** Every agent of this turn, finished ones included (the expanded view). */
  all?: AgentStat[];
  /** Counters for the verbose stats panel. */
  stats?: TurnStats;
}

/** Live counters for one turn (/verbose stats). */
export interface TurnStats {
  /** Requests the main agent sent, retries included. */
  requests: number;
  retries: number;
  /** Automatic recoveries: resumed replies, nudges, continues. */
  recoveries: number;
  /** Time to first token of the latest request, and the average. */
  ttftLastMs?: number;
  ttftTotalMs: number;
  ttftCount: number;
  /** When output first arrived this turn, for throughput. */
  firstOutputAt?: number;
  /** Prompt size of the latest request (context in use). */
  contextTokens?: number;
  /** Tool calls by kind, main agent and subagents together. */
  tools: Record<string, number>;
}

/** Running totals for the whole session (/verbose stats, /stats). */
export interface SessionStats {
  turns: number;
  workMs: number;
  requests: number;
  retries: number;
  recoveries: number;
  tokensIn: number;
  tokens: number;
  reasoning: number;
  tools: number;
  agents: number;
}

export const emptyTurnStats = (): TurnStats => ({ requests: 0, retries: 0, recoveries: 0, ttftTotalMs: 0, ttftCount: 0, tools: {} });
export const emptySessionStats = (): SessionStats => ({ turns: 0, workMs: 0, requests: 0, retries: 0, recoveries: 0, tokensIn: 0, tokens: 0, reasoning: 0, tools: 0, agents: 0 });

const label = (s: string) => theme.bold(s);
const sec = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : formatElapsed(ms));

/**
 * The verbose stats panel: this turn (requests, latency, throughput, tokens,
 * tools, agents, recoveries) and the session totals. Lines are fitted to the
 * width; nothing wraps.
 */
export function statsLines(view: LiveView, sessionBefore: SessionStats, now: number, width: number, live = true): string[] {
  // Live, the session line includes the turn in progress.
  const session = live ? addTurnToSession(sessionBefore, view, now - view.activity.startedAt) : sessionBefore;
  const st = view.stats ?? emptyTurnStats();
  const agents = (view.all ?? [view.main]).filter((a) => !a.main);
  const everyone = view.all ?? [view.main];
  const sum = (k: "tokensIn" | "tokens" | "reasoning") => everyone.reduce((n, a) => n + (a[k] ?? 0), 0);
  const tin = sum("tokensIn");
  const tout = sum("tokens");
  const rsn = sum("reasoning");
  const subRequests = agents.reduce((n, a) => n + (a.requests ?? 0), 0);
  const subRetries = agents.reduce((n, a) => n + (a.retries ?? 0), 0);
  const requests = st.requests + subRequests;
  const retries = st.retries + subRetries;
  const outSecs = st.firstOutputAt ? Math.max(0.5, (now - st.firstOutputAt) / 1000) : 0;
  const rate = outSecs ? Math.round(tout / outSecs) : 0;
  const toolTotal = Object.values(st.tools).reduce((a, b) => a + b, 0);
  const kinds = (["read", "edit", "shell", "web", "agent", "other"] as const).filter((k) => st.tools[k]).map((k) => `${k} ${st.tools[k]}`);
  const running = agents.filter((a) => a.status === "running").length;
  const done = agents.filter((a) => a.status === "done").length;
  const failed = agents.filter((a) => a.status === "failed").length;

  const line1 = [
    `${label("Requests")} ${requests}${retries ? tone.retrying(` (${retries} retried)`) : ""}`,
    st.ttftLastMs !== undefined ? `${label("first token")} ${sec(st.ttftLastMs)}${st.ttftCount > 1 ? ` (avg ${sec(st.ttftTotalMs / st.ttftCount)})` : ""}` : "",
    rate ? `${label("speed")} ${rate} tok/s` : "",
    st.contextTokens ? `${label("context")} ${formatTokens(st.contextTokens)}` : "",
  ];
  const line2 = [
    `${label("Tokens")} ↑ ${formatTokens(tin)} in`,
    `↓ ${formatTokens(tout)} out`,
    rsn ? tone.thinking(`∴ ${formatTokens(rsn)} thinking`) : "",
    `Σ ${formatTokens(tin + tout)}`,
  ];
  const line3 = [
    `${label("Tools")} ${toolTotal}${kinds.length ? ` (${kinds.join(", ")})` : ""}`,
    agents.length ? `${label("Agents")} ${agents.length}${running ? ` · ${running} running` : ""}${done ? ` · ${done} done` : ""}${failed ? tone.failed(` · ${failed} failed`) : ""}` : "",
    st.recoveries ? `${label("recoveries")} ${st.recoveries}` : "",
  ];
  const line4 = [
    `${label("Session")} ${session.turns} turn${session.turns === 1 ? "" : "s"}`,
    formatElapsed(session.workMs),
    `↑ ${formatTokens(session.tokensIn)}`,
    `↓ ${formatTokens(session.tokens)}`,
    session.reasoning ? `∴ ${formatTokens(session.reasoning)}` : "",
    `${session.tools} tools`,
    `${session.requests} requests`,
    session.retries ? `${session.retries} retried` : "",
  ];
  const fit = (parts: string[]) => {
    const kept = parts.filter(Boolean);
    while (kept.length > 1 && visible(kept.join(theme.dim(" · "))) > width) kept.pop();
    const line = kept.join(theme.dim(" · "));
    // A single item wider than the terminal is clipped rather than wrapped.
    return visible(line) > width ? clip(strip(line), width) : line;
  };
  return [fit(line1), fit(line2), fit(line3), theme.dim(strip(fit(line4)))];
}

/** Add a finished turn's numbers to the session totals. */
export function addTurnToSession(session: SessionStats, view: LiveView, elapsedMs: number): SessionStats {
  const st = view.stats ?? emptyTurnStats();
  const everyone = view.all ?? [view.main];
  const agents = everyone.filter((a) => !a.main);
  return {
    turns: session.turns + 1,
    workMs: session.workMs + elapsedMs,
    requests: session.requests + st.requests + agents.reduce((n, a) => n + (a.requests ?? 0), 0),
    retries: session.retries + st.retries + agents.reduce((n, a) => n + (a.retries ?? 0), 0),
    recoveries: session.recoveries + st.recoveries,
    tokensIn: session.tokensIn + everyone.reduce((n, a) => n + (a.tokensIn ?? 0), 0),
    tokens: session.tokens + everyone.reduce((n, a) => n + (a.tokens ?? 0), 0),
    reasoning: session.reasoning + everyone.reduce((n, a) => n + (a.reasoning ?? 0), 0),
    tools: session.tools + Object.values(st.tools).reduce((a, b) => a + b, 0),
    agents: session.agents + agents.length,
  };
}

const VERBS: Record<Phase, string> = {
  waiting: "Waiting for model",
  thinking: "Thinking",
  writing: "Writing",
  tool: "Running",
  approval: "Waiting for your approval",
  subagents: "Coordinating agents",
  evaluating: "Checking goal",
  retrying: "Reconnecting",
};

const STATE_WORD: Record<Phase, string> = {
  waiting: "waiting for model",
  thinking: "thinking",
  writing: "writing",
  tool: "running",
  approval: "needs approval",
  subagents: "coordinating",
  evaluating: "checking goal",
  retrying: "reconnecting",
};

const PHASE_TONE: Record<Phase, (s: string) => string> = {
  waiting: tone.waiting,
  thinking: tone.thinking,
  writing: tone.writing,
  tool: tone.tool,
  approval: tone.approval,
  subagents: tone.agent,
  evaluating: tone.goal,
  retrying: tone.retrying,
};

const plainGlyphs = colorLevel === 0 || (process.platform === "win32" && !process.env.WT_SESSION);
const STAR = plainGlyphs ? ["-", "\\", "|", "/"] : ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"];
const ORBIT = plainGlyphs ? ["-", "\\", "|", "/"] : ["◐", "◓", "◑", "◒"];

export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 100_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (n < 1_000_000) return Math.round(n / 1000) + "k";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const visible = (s: string) => stringWidth(strip(s));
const padTo = (s: string, w: number, right = false) => {
  const gap = Math.max(0, w - visible(s));
  return right ? " ".repeat(gap) + s : s + " ".repeat(gap);
};

/** Clip text that carries one leading color code, keeping that color. */
function clipVisible(s: string, max: number): string {
  if (visible(s) <= max) return s;
  const lead = /^(\x1b\[[0-9;]*m)+/.exec(s)?.[0] ?? "";
  return lead + clip(strip(s), max) + (lead ? "\x1b[0m" : "");
}

/** One status line, fitted to `width` by dropping the least useful parts first. */
export function statusLine(a: Activity, now: number, frame: string, width: number, hint: string): string {
  const verb = VERBS[a.phase];
  const color = PHASE_TONE[a.phase];
  const parts = [formatElapsed(now - a.startedAt)];
  if (a.tokens > 0) parts.push(`↓ ${formatTokens(a.tokens)} tokens`);
  const tail = hint ? ` · ${hint}` : "";
  const head = `${frame} ${verb}…`;
  const fixed = stringWidth(head) + stringWidth(` (${parts.join(" · ")}${tail})`);
  let detail = a.detail ? clip(strip(a.detail), Math.max(0, width - fixed - 5)) : "";
  if (detail.length < 4) detail = "";
  const inside = [...parts, ...(detail ? [detail] : [])].join(" · ") + tail;
  let line = `${color(frame)} ${theme.bold(color(verb + "…"))} ${theme.dim(`(${inside})`)}`;
  if (visible(line) > width - 1) line = `${color(frame)} ${theme.bold(color(verb + "…"))} ${theme.dim(`(${parts[0]})`)}`;
  return line;
}

function icon(t: AgentStat, frame: string): string {
  if (t.status === "done") return tone.done("✓");
  if (t.status === "failed") return tone.failed("✗");
  if (t.status === "queued") return theme.dim("○");
  return PHASE_TONE[t.state ?? "waiting"](frame);
}

/** What the agent is doing, in its phase color. */
function stateText(t: AgentStat): string {
  if (t.status === "done") return tone.done("done");
  if (t.status === "failed") return tone.failed(t.detail ? `failed: ${t.detail}` : "failed");
  if (t.status === "queued") return theme.dim("queued");
  const st = t.state ?? "waiting";
  // A tool title says more than "running"; thinking/writing speak for themselves.
  // A thinking subagent's detail is its latest thought (verbose only).
  const word = (st === "tool" || st === "retrying" || st === "approval" || (st === "thinking" && t.detail?.startsWith("∴"))) && t.detail ? t.detail : STATE_WORD[st];
  return PHASE_TONE[st](word);
}

const io = (t: AgentStat) => [t.tokensIn ? `↑${formatTokens(t.tokensIn)}` : "", t.tokens ? `↓${formatTokens(t.tokens)}` : ""].filter(Boolean).join(" ");

/** A compact one-line row for the panel under the status line. */
export function taskLine(t: AgentStat, now: number, frame: string, width: number): string {
  const time = t.status === "queued" ? "" : formatElapsed((t.endedAt ?? now) - t.startedAt);
  // Narrow terminals drop the token counts, then the state; the label stays readable.
  const tokens = width >= 72 ? io(t) : "";
  const meta = [time, tokens].filter(Boolean).join(" · ");
  const room = Math.max(8, width - 4 - stringWidth(meta));
  const label = clip(t.label, Math.min(36, width >= 60 ? Math.floor(room * 0.5) : room));
  const left = room - stringWidth(label) - 2;
  const state = left >= 8 ? clipVisible(stateText(t), left) : "";
  return `${icon(t, frame)} ${t.status === "running" ? theme.bold(label) : label}${state ? "  " + state : ""}${meta ? "  " + theme.dim(meta) : ""}`;
}

/**
 * The detailed agents table (Ctrl+T, and /agents). Columns drop out from the
 * right as the terminal narrows: reasoning, input, tools.
 */
export function agentsTable(rows: AgentStat[], width: number, now: number, frame: string): string[] {
  const inner = Math.max(30, width);
  const cols = { time: 8, tools: 6, tin: 8, tout: 8, rsn: 9 };
  const show = { rsn: inner >= 96, tin: inner >= 80, tools: inner >= 64 };
  const fixed = cols.time + (show.tools ? cols.tools : 0) + (show.tin ? cols.tin : 0) + cols.tout + (show.rsn ? cols.rsn : 0);
  const nameW = Math.min(30, Math.max(10, Math.floor((inner - fixed - 3) * 0.4)));
  const stateW = Math.max(6, inner - fixed - nameW - 3);
  const numbers = (time: string, tools: string, tin: string, tout: string, rsn: string, think = (s: string) => s) =>
    padTo(time, cols.time, true) + (show.tools ? padTo(tools, cols.tools, true) : "") + (show.tin ? padTo(tin, cols.tin, true) : "") + padTo(tout, cols.tout, true) + (show.rsn ? think(padTo(rsn, cols.rsn, true)) : "");
  const lines = [theme.dim(padTo("  Agent", nameW + 2) + " " + padTo("Status", stateW) + numbers("Time", "Tools", "↑ In", "↓ Out", "∴ Think"))];
  for (const t of rows) {
    const time = t.status === "queued" ? "–" : formatElapsed((t.endedAt ?? now) - t.startedAt);
    const label = clip(t.label, nameW);
    const name = t.main ? theme.brand(label) : t.status === "running" ? theme.bold(label) : label;
    lines.push(
      `${icon(t, frame)} ${padTo(name, nameW)} ${padTo(clipVisible(stateText(t), stateW - 1), stateW)}` +
        numbers(theme.dim(time), String(t.toolUses ?? 0), t.tokensIn ? formatTokens(t.tokensIn) : "–", t.tokens ? formatTokens(t.tokens) : "–", t.reasoning ? formatTokens(t.reasoning) : "–", tone.thinking),
    );
  }
  if (rows.length > 1) {
    const sum = (k: "tokensIn" | "tokens" | "reasoning" | "toolUses") => rows.reduce((n, t) => n + (t[k] ?? 0), 0);
    lines.push(theme.dim(padTo("  Total", nameW + 2) + " " + padTo(`${rows.length} agents`, stateW) + numbers("", String(sum("toolUses")), formatTokens(sum("tokensIn")), formatTokens(sum("tokens")), formatTokens(sum("reasoning")))));
  }
  return lines;
}

/** `read` is polled on every animation frame, so fast-changing counters
 *  (tokens, the current tool) never force the whole app to re-render. */
export function ActivityBar({ read, width, hint, maxTaskRows = 8, expanded = false, stats }: { read: () => LiveView; width: number; hint: string; maxTaskRows?: number; expanded?: boolean; stats?: () => SessionStats }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 120);
    return () => clearInterval(t);
  }, []);
  const { activity, main, groups, all } = read();
  const now = Date.now();
  const frame = STAR[tick % STAR.length]!;
  const orbit = ORBIT[Math.floor(tick / 2) % ORBIT.length]!;
  const subagents = groups.reduce((n, g) => n + g.tasks.length, 0);
  const toggle = width >= 90 ? `ctrl+t ${expanded ? "collapse" : "agents"}` : "";
  const fullHint = [hint, subagents || expanded ? toggle : ""].filter(Boolean).join(" · ");
  const statRows = stats ? statsLines(read(), stats(), now, Math.max(20, width - 6)) : [];
  const statsBox = statRows.length ? (
    <Box flexDirection="column" marginTop={1}>
      {statRows.map((r, i) => (
        <Text key={i} wrap="truncate-end">
          {theme.dim(i === 0 ? "  ▸ " : "    ")}
          {r}
        </Text>
      ))}
    </Box>
  ) : null;
  const retrySecs = activity.retry ? Math.max(0, Math.ceil((activity.retry.until - now) / 1000)) : 0;
  const retryRow = activity.retry ? tone.retrying(clip(`⚠ ${activity.retry.reason} — retrying ${retrySecs ? `in ${retrySecs}s` : "now"} (attempt ${activity.retry.attempt})`, width - 8)) : null;

  if (expanded) {
    const rows = all?.length ? all : [main, ...groups.flatMap((g) => g.tasks)];
    // Keep the main agent and running agents in view when the list is long.
    const order = [rows[0]!, ...rows.slice(1).sort((a, b) => rank(a) - rank(b))];
    const shown = order.slice(0, Math.max(2, maxTaskRows + 1));
    const tableW = Math.min(width - 1, 124);
    const titles = groups.filter((g) => g.title).map((g) => `${g.title}${g.phase ? ` · ${g.phase}` : ""} · ${g.tasks.filter((t) => t.status === "done" || t.status === "failed").length}/${g.tasks.length} done`);
    return (
      <Box flexDirection="column">
        <Text wrap="truncate-end">{statusLine(activity, now, frame, width, fullHint)}</Text>
        {retryRow && <Text wrap="truncate-end">{"  " + retryRow}</Text>}
        <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} width={tableW}>
          <Text wrap="truncate-end">
            {theme.bold("Agents")}
            {titles.length ? theme.dim("  " + titles.join("  ·  ")) : ""}
          </Text>
          {agentsTable(shown, tableW - 4, now, orbit).map((l, i) => (
            <Text key={i} wrap="truncate-end">
              {l}
            </Text>
          ))}
          {rows.length > shown.length && <Text>{theme.dim(`… ${rows.length - shown.length} more`)}</Text>}
        </Box>
        {statsBox}
      </Box>
    );
  }

  const rows: string[] = [];
  if (retryRow) rows.push(retryRow);
  let budget = maxTaskRows;
  for (const g of groups) {
    if (budget <= 0) break;
    const done = g.tasks.filter((t) => t.status === "done" || t.status === "failed").length;
    if (g.title) {
      rows.push(`${theme.bold(tone.agent(clip(g.title, Math.max(10, width - 30))))}${g.phase ? theme.dim(` · ${g.phase}`) : ""}${theme.dim(` · ${done}/${g.tasks.length} agents`)}`);
      budget--;
    }
    // Running first, then queued, then finished (newest first): the active ones matter most.
    const order = [...g.tasks].sort((a, b) => rank(a) - rank(b) || (b.endedAt ?? 0) - (a.endedAt ?? 0));
    const shown = order.slice(0, Math.max(1, budget));
    for (const t of shown) rows.push(taskLine(t, now, orbit, width - 6));
    if (order.length > shown.length) rows.push(theme.dim(`… ${order.length - shown.length} more · ctrl+t to see all`));
    budget -= shown.length;
  }
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">{statusLine(activity, now, frame, width, fullHint)}</Text>
      {rows.map((r, i) => (
        <Text key={i} wrap="truncate-end">
          {theme.dim(i === 0 ? "  ⎿  " : "     ")}
          {r}
        </Text>
      ))}
      {statsBox}
    </Box>
  );
}

function rank(t: AgentStat): number {
  return t.status === "running" ? 0 : t.status === "queued" ? 1 : 2;
}
