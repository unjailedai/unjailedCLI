import React, { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, renderToString, Text, useApp, useInput, useStdout, type Key } from "ink";
import {
  AbortedError,
  ApiError,
  agentTurn,
  listModels,
  prepareRequestHistory,
  streamChatRetry,
  type AgentHandlers,
  type AgentMessage,
  type ChatMessage,
  type RetryInfo,
} from "../api.js";
import { COMMANDS, filterCommands, parseCommand, waitsForTurn } from "../commands.js";
import { configPath, deleteKey, EFFORTS, maskKey, readConfig, resolveBaseUrl, resolveKey, writeConfig, type Effort, type KeySource } from "../config.js";
import { executeTool, toolDefinitions, type ToolDef } from "../tools.js";
import { approvalAnswer } from "./approval.js";
import { currentVersion, latestVersion, runSelfUpdate } from "../updater.js";
import { recoverAuth, tryClearEnvKeyWindows } from "../auth-recovery.js";
import { createSkill, loadSkills, projectSkillsDir, skillsSystemPrompt, userSkillsDir, type Skill } from "../skills.js";
import { agentSystemPrompt } from "../system-prompt.js";
import { DEFAULT_MODEL } from "../constants.js";
import { renderMarkdown } from "../markdown.js";
import { theme, tone } from "../theme.js";
import { Header } from "./Header.js";
import { FinishFlourish } from "./Snow.js";
import { fxEnabled } from "./fx.js";
import { onFirstLine, onLastLine, Prompt, type EditorState } from "./Prompt.js";
import { SelectList } from "./SelectList.js";
import { Spinner } from "./Spinner.js";
import { useTerminalSize } from "./useTerminalSize.js";
import { StreamDisplayBuffer, retainDisplayWindow, streamingRowBudget } from "./stream-buffer.js";
import { ActivityBar, addTurnToSession, agentsTable, emptySessionStats, emptyTurnStats, formatElapsed, formatTokens, statsLines, type AgentStat, type LiveView, type Phase, type SessionStats, type Task, type TaskGroup } from "./ActivityBar.js";
import { clip, describeAction, formatToolBlock, parseArgs, toolKind, toolSummary, toolTitle } from "./tool-format.js";
import { sanitizeForDisplay } from "./sanitize.js";
import { Thinking } from "./Thinking.js";
import {
  deleteSession,
  findSession,
  listSessions,
  loadSession,
  newSession,
  prettyPath,
  pruneSessions,
  appendSession,
  sessionsDir,
  sessionsEnabled,
  timeAgo,
  titleFrom,
  MAX_PENDING_CHARS,
  MAX_SAVED_INPUTS,
  type PendingTurn,
  type Session,
  type SessionMeta,
} from "../sessions.js";
import stringWidth from "string-width";
import { randomUUID } from "node:crypto";
import { HISTORY_TOOL, identifyHistory, protectWorkingContext, searchHistory, workingContext, type ToolEvent } from "../context.js";
import { continuationPrompt, evaluateGoal, goalEvidence, kickoffPrompt, parseGoalArgs, type Goal } from "../goal.js";
import { clampDynamicDelay, DYNAMIC_DEFAULT_S, formatDuration, loopSystemNote, parseLoopArgs, SCHEDULE_TOOL, type LoopState } from "../loop.js";
import { AGENT_TOOL, runSubagent, WORKFLOW_TOOL } from "../agents.js";
import { listWorkflows, loadWorkflow, projectWorkflowsDir, readMeta, runWorkflow, saveWorkflow, userWorkflowsDir, WorkflowError, WORKFLOW_MAX_AGENTS } from "../workflow.js";

type Tone = "info" | "success" | "error" | "warn";

type Item =
  | { id: number; kind: "header"; model: string; loggedIn: boolean; keySource: KeySource }
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string; first: boolean }
  | { id: number; kind: "tool"; name: string; args: string; ok: boolean; output: string; note?: string; verbose?: boolean }
  | { id: number; kind: "thinking"; text: string }
  | { id: number; kind: "turn"; text: string; tone: Tone }
  | { id: number; kind: "info" | "success" | "error" | "warn" | "plain"; text: string };

// Omit distributed over the union so each variant keeps its own fields.
type NewItem = Item extends infer T ? (T extends Item ? Omit<T, "id"> : never) : never;

type Mode =
  | { type: "chat" }
  | { type: "login" }
  | { type: "picker"; models: string[] | null; selected: number }
  | { type: "sessions"; list: SessionMeta[]; selected: number; scope: "folder" | "all"; confirmDelete: boolean }
  | { type: "effort"; selected: number }
  | { type: "skills"; list: Skill[]; selected: number }
  | { type: "tool-permissions"; selected: number }
  | { type: "plan-approve"; steps: string[]; selected: number }; // 0 = start, 1 = cancel

const TOOL_CHOICES = [
  { key: "read", label: "Read-only", hint: "inspect files and start read-only subagents; no changes or commands" },
  { key: "cmds", label: "Files + commands", hint: "ask before each change or command" },
  { key: "yolo", label: "Automatic", hint: "write files and run commands without asking" },
  { key: "off", label: "Off", hint: "plain chat; no computer tools" },
] as const;

/** Streaming text that has not been moved into the transcript yet. */
interface Stream {
  text: string;
  hiddenCharacters: number;
  flushed: boolean;
  /** Verbose: the thinking paragraph being streamed right now. */
  thinking?: string;
}

/** What waits to run when the current turn ends. */
interface Queued {
  text: string;
  source: "user" | "goal" | "loop" | "command";
}

/** A saved workflow started directly with /workflow. */
interface DirectWorkflow {
  name: string;
  script: string;
  args: unknown;
}

interface Approval {
  title: string;
  body: string[];
  tool: string;
  agent?: string;
}

const NOT_LOGGED_IN = "Not logged in — type /login";
const EMPTY: EditorState = { value: "", cursor: 0 };

let nextId = 0;
const id = () => ++nextId;

function friendly(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof WorkflowError) return err.message;
  return "Something went wrong. Try again.";
}

/** Autosave interval (UNJAILED_AUTOSAVE_SECONDS, default 10). */
const AUTOSAVE_MS = (() => {
  const seconds = Number(process.env.UNJAILED_AUTOSAVE_SECONDS);
  return (Number.isFinite(seconds) && seconds >= 1 ? seconds : 10) * 1000;
})();

/** A new live view: the turn's activity plus the main agent's own stats row. */
function freshLive(phase: Phase, startedAt = Date.now()): LiveView {
  return {
    activity: { phase, startedAt, tokens: 0 },
    main: { id: "main", label: "main agent", main: true, status: "running", state: phase, startedAt, toolUses: 0, tokensIn: 0, tokens: 0, reasoning: 0 },
    groups: [],
  };
}

/** Thrown to leave the turn's try block early once a direct workflow is done. */
const DONE = Symbol("done");

export function App({ startup }: { startup?: "continue" | "resume" } = {}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const size = useTerminalSize();

  const [auth, setAuth] = useState(() => resolveKey());
  const [baseUrl] = useState(() => resolveBaseUrl());
  const [model, setModel] = useState(() => process.env.UNJAILED_MODEL || readConfig().model || DEFAULT_MODEL);
  const [effort, setEffort] = useState<Effort>(() => readConfig().effort ?? "auto");
  // Agent tools: "off" | "read" (read-only toolkit) | "cmds" (+changes, confirmed) | "yolo" (+changes, no confirm)
  const [toolsMode, setToolsMode] = useState<"off" | "read" | "cmds" | "yolo">(() => readConfig().tools ?? "off");
  /** Agent autonomy: ask (default) confirms commands · auto runs them */
  const [autoMode, setAutoMode] = useState<"ask" | "auto">(() => {
    // A stale auto setting never carries over into read/off access.
    const config = readConfig();
    return (config.tools === "cmds" || config.tools === "yolo") && config.autoMode === "auto" ? "auto" : "ask";
  });
  /** Plan mode: model writes a plan first, user approves, then it executes */
  const [planMode, setPlanMode] = useState<"off" | "on">(() => (readConfig().plan === false ? "off" : "on"));
  // Read by the running turn, so /tools and /auto take effect on its next action.
  const permissions = useRef({ toolsMode, autoMode });
  permissions.current = { toolsMode, autoMode };
  // Skills switched on for this chat (by name). Their files are re-read on every request.
  const [activeSkills, setActiveSkills] = useState<string[]>([]);

  const [items, setItems] = useState<Item[]>(() => [
    { id: id(), kind: "header", model, loggedIn: !!auth.key, keySource: auth.source },
  ]);
  const [staticKey, setStaticKey] = useState(0);
  const [mode, setMode] = useState<Mode>({ type: "chat" });
  const [editor, setEditor] = useState<EditorState>(EMPTY);
  const [slashSel, setSlashSel] = useState(0);
  // ↑ history survives restarts: seeded from the latest chat in this folder.
  const [history, setHistoryState] = useState<string[]>(() => {
    if (!sessionsEnabled()) return [];
    try {
      return listSessions().find((x) => x.cwd === process.cwd())?.inputs ?? [];
    } catch {
      return [];
    }
  });
  const historyRef = useRef(history);
  const setHistory = (update: (h: string[]) => string[]) => {
    setHistoryState((h) => {
      const next = update(h).slice(-MAX_SAVED_INPUTS);
      historyRef.current = next;
      return next;
    });
  };
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  /** True for the whole of a model turn (including tools, subagents, goal checks). */
  const [working, setWorking] = useState(false);
  const [stream, setStream] = useState<Stream | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  // Token usage for the current conversation: ctx = prompt tokens of the most
  // recent request (= current context size). approx when the server sent none.
  const [usage, setUsage] = useState<{ ctx: number; prompt: number; completion: number; approx: boolean } | null>(null);
  const [fx, setFx] = useState<boolean>(() => fxEnabled());
  /** /verbose: show thinking, subagent steps and full tool output. A ref too,
   *  so toggling mid-turn takes effect inside the running turn. */
  const [verbose, setVerboseState] = useState<boolean>(() => readConfig().verbose === true);
  const verboseRef = useRef(verbose);
  const setVerbose = (on: boolean) => {
    verboseRef.current = on;
    setVerboseState(on);
    writeConfig({ verbose: on });
  };
  const [approval, setApproval] = useState<Approval | null>(null);
  const [goal, setGoalState] = useState<Goal | null>(null);
  const [loop, setLoopState] = useState<LoopState | null>(null);
  const [queueTick, setQueueTick] = useState(0);

  const messages = useRef<ChatMessage[]>([]);
  const toolHistory = useRef<ToolEvent[]>([]);
  const notes = useRef<string[]>([]);
  const runningTurn = useRef(false);
  const quitRequested = useRef(false);
  const session = useRef<Session | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const exitArmed = useRef(false);
  const flashTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  // Prompts typed while a turn runs wait here. Plain messages typed during an
  // agent turn are delivered to the agent at its next tool step instead.
  const queueRef = useRef<Queued[]>([]);
  const [queueLen, setQueueLen] = useState(0);
  // Esc is two-stage while working: first press arms, second actually stops/skips.
  const escArmed = useRef(false);
  // Live activity, read by the ActivityBar on its own animation timer.
  const live = useRef<LiveView>(freshLive("waiting"));
  /** Every agent of the latest turn, for /agents after it ends. */
  const lastAgents = useRef<AgentStat[]>([]);
  /** Stats: the latest turn's live view, and running session totals. */
  const lastView = useRef<LiveView | null>(null);
  const sessionStats = useRef<SessionStats>(emptySessionStats());
  /** Ctrl+T: the detailed agents table instead of the compact panel. */
  const [agentsExpanded, setAgentsExpanded] = useState(false);
  const goalRef = useRef<Goal | null>(null);
  const loopRef = useRef<LoopState | null>(null);
  const loopSeq = useRef(0);
  /** Tools the user approved "for the rest of this session". */
  const alwaysAllow = useRef(new Set<string>());

  const setGoal = (g: Goal | null) => {
    goalRef.current = g;
    setGoalState(g ? { ...g } : null);
  };
  const setLoop = (l: LoopState | null) => {
    loopRef.current = l;
    setLoopState(l ? { ...l } : null);
  };

  const push = (...newItems: NewItem[]) => {
    setItems((prev) => retainDisplayWindow([...prev, ...newItems.map((it) => ({ ...it, id: id() }) as Item)]));
  };
  const info = (text: string) => push({ kind: "info", text });
  const success = (text: string) => push({ kind: "success", text });
  const error = (text: string) => push({ kind: "error", text });
  const warn = (text: string) => push({ kind: "warn", text });

  const syncQueueLen = () => setQueueLen(queueRef.current.length);

  const showFlash = (text: string, ms = 2000) => {
    setFlash(text);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => {
      setFlash(null);
      exitArmed.current = false;
      escArmed.current = false;
    }, ms);
  };

  // After a resize, wipe the screen and reprint the recent display window. Ink alone
  // can't erase lines that the terminal re-wrapped, which leaves broken frames behind.
  const firstSize = useRef(true);
  useEffect(() => {
    if (firstSize.current) {
      firstSize.current = false;
      return;
    }
    const t = setTimeout(() => {
      stdout.write("\x1b[2J\x1b[H");
      setItems((prev) => (prev[0]?.kind === "header" ? [{ ...prev[0], id: id(), model, loggedIn: !!auth.key, keySource: auth.source }, ...prev.slice(1).map((it) => ({ ...it, id: id() }))] : prev));
      setStaticKey((k) => k + 1);
    }, 120);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size.columns, size.rows]);

  // On startup, quietly make sure the saved model still exists.
  useEffect(() => {
    if (!auth.key) return;
    const ctrl = new AbortController();
    listModels(baseUrl, auth.key, ctrl.signal)
      .then((models) => {
        if (ctrl.signal.aborted || models.length === 0) return;
        setModel((current) => {
          if (models.some((m) => m.id === current)) return current;
          const fallback = models[0]!.id;
          info(`Model "${current}" isn't available — using ${fallback}. Change it with /model.`);
          return fallback;
        });
      })
      .catch(async (err) => {
        if (err instanceof ApiError && err.status === 401) {
          const healed = await recoverAuth(auth.source === "env" ? "env" : "config");
          if (healed) {
            setAuth({ key: healed.key, source: healed.source });
            success(healed.message);
            if (healed.action === "switched-saved") tryClearEnvKeyWindows();
            return;
          }
          error("Your API key was rejected. Type /login to enter a new one.");
        }
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Leaving the app (exit, or an embedder unmounting it) stops any running
  // turn, subagents and retry waits; otherwise they would keep going unseen.
  useEffect(() => () => abortRef.current?.abort(), []);

  // Exit on the next render so the live area (prompt, menus) is cleared first.
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    if (exiting) exit();
  }, [exiting, exit]);
  const quit = () => {
    abortRef.current?.abort();
    quitRequested.current = true;
    if (!runningTurn.current) setExiting(true);
  };

  // ---------- approvals ----------

  /** One approval at a time: parallel subagents wait their turn here. */
  const approvalChain = useRef<Promise<unknown>>(Promise.resolve());
  const approvalAnswerRef = useRef<((answer: boolean | "always") => void) | null>(null);
  const approvalArmedAt = useRef(0);

  const approvalBody = (name: string, args: Record<string, unknown>): string[] => {
    const w = Math.max(30, size.columns - 10);
    if (name === "run_command") {
      const lines = sanitizeForDisplay(String(args.command ?? "")).split("\n");
      return [...lines.slice(0, 6).map((l) => clip(l, w)), ...(lines.length > 6 ? [theme.dim(`… +${lines.length - 6} lines`)] : []), ...(args.cwd ? [theme.dim(`in ${String(args.cwd)}`)] : [])];
    }
    if (name === "write_file") {
      const content = sanitizeForDisplay(String(args.content ?? ""));
      const lines = content.split("\n");
      return [theme.dim(`${lines.length} line${lines.length === 1 ? "" : "s"} · ${content.length.toLocaleString()} chars`), ...lines.slice(0, 6).map((l) => theme.ok(clip("+ " + l, w))), ...(lines.length > 6 ? [theme.dim(`… +${lines.length - 6} lines`)] : [])];
    }
    if (name === "edit_file") return toolSummary(name, args, true, "", w).slice(1);
    if (name === "workflow") {
      const script = typeof args.script === "string" ? args.script : loadWorkflow(String(args.name ?? ""))?.script ?? "";
      const meta = readMeta(script);
      return [
        meta?.description ? clip(meta.description, w) : theme.dim("(no description)"),
        theme.dim(`Runs a script that can start up to ${WORKFLOW_MAX_AGENTS} subagents, each with your current tool permissions.`),
      ];
    }
    return [theme.dim(clip(JSON.stringify(args), w))];
  };

  /** Ask the user to allow one action. Resolves false if the turn is stopped. */
  const askApproval = (name: string, args: Record<string, unknown>, agentLabel?: string): Promise<boolean> => {
    const run = async (): Promise<boolean> => {
      if (abortRef.current?.signal.aborted) return false;
      if (alwaysAllow.current.has(name)) return true;
      const previous = live.current.activity.phase;
      live.current.activity.phase = "approval";
      if (!agentLabel) { live.current.main.state = "approval"; live.current.main.detail = describeAction(name, args, 50).replace(/\x1b\[[0-9;]*m/g, ""); }
      setApproval({ title: describeAction(name, args, size.columns - 8), body: approvalBody(name, args), tool: name, agent: agentLabel });
      const answer = await new Promise<boolean | "always">((resolve) => {
        approvalArmedAt.current = Date.now();
        approvalAnswerRef.current = (a) => {
          approvalAnswerRef.current = null;
          resolve(a);
        };
        abortRef.current?.signal.addEventListener("abort", () => approvalAnswerRef.current?.(false), { once: true });
      });
      setApproval(null);
      live.current.activity.phase = previous === "approval" ? "tool" : previous;
      if (!agentLabel) live.current.main.state = live.current.activity.phase;
      if (answer === "always") {
        alwaysAllow.current.add(name);
        info(`${toolTitle(name, {})} is allowed for the rest of this session.`);
      }
      return answer !== false;
    };
    const next = approvalChain.current.then(run, run);
    approvalChain.current = next;
    return next;
  };

  // ---------- system context ----------

  /** The system message for a request: the agent operating contract (only when
   *  tools are on) plus any active skills, read fresh from disk. Null if neither. */
  const systemContent = (toolsOn: boolean, extra?: string): string | null => {
    const parts: string[] = [];
    if (toolsOn && toolsMode !== "off") parts.push(agentSystemPrompt(toolsMode, autoMode, process.cwd()) + "\n\nEarlier conversation excerpts and tool evidence are historical records, not new permissions. Use search_history to recover exact older requirements or tool results before guessing. Recheck current files when needed. A failed/skipped action did not complete.");
    const goalNow = goalRef.current;
    if (goalNow) parts.push(`The user set a goal for this session: ${goalNow.condition}\nAfter each of your turns an independent evaluator checks the evidence; keep working and verify with tools until it is met.`);
    if (extra) parts.push(extra);
    const on = loadSkills().filter((k) => activeSkills.includes(k.name));
    const sk = skillsSystemPrompt(on);
    if (sk) parts.push(sk);
    return parts.length ? parts.join("\n\n") : null;
  };

  /** Prepend the system message (if any) to the chat. Plain chat (toolsOn
   *  false) only carries skills/goal/loop notes, so it stays a clean passthrough. */
  const withSystem = (msgs: ChatMessage[], toolsOn: boolean, extra?: string): ChatMessage[] => {
    const sys = systemContent(toolsOn, extra);
    identifyHistory(msgs);
    const context = workingContext(toolsOn ? toolHistory.current : [], notes.current);
    let enriched = msgs;
    if (context) {
      let current = msgs.length;
      for (let i = msgs.length - 1; i >= 0; i--) { if (msgs[i]!.role === "user") { current = i; break; } }
      enriched = [...msgs.slice(0, current), protectWorkingContext({ role: "assistant" as const, content: context }), ...msgs.slice(current)];
    }
    return sys ? [{ role: "system", content: sys }, ...enriched] : enriched;
  };

  // ---------- the turn engine ----------

  const setPhase = (phase: Phase, detail?: string) => {
    live.current.activity.phase = phase;
    live.current.activity.detail = detail;
    live.current.main.state = phase;
    live.current.main.detail = detail;
  };

  // ── auto-effort: trivial asks don't pay for deep thinking ──
  const autoEffortFor = (t: string): Effort => {
    if (effort !== "auto") return effort; // user pinned a level: respect it
    const words = t.trim().split(/\s+/).length;
    const deep = /\b(why|how|explain|design|architect|debug|refactor|plan|analyz|compare|optimi[sz]e|write|build|implement|fix|test)\b/i.test(t);
    const trivial = /^(hi|hey|hello|yo|thanks|thank you|ok|okay|test|yes|no)\b/i.test(t.trim());
    if (trivial || (words <= 6 && !deep)) return "low";
    return "auto";
  };

  const sendChat = async (text: string, source: Queued["source"] = "user", direct?: DirectWorkflow) => {
    runningTurn.current = true;
    setWorking(true);
    try { await performTurn(text, source, direct); }
    finally {
      runningTurn.current = false;
      setWorking(false);
      if (quitRequested.current) setExiting(true);
    }
  };

  /** Subagent tool set: the same capabilities, minus the ability to spawn more agents. */
  const subagentTools = (): ToolDef[] => toolDefinitions(toolsMode);

  const performTurn = async (text: string, source: Queued["source"], direct?: DirectWorkflow) => {
    const loopRun = source === "loop" ? loopRef.current : null;
    if (!auth.key) {
      if (source === "user") push({ kind: "user", text });
      error(NOT_LOGGED_IN);
      await afterTurn("error", text, [], null, loopRun);
      return;
    }
    if (source === "user") push({ kind: "user", text });
    messages.current.push({ role: "user", content: text });
    const toolEventsBefore = toolHistory.current.length;
    const turnEvents: ToolEvent[] = [];

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const started = Date.now();
    // Save the prompt right away and after each tool; the autosave timer
    // keeps the partial reply current in between (see AUTOSAVE_MS).
    const pendingNow = (): PendingTurn => ({ startedAt: started, partial: full });
    pendingRef.current = pendingNow;
    const saveProgress = (_force = true) => void persist(pendingNow());
    live.current = freshLive("waiting", started);
    const main = live.current.main;
    const turnAgents: AgentStat[] = [main];
    live.current.all = turnAgents;
    const stats = emptyTurnStats();
    live.current.stats = stats;
    let requestStartedAt = 0;
    let awaitingFirstOutput = false;
    /** Time to first token, per request, for the verbose stats. */
    const markOutput = () => {
      const now = Date.now();
      stats.firstOutputAt ??= now;
      if (!awaitingFirstOutput) return;
      awaitingFirstOutput = false;
      stats.ttftLastMs = now - requestStartedAt;
      stats.ttftTotalMs += stats.ttftLastMs;
      stats.ttftCount++;
    };
    const countTool = (name: string) => {
      const kind = toolKind(name);
      stats.tools[kind] = (stats.tools[kind] ?? 0) + 1;
    };

    let full = ""; // assistant prose this turn, for the saved transcript
    let displayBuffer = new StreamDisplayBuffer();
    let flushedAny = false;
    let gotUsage = false;
    let requestContextChars = 0;
    let completionTokens = 0; // server-reported, all requests this turn incl. subagents
    let streamedChars = 0; // since the last usage report, for a live estimate
    let thinkingSince = 0;
    let trimNotified = false;
    let retrying = false;
    let timer: NodeJS.Timeout | undefined;
    let scheduleDecision: { delay: number; reason: string; stop: boolean } | null = null;
    let delivered = false; // a mid-turn message reached the agent; never roll it back

    let finishedAgentTokens = 0; // subagents that are done, even after their group leaves the panel
    let reportedReasoning = 0;
    let reasoningChars = 0; // streamed thinking since the last usage report
    const refreshTokens = () => {
      main.tokens = completionTokens + Math.round(streamedChars / 4);
      main.reasoning = reportedReasoning + Math.round(reasoningChars / 4);
      const running = live.current.groups.reduce((n, g) => n + g.tasks.reduce((m, t) => m + (t.status === "running" ? t.tokens ?? 0 : 0), 0), 0);
      live.current.activity.tokens = main.tokens + finishedAgentTokens + running;
    };

    const sync = () => {
      timer = undefined;
      // Move finished paragraphs into the transcript so the live area stays small.
      const completed = displayBuffer.drainSafe();
      if (completed) {
        const done = completed.replace(/\n+$/, "");
        if (done.trim()) {
          push({ kind: "assistant", text: done, first: !flushedAny });
          flushedAny = true;
        }
      }
      if (verboseRef.current) flushThinking(false);
      const preview = displayBuffer.preview();
      setStream({ text: preview.text, hiddenCharacters: preview.hiddenCharacters, flushed: flushedAny, thinking: verboseRef.current ? thinkingText : undefined });
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(sync, 80);
    };
    /** Print everything streamed so far, before a tool block or at the end. */
    const flushAll = () => {
      clearTimeout(timer);
      timer = undefined;
      const rest = displayBuffer.finish().replace(/\n+$/, "");
      if (rest.trim()) push({ kind: "assistant", text: rest, first: !flushedAny });
      displayBuffer = new StreamDisplayBuffer();
      flushedAny = false; // the next prose block after a tool gets its own bullet
      setStream(null);
    };
    // Verbose: thinking streams into the transcript paragraph by paragraph.
    let thinkingText = "";
    let thinkingShown = false;
    const flushThinking = (all: boolean) => {
      const cut = all ? thinkingText.length : thinkingText.lastIndexOf("\n\n");
      if (cut <= 0) return;
      const done = thinkingText.slice(0, cut).trim();
      thinkingText = thinkingText.slice(cut).replace(/^\n+/, "");
      if (done) {
        push({ kind: "thinking", text: done });
        thinkingShown = true;
      }
    };
    const endThinking = () => {
      flushThinking(true);
      thinkingText = "";
      if (!thinkingSince) return;
      const secs = (Date.now() - thinkingSince) / 1000;
      thinkingSince = 0;
      if (secs >= 2) push({ kind: "info", text: `✻ Thought for ${formatElapsed(secs * 1000)}${verboseRef.current ? "" : " · /verbose shows the thinking"}` });
      thinkingShown = false;
    };

    setStream({ text: "", hiddenCharacters: 0, flushed: false });
    saveProgress(true);
    let outcome: "done" | "stopped" | "error" = "done";
    let endNote = "";
    let errMsg = "";
    const useTools = toolsMode !== "off";

    const handlers: AgentHandlers = {
      onRequest: (context) => {
        requestContextChars = context.characters;
        stats.requests++;
        requestStartedAt = Date.now();
        awaitingFirstOutput = true;
        if (!retrying) setPhase("waiting");
      },
      onContextTrim: () => {
        if (trimNotified) return;
        trimNotified = true;
        info("Older request context compacted with exact excerpts; full history stays available. Pin key instructions with /remember. Agent tools can recover older text with search_history.");
      },
      onToken: (t) => {
        markOutput();
        clearRetry();
        endThinking();
        setPhase("writing");
        full += t;
        streamedChars += t.length;
        refreshTokens();
        displayBuffer.append(t);
        schedule();
      },
      onReasoning: (t) => {
        markOutput();
        clearRetry();
        if (!thinkingSince) thinkingSince = Date.now();
        setPhase("thinking", sanitizeForDisplay(t).replace(/\s+/g, " ").trim().slice(-60) || live.current.activity.detail);
        streamedChars += t.length;
        reasoningChars += t.length;
        refreshTokens();
        if (verboseRef.current) {
          thinkingText += t;
          schedule();
        }
      },
      onUsage: (u) => {
        gotUsage = true;
        stats.contextTokens = u.prompt;
        completionTokens += u.completion;
        main.tokensIn = (main.tokensIn ?? 0) + u.prompt;
        // The server's reasoning count wins over the estimate from streamed thinking.
        reportedReasoning += u.reasoning ?? Math.round(reasoningChars / 4);
        reasoningChars = 0;
        streamedChars = 0;
        refreshTokens();
        // In agent mode onUsage fires each round; the latest request's prompt
        // count is the live context size.
        setUsage({ ctx: u.prompt, prompt: u.prompt, completion: u.completion, approx: false });
      },
      onNotice: (note) => {
        stats.recoveries++;
        // Print what streamed so far first, so the note sits after the text it is about.
        flushAll();
        if (full && !full.endsWith("\n\n")) full += "\n\n";
        warn(note);
      },
      onRetry: (r: RetryInfo) => {
        stats.retries++;
        const reason = r.reason.replace(/[.\s]+$/, "");
        if (!retrying) warn(`${reason} — retrying automatically until the service responds. Esc Esc to stop.`);
        retrying = true;
        live.current.activity.retry = { until: r.until, attempt: r.attempt + 1, reason };
        setPhase("retrying");
      },
      onRecovered: () => clearRetry(),
      onToolCall: (name, args) => {
        clearRetry();
        endThinking();
        main.toolUses = (main.toolUses ?? 0) + 1;
        countTool(name);
        flushAll();
        if (full && !full.endsWith("\n\n")) full += "\n\n";
        setPhase(name === "agent" || name === "workflow" ? "subagents" : "tool", toolTitle(name, parseArgs(args), 60).replace(/\x1b\[[0-9;]*m/g, ""));
      },
      onToolResult: (name, ok, output, callId) => {
        const call = pendingCalls.get(callId);
        pendingCalls.delete(callId);
        push({ kind: "tool", name, args: call ?? "{}", ok, output, note: callNotes.get(callId), verbose: verboseRef.current });
        callNotes.delete(callId);
        // Finished subagent groups leave the live panel once reported.
        live.current.groups = live.current.groups.filter((g) => g.tasks.some((t) => t.status === "running" || t.status === "queued"));
        if (agentGroup.tasks.every((t) => t.status === "done" || t.status === "failed")) agentGroup.tasks = [];
        if (pendingCalls.size === 0) setPhase("waiting");
      },
    };
    /** The first sign of life after an outage ends the retry banner. */
    const clearRetry = () => {
      if (!retrying) return;
      retrying = false;
      live.current.activity.retry = undefined;
      success("Reconnected — continuing.");
      if (live.current.activity.phase === "retrying") setPhase("waiting");
    };
    const pendingCalls = new Map<string, string>();
    /** Per-call stats shown under subagent and workflow blocks. */
    const callNotes = new Map<string, string>();
    const taskNote = (t: Task) => [t.toolUses ? `${t.toolUses} tool use${t.toolUses === 1 ? "" : "s"}` : "", t.tokens ? `${formatTokens(t.tokens)} tokens` : "", formatElapsed((t.endedAt ?? Date.now()) - t.startedAt)].filter(Boolean).join(" · ");
    const wrappedToolCall = handlers.onToolCall!;
    handlers.onToolCall = (name, args, callId) => {
      pendingCalls.set(callId, args);
      wrappedToolCall(name, args, callId);
    };

    /** Run one tool on behalf of the main agent or a subagent. */
    const runTool = async (name: string, args: Record<string, unknown>, agentLabel?: string): Promise<{ ok: boolean; output: string }> => {
      // Current permissions, not the ones the turn started with: /tools off
      // blocks the next change at once; /auto stops the next prompt.
      const now = permissions.current;
      const result = await executeTool(name, args, process.cwd(), () => askApproval(name, args, agentLabel), {
        mode: now.toolsMode,
        autoApprove: now.toolsMode === "yolo" || now.autoMode === "auto" || alwaysAllow.current.has(name),
        signal: ctrl.signal,
      });
      return result;
    };

    /** Track a subagent in the activity panel and run it. */
    const startSubagent = async (task: Task, prompt: string, signal: AbortSignal): Promise<string> => {
      task.status = "running";
      task.startedAt = Date.now();
      try {
        const res = await runSubagent({
          baseUrl,
          key: auth.key!,
          model,
          systemPrompt: agentSystemPrompt(toolsMode === "off" ? "read" : toolsMode, autoMode, process.cwd()),
          prompt,
          tools: subagentTools(),
          effort: effort === "auto" ? undefined : effort,
          signal,
          execute: async (name, args) => {
            const r = await runTool(name, args, task.label);
            const event: ToolEvent = { id: randomUUID(), name, args, ok: r.ok, output: r.output, at: Date.now(), turn: messages.current.length };
            toolHistory.current.push(event);
            turnEvents.push(event);
            saveProgress(true);
            return r;
          },
          describeCall: (name, args) => toolTitle(name, parseArgs(args), 50).replace(/\x1b\[[0-9;]*m/g, ""),
          onTool: (name, args) => {
            countTool(name);
            if (verboseRef.current) push({ kind: "info", text: `↳ ${task.label}: ${toolTitle(name, parseArgs(args), Math.max(30, size.columns - task.label.length - 10))}` });
          },
          onActivity: (a) => {
            task.state = a.state;
            // Verbose shows what a thinking subagent is thinking about.
            task.detail = a.state === "thinking" && verboseRef.current && a.thought ? `∴ ${a.thought.trim()}` : a.detail;
            task.tokensIn = a.tokensIn;
            task.tokens = a.tokens;
            task.reasoning = a.reasoning;
            task.toolUses = a.toolCalls;
            task.requests = a.requests;
            task.retries = a.retries;
            refreshTokens();
          },
        });
        task.status = "done";
        return res.text;
      } catch (err) {
        task.status = "failed";
        task.detail = err instanceof AbortedError ? "stopped" : friendly(err);
        throw err;
      } finally {
        task.endedAt = Date.now();
        finishedAgentTokens += task.tokens ?? 0;
        refreshTokens();
      }
    };

    // Subagents started by plain `agent` calls share one group per turn.
    const agentGroup: TaskGroup = { title: "", tasks: [] };

    const execute = async (name: string, args: Record<string, unknown>, callId: string): Promise<{ ok: boolean; output: string; historyEntry?: string }> => {
      let result: { ok: boolean; output: string };
      if (name === "search_history") result = searchHistory(messages.current, toolHistory.current, args);
      else if (name === "schedule_next") {
        const stop = args.stop === true;
        const delay = clampDynamicDelay(args.delay_seconds);
        scheduleDecision = { delay, reason: typeof args.reason === "string" ? args.reason.slice(0, 200) : "", stop };
        result = { ok: true, output: stop ? "The loop will end after this run." : `Next run scheduled in ${formatDuration(delay * 1000)}.` };
      } else if (name === "agent") {
        const prompt = typeof args.prompt === "string" ? args.prompt : "";
        if (!prompt.trim()) result = { ok: false, output: "agent needs a prompt." };
        else {
          if (!live.current.groups.includes(agentGroup)) live.current.groups.push(agentGroup);
          const task: Task = { id: randomUUID(), label: typeof args.description === "string" && args.description ? args.description : clip(prompt, 40), status: "queued", startedAt: Date.now() };
          turnAgents.push(task);
          agentGroup.tasks.push(task);
          try {
            const text = await startSubagent(task, prompt, ctrl.signal);
            result = { ok: true, output: text };
          } catch (err) {
            if (err instanceof AbortedError) throw err;
            result = { ok: false, output: `Subagent failed: ${friendly(err)}` };
          }
          callNotes.set(callId, taskNote(task));
        }
      } else if (name === "workflow") {
        const t0 = Date.now();
        result = await runWorkflowTool(args);
        const agents = /with (\d+) agent/.exec(result.output)?.[1];
        if (agents) callNotes.set(callId, `${agents} agent${agents === "1" ? "" : "s"} · ${formatElapsed(Date.now() - t0)}`);
      } else result = await runTool(name, args);
      const event: ToolEvent = { id: randomUUID(), name, args, ok: result.ok, output: result.output, at: Date.now(), turn: messages.current.length };
      if (name !== "search_history" && name !== "schedule_next") {
        toolHistory.current.push(event);
        turnEvents.push(event);
        saveProgress(true);
      }
      return { ...result, historyEntry: `tool:${event.id}` };
    };

    /** The workflow tool: approve (unless auto), then orchestrate subagents. */
    const runWorkflowTool = async (args: Record<string, unknown>): Promise<{ ok: boolean; output: string }> => {
      if (toolsMode !== "cmds" && toolsMode !== "yolo") return { ok: false, output: "Workflows need /tools cmds or /tools yolo." };
      let script = typeof args.script === "string" ? args.script : "";
      if (!script && typeof args.name === "string") {
        const saved = loadWorkflow(args.name);
        if (!saved) return { ok: false, output: `No saved workflow named "${args.name}". Saved: ${listWorkflows().map((w) => w.name).join(", ") || "(none)"}` };
        script = saved.script;
      }
      if (!script.trim()) return { ok: false, output: "Pass a workflow `script` or a saved workflow `name`." };
      const auto = permissions.current.toolsMode === "yolo" || permissions.current.autoMode === "auto";
      if (!auto && !alwaysAllow.current.has("workflow") && !(await askApproval("workflow", { ...args, script }))) {
        return { ok: false, output: "The user declined the workflow. Nothing ran." };
      }
      return orchestrate(script, args.args, ctrl.signal);
    };

    const orchestrate = async (script: string, wfArgs: unknown, signal: AbortSignal): Promise<{ ok: boolean; output: string }> => {
      const meta = readMeta(script);
      const group: TaskGroup = { title: `Workflow ${meta?.name ?? ""}`.trim(), tasks: [] };
      live.current.groups.push(group);
      setPhase("subagents", group.title);
      const tasks = new Map<number, Task>();
      try {
        const res = await runWorkflow({
          script,
          args: wfArgs,
          signal,
          events: {
            onPhase: (title) => { group.phase = title; },
            onAgentStart: (agentId, req) => {
              const task: Task = { id: String(agentId), label: req.label, status: "queued", startedAt: Date.now(), phase: req.phase };
              turnAgents.push(task);
              tasks.set(agentId, task);
              group.tasks.push(task);
              if (req.phase) group.phase = req.phase;
            },
            onLog: (m) => info(`${meta?.name ?? "workflow"}: ${clip(m, 200)}`),
          },
          runAgent: (agentId, req, sig) => startSubagent(tasks.get(agentId)!, req.prompt, sig),
        });
        const failedNote = res.failed ? ` (${res.failed} agent${res.failed === 1 ? "" : "s"} failed)` : "";
        const body = typeof res.result === "string" ? res.result : JSON.stringify(res.result ?? null, null, 2);
        return {
          ok: true,
          output: clip(`Workflow "${res.meta.name}" finished in ${formatElapsed(res.durationMs)} with ${res.agents} agent${res.agents === 1 ? "" : "s"}${failedNote}.`, 300) + `\n\nResult:\n${body.slice(0, 24_000)}${res.logs.length ? `\n\nLog:\n${res.logs.slice(-20).join("\n")}` : ""}`,
        };
      } catch (err) {
        if (signal.aborted) throw new AbortedError();
        return { ok: false, output: friendly(err) };
      } finally {
        setPhase("waiting");
      }
    };
    try {
      if (direct) {
        // /workflow <name>: typing the command is the approval for the script
        // itself; its agents still ask before each change in cmds mode.
        setPhase("subagents", `Workflow ${direct.name}`);
        const r = await orchestrate(direct.script, direct.args, ctrl.signal);
        const event: ToolEvent = { id: randomUUID(), name: "workflow", args: { name: direct.name, args: direct.args }, ok: r.ok, output: r.output, at: Date.now(), turn: messages.current.length };
        toolHistory.current.push(event);
        turnEvents.push(event);
        saveProgress(true);
        const agents = /with (\d+) agent/.exec(r.output)?.[1];
        // The result itself follows as the reply, so the block only carries the stats.
        push({ kind: "tool", name: "workflow", args: JSON.stringify({ name: direct.name }), ok: r.ok, output: r.ok ? r.output.split("\n")[0]! : r.output, note: agents ? `${agents} agent${agents === "1" ? "" : "s"} · ${formatElapsed(Date.now() - started)}` : undefined });
        const resultText = r.output.split("\n\nResult:\n")[1]?.split("\n\nLog:\n")[0] ?? r.output;
        if (r.ok) {
          full = resultText;
          push({ kind: "assistant", text: resultText, first: true });
        } else {
          outcome = "error";
          errMsg = r.output;
        }
        throw DONE;
      }

      const extra = loopRun ? loopSystemNote(loopRun) : undefined;
      const baseMessages = withSystem(messages.current, useTools, extra);
      const agentHistory: AgentMessage[] = [...baseMessages];

      // ── plan mode: mutating jobs get a numbered plan + explicit approval first ──
      if (useTools && planMode === "on" && (toolsMode === "cmds" || toolsMode === "yolo") && source === "user") {
        const approved = await planFirst(agentHistory, ctrl);
        if (!approved) {
          setStream(null);
          abortRef.current = null;
          await persist();
          return;
        }
      }

      const defs: ToolDef[] = useTools
        ? [
            ...toolDefinitions(toolsMode),
            HISTORY_TOOL,
            AGENT_TOOL,
            ...(toolsMode === "cmds" || toolsMode === "yolo" ? [WORKFLOW_TOOL] : []),
            ...(loopRun && loopRun.intervalMs === null ? [SCHEDULE_TOOL] : []),
          ]
        : loopRun && loopRun.intervalMs === null
          ? [SCHEDULE_TOOL]
          : [];

      const result = await agentTurn(baseUrl, auth.key, model, agentHistory, handlers, ctrl.signal, {
        effort: autoEffortFor(text),
        tools: defs,
        execute: defs.length ? execute : undefined,
        parallelSafe: (name) => name === "agent",
        interject: () => {
          const now = queueRef.current.filter((q) => q.source === "user" && !q.text.startsWith("/"));
          if (!now.length) return [];
          queueRef.current = queueRef.current.filter((q) => !now.includes(q));
          syncQueueLen();
          flushAll();
          if (full.trim()) messages.current.push({ role: "assistant", content: full.trim() });
          full = "";
          for (const q of now) {
            push({ kind: "user", text: q.text });
            messages.current.push({ role: "user", content: q.text });
          }
          delivered = true;
          info(`Delivered to the agent mid-turn.`);
          return now.map((q) => q.text);
        },
      });
      if (result.end === "max-rounds") endNote = `Stopped after ${result.rounds} steps (the per-turn limit). Send "continue" to keep going.`;
      else if (result.end === "gave-up") endNote = /no success is implied/.test(result.text)
        ? "The model stopped without doing what it announced. Send \"continue\" or try another /model."
        : "The model kept hitting its output limit without finishing. Try /effort low or ask for smaller steps.";
    } catch (err) {
      if (err === DONE) { /* direct workflow finished */ }
      else if (err instanceof AbortedError) outcome = "stopped";
      else if (err instanceof ApiError && err.status === 401) {
        const healed = await recoverAuth(auth.source === "env" ? "env" : "config");
        if (healed) {
          setAuth({ key: healed.key, source: healed.source });
          success(healed.message + " Send your message again.");
          if (healed.action === "switched-saved") tryClearEnvKeyWindows();
          outcome = "stopped"; // swallow; user resends
        } else {
          outcome = "error";
          errMsg = "Your API key was rejected. Type /login to enter a new one.";
        }
      } else {
        outcome = "error";
        errMsg = friendly(err);
      }
    } finally {
      clearTimeout(timer);
      abortRef.current = null;
      endThinking();
    }

    flushAll();
    live.current.activity.retry = undefined;

    // The prompt stays in the history even when no reply arrived: it was
    // saved when the turn started, and the next turn needs it as context.
    if (full.trim()) messages.current.push({ role: "assistant", content: full.trim() });
    pendingRef.current = null;
    // A tool may have changed a file before the model disconnected. Retain
    // that task and its evidence even when no assistant prose arrived.
    await persist();

    // Server didn't report usage — show a rough estimate (chars/4), clearly marked.
    if (!gotUsage) {
      const est = Math.round(requestContextChars / 4);
      setUsage({ ctx: est, prompt: est, completion: Math.round(full.length / 4), approx: true });
    }

    // Every turn ends with a visible line saying what happened — never silently.
    const elapsed = formatElapsed(Date.now() - started);
    const tokens = live.current.activity.tokens;
    const tools = turnEvents.length;
    const summary = [elapsed, tools ? `${tools} tool call${tools === 1 ? "" : "s"}` : "", tokens ? `↓ ${formatTokens(tokens)} tokens` : ""].filter(Boolean).join(" · ");
    if (outcome === "stopped") push({ kind: "turn", tone: "warn", text: `Stopped by you after ${summary}` });
    else if (outcome === "error") push({ kind: "turn", tone: "error", text: `${errMsg}  (${summary})` });
    else if (endNote) push({ kind: "turn", tone: "warn", text: `${endNote}  (${summary})` });
    else if (!full.trim() && !tools) push({ kind: "turn", tone: "warn", text: `The model returned no text — it may have hit its output limit mid-reasoning. Try /effort low or another model.  (${summary})` });
    else push({ kind: "turn", tone: "info", text: `Worked for ${summary}` });
    setStream(null);
    main.status = outcome === "error" ? "failed" : "done";
    main.endedAt = Date.now();
    refreshTokens();
    lastAgents.current = turnAgents.map((t) => ({ ...t }));
    lastView.current = { ...live.current, all: lastAgents.current, stats: { ...stats, tools: { ...stats.tools } } };
    sessionStats.current = addTurnToSession(sessionStats.current, lastView.current, Date.now() - started);
    live.current.groups = [];

    await afterTurn(outcome, text, turnEvents, scheduleDecision, loopRun);
  };

  /** Goal checks and loop scheduling once a turn has finished. */
  const afterTurn = async (
    outcome: "done" | "stopped" | "error",
    prompt: string,
    events: ToolEvent[],
    decision: { delay: number; reason: string; stop: boolean } | null,
    loopRun: LoopState | null,
  ) => {
    // /loop: schedule the next run, whatever happened (a failed run must not end the loop).
    if (loopRun && loopRef.current?.id === loopRun.id) {
      const l = loopRef.current;
      if (decision?.stop) {
        success(`Loop finished after ${l.iteration} run${l.iteration === 1 ? "" : "s"}${decision.reason ? ` — ${decision.reason.replace(/[.\s]+$/, "")}` : ""}.`);
        setLoop(null);
      } else if (outcome === "stopped") {
        info("Loop paused — this run was stopped. /loop resume to continue it, /loop stop to end it.");
        setLoop({ ...l, nextAt: null, lastReason: "paused" });
      } else {
        const delay = l.intervalMs ?? (decision ? decision.delay * 1000 : DYNAMIC_DEFAULT_S * 1000);
        const why = (l.intervalMs === null ? (decision ? decision.reason : "no schedule_next call — using the default") : "").replace(/[.\s]+$/, "");
        setLoop({ ...l, nextAt: Date.now() + delay, lastReason: why });
        info(`↻ Next loop run in ${formatDuration(delay)}${why ? ` — ${why}` : ""}.`);
      }
    }

    const g = goalRef.current;
    if (!g) return;
    const pause = (note: string, tone: "info" | "warn" = "info") => {
      pausedGoal.current = { ...g };
      setGoal(null);
      queueRef.current = queueRef.current.filter((q) => q.source !== "goal");
      syncQueueLen();
      push({ kind: tone, text: note });
    };
    if (outcome === "stopped") return pause("◎ Goal paused because you stopped the turn. /goal resume continues it, /goal clear removes it.");
    if (outcome === "error") return pause("◎ Goal paused: the turn ended with an error. /goal resume continues when you're ready.", "warn");
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    live.current = freshLive("evaluating");
    live.current.activity.detail = live.current.main.detail = clip(g.condition, 60);
    live.current.main.label = "goal check";
    setWorking(true);
    runningTurn.current = true;
    try {
      const reply = [...messages.current].reverse().find((m) => m.role === "assistant")?.content ?? "";
      const verdict = await evaluateGoal({ baseUrl, key: auth.key!, model }, g, goalEvidence(prompt, events, reply), ctrl.signal);
      const turns = g.turns + 1;
      if (verdict.met) {
        success(`◎ Goal met after ${turns} turn${turns === 1 ? "" : "s"} (${formatElapsed(Date.now() - g.startedAt)}): ${verdict.reason}.`);
        setGoal(null);
      } else if (turns >= g.maxTurns) {
        warn(`◎ Goal not met after ${turns} turns — stopping here. Last check: ${verdict.reason}. /goal resume keeps going.`);
        pausedGoal.current = { ...g, turns, lastReason: verdict.reason };
        setGoal(null);
      } else {
        const next = { ...g, turns, lastReason: verdict.reason };
        setGoal(next);
        push({ kind: "info", text: `◎ Goal not met yet (turn ${turns}/${g.maxTurns}): ${verdict.reason} — continuing.` });
        // Behind anything the user queued meanwhile (a /goal clear must win).
        queueRef.current.push({ text: continuationPrompt(next, verdict), source: "goal" });
        syncQueueLen();
      }
    } catch (err) {
      if (err instanceof AbortedError) pause("◎ Goal check stopped — goal paused. /goal resume continues it.");
      else pause(`◎ Goal check failed: ${friendly(err)} — goal paused. /goal resume to try again.`, "warn");
    } finally {
      abortRef.current = null;
      runningTurn.current = false;
      setWorking(false);
      setQueueTick((n) => n + 1);
    }
  };
  const pausedGoal = useRef<Goal | null>(null);

  // ---------- sessions ----------

  /** Save the conversation so /resume can pick it up later. Never throws.
   *  Called at the start of a turn, after every tool, while a reply streams
   *  and at the end, so closing the CLI mid-run loses at most a few seconds.
   *  `pending` is the turn in progress (null when it has finished). */
  const persist = async (pending: PendingTurn | null = null) => {
    // Read state through a ref: the autosave timer holds an old copy of this function.
    const { model, activeSkills } = latestState.current;
    if (!sessionsEnabled() || (!messages.current.length && !toolHistory.current.length && !notes.current.length)) return;
    try {
      const first = !session.current;
      if (!session.current) session.current = newSession(process.cwd(), model);
      const g = goalRef.current ?? pausedGoal.current;
      const l = loopRef.current;
      // Update the live object in place: the save queue reads its revision
      // when each write runs, so back-to-back saves never conflict.
      Object.assign(session.current, {
        model,
        skills: activeSkills,
        // Name the chat after its first prompt, even if a /remember saved it earlier.
        title: session.current.title && session.current.title !== "(untitled)" ? session.current.title : titleFrom(messages.current),
        updated: Date.now(),
        messages: [...messages.current],
        toolHistory: [...toolHistory.current],
        notes: [...notes.current],
        pending: pending ? { startedAt: pending.startedAt, partial: pending.partial.slice(-MAX_PENDING_CHARS) } : undefined,
        goal: g ? { condition: g.condition, turns: g.turns, maxTurns: g.maxTurns, startedAt: g.startedAt, lastReason: g.lastReason } : undefined,
        loop: l ? { prompt: l.prompt, intervalMs: l.intervalMs, iteration: l.iteration } : undefined,
        inputs: historyRef.current.slice(-MAX_SAVED_INPUTS),
        stats: { ...sessionStats.current },
      });
      await appendSession(session.current);
      if (first) pruneSessions();
    } catch (err) {
      if (!persistWarned.current) error(`Couldn't save this chat to ${sessionsDir()}. ${err instanceof Error ? err.message : "/resume may not contain the latest turn."}`);
      persistWarned.current = true;
    }
  };
  const persistWarned = useRef(false);
  const latestState = useRef({ model, activeSkills });
  latestState.current = { model, activeSkills };

  /** The turn in progress, for the autosave timer (null between turns). */
  const pendingRef = useRef<(() => PendingTurn) | null>(null);
  const lastSaved = useRef("");
  // Autosave every AUTOSAVE_MS, idle or mid-run, whenever anything changed:
  // a killed or closed CLI loses at most that much of a streaming reply.
  useEffect(() => {
    const t = setInterval(() => {
      const pending = pendingRef.current?.() ?? null;
      const g = goalRef.current ?? pausedGoal.current;
      const signature = [messages.current.length, toolHistory.current.length, notes.current.length, pending ? pending.partial.length : -1, g ? `${g.condition.length}:${g.turns}` : "", loopRef.current?.iteration ?? "", historyRef.current.length, latestState.current.model, latestState.current.activeSkills.join(",")].join("|");
      if (signature === lastSaved.current) return;
      lastSaved.current = signature;
      void persist(pending);
    }, AUTOSAVE_MS);
    return () => clearInterval(t);
    // persist reads refs, so the interval never needs to restart
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** The transcript of a saved chat: messages, with each tool block placed
   *  after the message it followed (older saves without positions list
   *  their messages only). */
  const replayItems = (msgs: ChatMessage[], events: ToolEvent[]): NewItem[] => {
    const byTurn = new Map<number, ToolEvent[]>();
    for (const e of events) if (typeof e.turn === "number") byTurn.set(e.turn, [...(byTurn.get(e.turn) ?? []), e]);
    const tool = (e: ToolEvent): NewItem => ({ kind: "tool", name: e.name, args: JSON.stringify(e.args), ok: e.ok, output: e.output });
    const out: NewItem[] = [...(byTurn.get(0) ?? []).map(tool)];
    msgs.forEach((m, i) => {
      if (m.role === "user") out.push({ kind: "user", text: m.content });
      else if (m.role === "assistant") out.push({ kind: "assistant", text: m.content, first: true });
      out.push(...(byTurn.get(i + 1) ?? []).map(tool));
    });
    return out;
  };

  const resumeSession = (meta: SessionMeta) => {
    const s = loadSession(meta.id);
    if (!s || (!s.messages.length && !s.notes?.length && !s.toolHistory?.length)) {
      error("That session couldn't be read. It may have been deleted.");
      return;
    }
    session.current = s;
    setUsage(null); // new context; counts start fresh on the next message
    const available = new Set(loadSkills().map((k) => k.name));
    setActiveSkills((s.skills ?? []).filter((n) => available.has(n)));
    messages.current = [...s.messages];
    toolHistory.current = [...(s.toolHistory ?? [])];
    notes.current = [...(s.notes ?? [])];
    if (s.inputs?.length) setHistory(() => s.inputs!);
    sessionStats.current = s.stats ? { ...emptySessionStats(), ...s.stats } : emptySessionStats();
    lastView.current = null;
    const nextModel = s.model || model;
    if (s.model) setModel(s.model);
    setMode({ type: "chat" });
    alwaysAllow.current.clear();
    // A goal or loop that was active comes back paused: nothing runs on its own after a restart.
    setGoal(null);
    pausedGoal.current = s.goal ? { ...s.goal } : null;
    setLoop(s.loop ? { ...s.loop, id: ++loopSeq.current, startedAt: Date.now(), nextAt: null, lastReason: "paused" } : null);

    const notesAfter: Item[] = [];
    const note = (text: string, kind: "info" | "warn" = "info") => notesAfter.push({ id: id(), kind, text });
    // A turn cut short by closing or killing the CLI: keep what it had written.
    let interrupted = false;
    if (s.pending) {
      interrupted = true;
      const partial = s.pending.partial.trim();
      if (partial) messages.current.push({ role: "assistant", content: `${partial}\n\n[This reply was interrupted when the CLI closed.]` });
    } else if (messages.current.at(-1)?.role === "user") {
      interrupted = true; // closed before any reply was saved
    }
    stdout.write("\x1b[2J\x1b[3J\x1b[H");
    const header: Item = { id: id(), kind: "header", model: nextModel, loggedIn: !!auth.key, keySource: auth.source };
    note(`Resumed "${s.title}" · ${s.messages.filter((m) => m.role === "user").length} messages · ${s.toolHistory?.length ?? 0} tool results · ${prettyPath(s.cwd)} · ${timeAgo(s.updated)}`);
    if (interrupted) note("The last turn was interrupted mid-run. Its messages, tool results and partial reply are restored. Press Enter to continue where it left off.", "warn");
    if (s.goal) note(`◎ Goal restored (paused): ${clip(s.goal.condition, 120)} — /goal resume to continue it.`);
    if (s.loop) note(`↻ Loop restored (paused): ${clip(s.loop.prompt, 80)} — /loop resume to restart it, /loop stop to drop it.`);
    if (notes.current.length) note(`${notes.current.length} pinned note${notes.current.length === 1 ? "" : "s"} restored.`);
    setItems(retainDisplayWindow([header, ...replayItems(messages.current, toolHistory.current).map((it) => ({ ...it, id: id() }) as Item), ...notesAfter]));
    setStaticKey((k) => k + 1);
    if (interrupted) {
      const prompt = "Continue where you left off.";
      setEditor({ value: prompt, cursor: prompt.length });
      void persist(); // the restored partial is now part of the history
    }
  };

  const sessionLists = () => {
    const all = listSessions();
    const cwd = process.cwd();
    return { all, here: all.filter((s) => s.cwd === cwd) };
  };

  const openSessions = (scope: "folder" | "all", arg = "") => {
    if (!sessionsEnabled()) {
      info("Saving chats is turned off (UNJAILED_NO_HISTORY or \"saveSessions\": false), so there's nothing to resume.");
      return;
    }
    const { all, here } = sessionLists();
    let list = scope === "folder" ? here : all;
    if (scope === "folder" && list.length === 0 && all.length > 0) {
      info("No saved chats from this folder. Showing chats from every folder.");
      scope = "all";
      list = all;
    }
    if (list.length === 0) {
      info("No saved chats yet. Chats are saved automatically as you go, and every 10 seconds while the agent works.");
      return;
    }
    if (arg) {
      const match = findSession(arg, list);
      if (match) resumeSession(match);
      else error(`No saved chat matches "${arg}". Type /${scope === "folder" ? "resume" : "sessions"} to pick from the list.`);
      return;
    }
    setMode({ type: "sessions", list, selected: 0, scope, confirmDelete: false });
  };

  // unjailed --continue / --resume
  useEffect(() => {
    if (startup === "resume") openSessions("folder");
    if (startup === "continue") {
      const latest = sessionLists().here[0];
      if (latest) resumeSession(latest);
      else info("No previous chat in this folder. Starting a new one.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- tools, skills & effort ----------

  const toolsCommand = (arg: string) => {
    const next = arg.toLowerCase();
    // Tool access is always an explicit choice: no argument opens the picker.
    if (next === "" || next === "on") {
      approvalArmedAt.current = Date.now();
      setMode({ type: "tool-permissions", selected: Math.max(0, TOOL_CHOICES.findIndex((choice) => choice.key === toolsMode)) });
      return;
    }
    // Choosing a mode also resets auto approval, so access never widens silently.
    if (next === "read") {
      setToolsMode("read");
      setAutoMode("ask");
      writeConfig({ tools: "read", autoMode: "ask" });
      success("Agent tools on — read files and clipboard, search, fetch pages, and start read-only subagents.");
      info("Use /tools to choose file changes and commands, or /tools cmds to enable them with confirmations.");
      return;
    }
    if (next === "cmds" || next === "commands") {
      setToolsMode("cmds");
      setAutoMode("ask");
      writeConfig({ tools: "cmds", autoMode: "ask" });
      success("Agent tools on — full toolkit: read/write/edit, search, commands, subagents and workflows (you confirm each change).");
      return;
    }
    if (next === "yolo") {
      setToolsMode("yolo");
      setAutoMode("auto");
      writeConfig({ tools: "yolo", autoMode: "auto" });
      success("Agent tools on — full toolkit, changes and commands run WITHOUT confirmation.");
      return;
    }
    if (next === "off") {
      setToolsMode("off");
      setAutoMode("ask");
      writeConfig({ tools: "off", autoMode: "ask" });
      success("Agent tools off — plain chat.");
      return;
    }
    error("Usage: /tools [read|cmds|yolo|off] — no argument opens the permission picker.");
  };

  const toggleSkill = (name: string) => {
    const on = activeSkills.includes(name);
    setActiveSkills((list) => (on ? list.filter((n) => n !== name) : [...list, name]));
    if (on) info(`Skill ${name} off.`);
    else success(`Skill ${name} on — it applies to your next message.`);
  };

  const skillsCommand = (arg: string) => {
    const newMatch = arg.match(/^new\s+(\S+)(?:\s+(--project|-p))?$/i);
    if (newMatch) {
      try {
        const file = createSkill(newMatch[1]!, newMatch[2] ? "project" : "user");
        success(`Created ${file}`);
        info("Edit it in any text editor, then switch it on with /skills.");
      } catch (err) {
        error(err instanceof Error ? err.message : "Couldn't create the skill.");
      }
      return;
    }
    const list = loadSkills();
    if (arg) {
      const skill = list.find((k) => k.name === arg.toLowerCase());
      if (skill) toggleSkill(skill.name);
      else error(`No skill named "${arg}". Type /skills to see them, or /skills new ${arg} to make it.`);
      return;
    }
    if (list.length === 0) {
      push({
        kind: "plain",
        text: [
          "No skills yet. A skill is a markdown file of instructions the model follows while it's on.",
          "",
          `${theme.brand("/skills new <name>")}            create one in ${userSkillsDir()}`,
          `${theme.brand("/skills new <name> --project")}  create one in ${projectSkillsDir()}`,
        ].join("\n"),
      });
      return;
    }
    setMode({ type: "skills", list, selected: 0 });
  };

  const setAndSaveEffort = (next: Effort) => {
    setEffort(next);
    writeConfig({ effort: next });
    success((next === "auto" ? "Effort set to auto — the model decides how long to think." : `Effort set to ${next}.`) + (runningTurn.current ? " Applies from the next turn." : ""));
  };

  const effortCommand = (arg: string) => {
    if (!arg) {
      setMode({ type: "effort", selected: Math.max(0, EFFORTS.indexOf(effort)) });
      return;
    }
    const level = arg.toLowerCase() as Effort;
    if ((EFFORTS as readonly string[]).includes(level)) setAndSaveEffort(level);
    else error(`Effort can be ${EFFORTS.join(", ")}.`);
  };

  // ---------- /goal ----------

  const goalCommand = (arg: string) => {
    const a = arg.trim();
    const lower = a.toLowerCase();
    const current = goalRef.current;
    if (!a) {
      if (!current) {
        info(pausedGoal.current ? `No active goal. Paused: "${pausedGoal.current.condition}" — /goal resume to continue it.` : "No goal set. /goal <condition> keeps the agent working until the condition is met, e.g. /goal npm test passes with no failures");
        return;
      }
      push({ kind: "plain", text: [
        `${theme.bold("◎ Goal")}  ${current.condition}`,
        `${theme.dim("turns   ")} ${current.turns}/${current.maxTurns}`,
        `${theme.dim("running ")} ${formatElapsed(Date.now() - current.startedAt)}`,
        ...(current.lastReason ? [`${theme.dim("last    ")} ${current.lastReason}`] : []),
        theme.dim("/goal clear to stop · checked after every turn"),
      ].join("\n") });
      return;
    }
    if (lower === "clear" || lower === "off" || lower === "stop" || lower === "cancel") {
      if (!current && !pausedGoal.current) { info("No goal to clear."); return; }
      setGoal(null);
      pausedGoal.current = null;
      queueRef.current = queueRef.current.filter((q) => q.source !== "goal");
      syncQueueLen();
      success("Goal cleared.");
      return;
    }
    if (lower === "resume") {
      const g = current ?? pausedGoal.current;
      if (!g) { info("No goal to resume. Set one with /goal <condition>."); return; }
      pausedGoal.current = null;
      const resumed = { ...g, maxTurns: g.turns >= g.maxTurns ? g.turns + Math.min(10, g.maxTurns) : g.maxTurns };
      setGoal(resumed);
      success(`Goal resumed (turn ${resumed.turns}/${resumed.maxTurns}).`);
      queueRef.current.unshift({ text: resumed.lastReason ? continuationPrompt(resumed, { met: false, reason: resumed.lastReason }) : kickoffPrompt(resumed), source: "goal" });
      syncQueueLen();
      setQueueTick((n) => n + 1);
      return;
    }
    if (toolsMode === "off") warn("Tools are off, so the agent can only answer in text. /tools cmds lets it change files and run checks.");
    const parsed = parseGoalArgs(a);
    if ("error" in parsed) { error(parsed.error); return; }
    const g: Goal = { condition: parsed.condition, maxTurns: parsed.maxTurns, turns: 0, startedAt: Date.now() };
    pausedGoal.current = null;
    setGoal(g);
    success(`◎ Goal set — the agent keeps working until: ${g.condition}`);
    info(`Checked after every turn by an independent evaluator · up to ${g.maxTurns} turns · /goal clear to stop.`);
    queueRef.current.unshift({ text: kickoffPrompt(g), source: "goal" });
    syncQueueLen();
    setQueueTick((n) => n + 1);
  };

  // ---------- /loop ----------

  const loopCommand = (arg: string) => {
    const a = arg.trim();
    const lower = a.toLowerCase();
    const l = loopRef.current;
    if (!a) {
      if (!l) { info("No loop running. /loop 5m <prompt> repeats every 5 minutes; /loop <prompt> lets the agent pace itself."); return; }
      push({ kind: "plain", text: [
        `${theme.bold("↻ Loop")}  ${l.prompt}`,
        `${theme.dim("pace    ")} ${l.intervalMs === null ? "self-paced (agent chooses each delay)" : `every ${formatDuration(l.intervalMs)}`}`,
        `${theme.dim("runs    ")} ${l.iteration}`,
        `${theme.dim("next    ")} ${l.nextAt ? `in ${formatDuration(l.nextAt - Date.now())}` : l.lastReason === "paused" ? "paused" : "running now"}`,
        theme.dim("/loop stop to end it"),
      ].join("\n") });
      return;
    }
    if (lower === "stop" || lower === "off" || lower === "cancel" || lower === "clear") {
      if (!l) { info("No loop running."); return; }
      setLoop(null);
      queueRef.current = queueRef.current.filter((q) => q.source !== "loop");
      syncQueueLen();
      success(`Loop stopped after ${l.iteration} run${l.iteration === 1 ? "" : "s"}.`);
      return;
    }
    if (lower === "resume") {
      if (!l) { info("No loop to resume."); return; }
      setLoop({ ...l, nextAt: Date.now(), lastReason: undefined });
      success("Loop resumed.");
      return;
    }
    const parsed = parseLoopArgs(a);
    if ("error" in parsed) { error(parsed.error); return; }
    if (l) info(`Replacing the previous loop (${l.iteration} run${l.iteration === 1 ? "" : "s"}).`);
    queueRef.current = queueRef.current.filter((q) => q.source !== "loop");
    const next: LoopState = { ...parsed, id: ++loopSeq.current, iteration: 0, startedAt: Date.now(), nextAt: Date.now() };
    setLoop(next);
    success(`↻ Loop started — ${parsed.intervalMs === null ? "self-paced: the agent picks when to run again" : `every ${formatDuration(parsed.intervalMs)}`}. /loop stop to end it.`);
  };

  // Fire a due loop run: queue it, and let the drain effect start it when idle.
  useEffect(() => {
    if (!loop || loop.nextAt === null) return;
    const fire = () => {
      const l = loopRef.current;
      if (!l || l.id !== loop.id || l.nextAt === null) return;
      if (queueRef.current.some((q) => q.source === "loop")) return;
      const run = { ...l, iteration: l.iteration + 1, nextAt: null };
      setLoop(run);
      queueRef.current.push({ text: run.prompt, source: "loop" });
      syncQueueLen();
      setQueueTick((n) => n + 1);
    };
    const wait = Math.max(0, loop.nextAt - Date.now());
    const t = setTimeout(fire, wait);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loop?.id, loop?.nextAt]);

  // ---------- /workflow ----------

  const workflowCommand = async (arg: string) => {
    const a = arg.trim();
    const newMatch = a.match(/^new\s+(\S+)(?:\s+(--user|-u))?$/i);
    if (newMatch) {
      try {
        const file = saveWorkflow(newMatch[1]!, WORKFLOW_TEMPLATE(newMatch[1]!), newMatch[2] ? "user" : "project");
        success(`Created ${file}`);
        info("Edit it, then run it with /workflow " + newMatch[1] + " — or ask the agent to run it.");
      } catch (err) {
        error(err instanceof Error ? err.message : "Couldn't create the workflow.");
      }
      return;
    }
    if (!a) return workflowsCommand();
    const [name, ...rest] = a.split(/\s+/);
    const saved = loadWorkflow(name!);
    if (!saved) { error(`No saved workflow named "${name}". /workflows lists them; /workflow new ${name} creates one.`); return; }
    if (toolsMode === "off") { error("Workflows run subagents with tools — turn them on with /tools (read-only) or /tools cmds."); return; }
    if (!auth.key) { error(NOT_LOGGED_IN); return; }
    const raw = rest.join(" ");
    let wfArgs: unknown = raw || null;
    if (raw) { try { wfArgs = JSON.parse(raw); } catch { /* plain string */ } }
    // Typing the command is the approval; the workflow's agents still ask per action in cmds mode.
    push({ kind: "user", text: `/workflow ${a}` });
    await runDirectWorkflow(saved.name, saved.script, wfArgs);
  };

  /** Run a saved workflow from the command line as its own turn. */
  const runDirectWorkflow = (name: string, script: string, wfArgs: unknown) =>
    sendChat(`[workflow] Ran the saved workflow "${name}"${wfArgs ? ` with args ${JSON.stringify(wfArgs)}` : ""}.`, "command", { name, script, args: wfArgs });

  const workflowsCommand = () => {
    const list = listWorkflows();
    if (!list.length) {
      push({ kind: "plain", text: [
        "No saved workflows yet. A workflow is a JavaScript file that orchestrates subagents.",
        "",
        `${theme.brand("/workflow new <name>")}          create one in ${projectWorkflowsDir()}`,
        `${theme.brand("/workflow new <name> --user")}   create one in ${userWorkflowsDir()}`,
        "",
        theme.dim("The agent can also write and run workflows on its own when /tools cmds is on."),
      ].join("\n") });
      return;
    }
    const w = Math.max(...list.map((x) => x.name.length)) + 3;
    push({ kind: "plain", text: [theme.bold("Workflows"), ...list.map((x) => `${theme.brand(x.name.padEnd(w))}${x.description || theme.dim("(no description)")}${x.scope === "project" ? theme.dim("  · this project") : ""}`), "", theme.dim("/workflow <name> [json args] runs one")].join("\n") });
  };

  // ---------- /verbose ----------

  const verboseCommand = (arg: string) => {
    const a = arg.toLowerCase();
    const next = a === "on" ? true : a === "off" ? false : !verboseRef.current;
    setVerbose(next);
    if (next) success("Verbose on — the model's thinking, each subagent step and full tool output appear in the transcript. Ctrl+O toggles.");
    else info("Verbose off — thinking is summarised as \"Thought for …\" and tool output is previewed.");
  };

  // ---------- /stats ----------

  const statsCommand = () => {
    const view = lastView.current;
    const w = Math.min(size.columns - 6, 120);
    const lines = view
      ? statsLines({ ...view, stats: { ...view.stats!, firstOutputAt: undefined } }, sessionStats.current, Date.now(), w, false)
      : statsLines(freshLive("waiting"), sessionStats.current, Date.now(), w, false).slice(-1);
    push({ kind: "plain", text: [theme.bold(view ? "Stats · last turn and session" : "Stats · session"), ...lines, theme.dim("Shown live during every turn while /verbose is on.")].join("\n") });
  };

  // ---------- /agents ----------

  const agentsCommand = () => {
    const rows = lastAgents.current;
    if (!rows.length) {
      info("No agent activity yet. While a turn runs, the panel under the status line shows every agent live; Ctrl+T expands it into a table.");
      return;
    }
    const w = Math.min(size.columns - 4, 120);
    push({ kind: "plain", text: [theme.bold("Agents · last turn"), ...agentsTable(rows, w, Date.now(), "·"), theme.dim("↑ input (prompt) tokens · ↓ output tokens · ∴ reasoning tokens · Ctrl+T shows this live")].join("\n") });
  };

  // ---------- commands ----------

  const funCommand = (arg: string) => {
    const a = arg.toLowerCase();
    const next = a === "off" ? false : a === "on" ? true : !fx;
    setFx(next);
    writeConfig({ fx: next });
    if (next) success("Fun effects on — startup wink, side snow and sparkles. /fun off to turn them off.");
    else info("Fun effects off.");
  };

  const runCommand = async (raw: string) => {
    const cmd = parseCommand(raw);
    if (!cmd) return;
    const known = COMMANDS.find((c) => c.name === cmd.name);
    if (!known) {
      error(`Unknown command /${cmd.name}. Type / to see commands.`);
      return;
    }
    switch (cmd.name) {
      case "exit":
        quit();
        return;
      case "help":
        push({ kind: "plain", text: helpText() });
        return;
      case "resume":
        return openSessions("folder", cmd.arg);
      case "sessions":
        return openSessions("all", cmd.arg);
      case "clear":
        messages.current = [];
        toolHistory.current = [];
        notes.current = [];
        alwaysAllow.current.clear();
        setUsage(null);
        session.current = null; // the old chat stays saved; this starts a new one
        stdout.write("\x1b[2J\x1b[3J\x1b[H");
        setItems([{ id: id(), kind: "header", model, loggedIn: !!auth.key, keySource: auth.source }]);
        setStaticKey((k) => k + 1);
        return;
      case "login":
        setMode({ type: "login" });
        setEditor(EMPTY);
        info("Paste your API key (Esc to cancel). Get one at unjailedai.com/dashboard.");
        return;
      case "logout":
        return logout();
      case "effort":
        return effortCommand(cmd.arg);
      case "skills":
        return skillsCommand(cmd.arg);
      case "tools":
        return toolsCommand(cmd.arg);
      case "auto":
      case "bypass":
        return autoCommand(cmd.name, cmd.arg);
      case "plan":
        return planCommand(cmd.arg);
      case "goal":
        return goalCommand(cmd.arg);
      case "loop":
        return loopCommand(cmd.arg);
      case "workflow":
        return workflowCommand(cmd.arg);
      case "workflows":
        return workflowsCommand();
      case "agents":
        return agentsCommand();
      case "verbose":
        return verboseCommand(cmd.arg);
      case "stats":
        return statsCommand();
      case "fun":
        return funCommand(cmd.arg);
      case "api":
        return apiInfo();
      case "remember": {
        if (!cmd.arg) { info(notes.current.length ? "Pinned session notes:\n" + notes.current.map((note, i) => `${i + 1}. ${note}`).join("\n") : "No pinned notes. /remember <text> keeps an important instruction in this session."); return; }
        if (cmd.arg.toLowerCase() === "clear") notes.current = [];
        else {
          if (notes.current.length >= 20 || notes.current.join("\n").length + cmd.arg.length > 8000) { error("Pinned notes limit reached (20 notes / 8,000 characters). /remember clear to reset them."); return; }
          notes.current.push(cmd.arg);
        }
        await persist();
        success(cmd.arg.toLowerCase() === "clear" ? "Pinned notes cleared." : "Note pinned for this session.");
        return;
      }
      case "context":
        return contextInfo();
      case "update":
        return updateCommand();
      case "model":
        return chooseModel(cmd.arg);
    }
  };

  const logout = () => {
    const hadSaved = !!readConfig().apiKey;
    if (hadSaved) deleteKey();
    if (process.env.UNJAILED_API_KEY?.trim()) {
      if (hadSaved) success("Saved key removed.");
      info("You're still logged in through the UNJAILED_API_KEY environment variable. Unset it to log out completely." +
        (process.platform === "win32"
          ? ' On Windows: [Environment]::SetEnvironmentVariable("UNJAILED_API_KEY", $null, "User") — then open a new terminal.'
          : " On macOS/Linux: remove it from your shell profile (~/.bashrc, ~/.zshrc)."));
      return;
    }
    setAuth({ key: null, source: null });
    if (hadSaved) success(`Logged out. Your key was removed from ${configPath()}.`);
    else info("You're not logged in.");
  };

  const apiLines = (key: string | null, source: KeySource, currentModel: string) =>
    [
      `${theme.dim("Base URL ")} ${baseUrl}${process.env.UNJAILED_BASE_URL ? theme.dim("  (UNJAILED_BASE_URL)") : ""}`,
      `${theme.dim("API key  ")} ${key ? maskKey(key) + theme.dim(source === "env" ? "  (UNJAILED_API_KEY)" : "  (saved)") : "none"}`,
      `${theme.dim("Model    ")} ${currentModel}`,
      `${theme.dim("Config   ")} ${configPath()}`,
    ].join("\n");

  const connectedLine = (ms: number, count: number) => `Connected · ${ms} ms · ${count} model${count === 1 ? "" : "s"} available`;

  const contextInfo = () => {
    const count = messages.current.length;
    if (!usage) {
      const chars = prepareRequestHistory(withSystem(messages.current, toolsMode !== "off")).messages.reduce((n, m) => n + m.content.length, 0);
      push({ kind: "plain", text: [
        `${theme.dim("Context  ")} ~${formatTokens(Math.round(chars / 4))} tokens ${theme.dim("(estimated — send a message to get real counts)")}`,
        `${theme.dim("Messages ")} ${count}`,
        `${theme.dim("Model    ")} ${model}`,
      ].join("\n") });
      return;
    }
    push({ kind: "plain", text: [
      `${theme.dim("Context  ")} ${usage.approx ? "~" : ""}${formatTokens(usage.ctx)} tokens${usage.approx ? theme.dim(" (estimated)") : ""}`,
      `${theme.dim("Last turn")} ${formatTokens(usage.prompt)} in · ${formatTokens(usage.completion)} out`,
      `${theme.dim("Messages ")} ${count}`,
      `${theme.dim("Model    ")} ${model}`,
    ].join("\n") });
  };

  // ---------- /auto (bypass) & /plan ----------

  /** Plan mode: before mutating work, get a numbered plan and explicit yes/no. */
  const planFirst = async (history: AgentMessage[], ctrl: AbortController): Promise<boolean> => {
    setPhase("thinking", "drafting a plan");
    let plan = "";
    try {
      await streamChatRetry(baseUrl, auth.key!, model, [
        ...history.filter((m) => m.role !== "tool"),
        { role: "user", content: "Before doing anything: reply with ONLY a short numbered plan (max 8 steps, one line each) for exactly this task. No prose before or after. You will not execute anything yet." },
      ] as ChatMessage[], {
        onToken: (t) => { plan += t; },
      }, ctrl.signal, { effort });
    } catch (err) {
      if (err instanceof AbortedError) throw err;
      info("Plan draft failed — no actions were taken. Retry or use /plan off.");
      return false;
    }
    const trimmed = plan.trim();
    if (!trimmed || !/^\s*1[.)]/m.test(trimmed)) { info("No valid plan received — no actions were taken. Retry or use /plan off."); return false; }
    const steps = trimmed.split("\n").map((l) => l.trim()).filter((l) => /^\d+[.)]/.test(l)).slice(0, 8);
    push({ kind: "plain", text: `${theme.bold("Draft plan")}\n${steps.map((s) => "  " + theme.brand(sanitizeForDisplay(s))).join("\n")}` });
    setPhase("approval", "plan");
    setMode({ type: "plan-approve", steps, selected: 0 });
    const approved = await askPlanApprove();
    setMode({ type: "chat" });
    setPhase("waiting");
    if (approved) success("Plan approved — executing.");
    else info("Plan rejected. Tell me what to change, or rephrase the task.");
    return approved;
  };

  const planAnswerRef = useRef<((yes: boolean) => void) | null>(null);
  const askPlanApprove = (): Promise<boolean> => {
    return new Promise((resolve) => {
      approvalArmedAt.current = Date.now();
      planAnswerRef.current = (yes) => {
        planAnswerRef.current = null;
        approvalArmedAt.current = 0;
        resolve(yes);
      };
    });
  };

  const autoCommand = (from: string, arg: string) => {
    const off = arg.toLowerCase() === "off";
    if (off) {
      setAutoMode("ask");
      if (toolsMode === "yolo") setToolsMode("cmds");
      writeConfig({ autoMode: "ask", ...(toolsMode === "yolo" ? { tools: "cmds" as const } : {}) });
      alwaysAllow.current.clear();
      success("Auto mode off — enabled changes and commands ask for permission again.");
      return;
    }
    if (toolsMode !== "cmds" && toolsMode !== "yolo") {
      info("Write and command tools are not enabled. Choose the access you want to allow.");
      toolsCommand("");
      return;
    }
    setAutoMode("auto");
    writeConfig({ autoMode: "auto" });
    const label = from === "bypass" ? "/bypass" : "/auto";
    success(`${label} on — the agent makes changes and runs commands without asking. /auto off to restore confirmations.`);
  };

  const planCommand = (arg: string) => {
    const off = arg.toLowerCase() === "off";
    if (off) {
      setPlanMode("off");
      writeConfig({ plan: false });
      success("Plan mode off — the agent acts directly.");
      return;
    }
    setPlanMode("on");
    writeConfig({ plan: true });
    success("Plan mode on — the agent drafts a numbered plan before making changes; you approve it.");
    info("Plan approval applies to every task while write/command tools are enabled. /tools read allows inspection without a plan.");
  };

  // ---------- /update ----------

  const updateCommand = async () => {
    const cur = currentVersion();
    setBusy("Checking npm for updates");
    const latest = await latestVersion();
    if (!latest) {
      setBusy(null);
      error("Couldn't reach npm. Check your connection and try again.");
      return;
    }
    if (cur === latest) {
      setBusy(null);
      success(`You're on the latest version (${cur}).`);
      return;
    }
    info(`Updating ${cur} → ${latest}…`);
    setBusy("Updating via npm");
    const ok = await runSelfUpdate((line) => {
      if (line.trim()) info(line.trim().slice(0, 120));
    });
    setBusy(null);
    if (ok) success(`Updated to ${latest}. Restart the CLI to run the new version.`);
    else error("The update didn't finish cleanly. Run: npm install -g unjailed@latest");
  };

  /** A short request of its own (/api, /model). During a turn it gets a
   *  separate handle, so it can't replace or clear the turn's stop. */
  const sideRequest = () => {
    const ctrl = new AbortController();
    const owns = !runningTurn.current;
    if (owns) abortRef.current = ctrl;
    return {
      ctrl,
      busy: (label: string | null) => { if (owns) setBusy(label); },
      done: () => { if (abortRef.current === ctrl) abortRef.current = null; if (owns) setBusy(null); },
    };
  };

  const apiInfo = async () => {
    push({ kind: "plain", text: apiLines(auth.key, auth.source, model) });
    if (!auth.key) {
      error(`Connection not checked. ${NOT_LOGGED_IN}`);
      return;
    }
    const side = sideRequest();
    const ctrl = side.ctrl;
    side.busy("Checking connection");
    const t0 = Date.now();
    try {
      const models = await listModels(baseUrl, auth.key, ctrl.signal);
      if (ctrl.signal.aborted) return;
      const ms = Date.now() - t0;
      const available = models.some((m) => m.id === model);
      success(connectedLine(ms, models.length));
      if (!available) error(`Current model "${model}" isn't in the list. Pick one with /model.`);
    } catch (err) {
      if (!ctrl.signal.aborted) error(`Connection failed: ${friendly(err)}`);
    } finally {
      side.done();
    }
  };

  const setAndSaveModel = (next: string) => {
    setModel(next);
    writeConfig({ model: next });
    success(`Model set to ${next}${messages.current.length ? " · conversation kept" : ""}${runningTurn.current ? " · applies from the next turn" : ""}`);
  };

  const chooseModel = async (arg: string) => {
    if (!auth.key) {
      error(NOT_LOGGED_IN);
      return;
    }
    if (!arg) setMode({ type: "picker", models: null, selected: 0 });
    const side = sideRequest();
    const ctrl = side.ctrl;
    if (arg) side.busy("Checking model");
    try {
      const ids = (await listModels(baseUrl, auth.key, ctrl.signal)).map((m) => m.id);
      if (ctrl.signal.aborted) return;
      if (ids.length === 0) {
        setMode({ type: "chat" });
        error("The API returned no models.");
        return;
      }
      if (arg) {
        const match = ids.find((m) => m === arg) ?? ids.find((m) => m.toLowerCase() === arg.toLowerCase());
        if (match) setAndSaveModel(match);
        else error(`No model named "${arg}". Type /model to pick from the list.`);
        return;
      }
      const cur = ids.indexOf(model);
      setMode({ type: "picker", models: ids, selected: cur >= 0 ? cur : 0 });
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setMode({ type: "chat" });
      error(`Couldn't load models: ${friendly(err)}`);
    } finally {
      side.done();
    }
  };

  const submitLogin = async (value: string) => {
    const key = value.trim();
    if (!key) {
      error("No key entered. Paste your API key, or press Esc to cancel.");
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy("Checking key");
    const t0 = Date.now();
    try {
      const models = await listModels(baseUrl, key, ctrl.signal);
      if (ctrl.signal.aborted) return;
      const ms = Date.now() - t0;
      writeConfig({ apiKey: key });
      setEditor(EMPTY);
      setMode({ type: "chat" });
      const envKey = process.env.UNJAILED_API_KEY?.trim();
      if (!envKey) setAuth({ key, source: "config" });
      success(`Logged in · key ${maskKey(key)} saved`);
      let active = model;
      if (models.length && !models.some((m) => m.id === model)) {
        active = models.find((m) => m.id === DEFAULT_MODEL)?.id ?? models[0]!.id;
        setModel(active);
        writeConfig({ model: active });
      }
      // Show the same summary as /api, using the check we just did.
      push({ kind: "plain", text: apiLines(envKey || key, envKey ? "env" : "config", active) });
      success(connectedLine(ms, models.length));
      if (envKey && envKey !== key) info("Note: UNJAILED_API_KEY is set in your environment and takes priority over the saved key.");
    } catch (err) {
      if (ctrl.signal.aborted) return;
      setEditor(EMPTY);
      const status = err instanceof ApiError ? err.status : undefined;
      if (status === 401) error("That key was rejected. Check it and paste again, or press Esc to cancel.");
      else error(`${friendly(err)} Paste the key to retry, or press Esc to cancel.`);
    } finally {
      abortRef.current = null;
      setBusy(null);
    }
  };

  // ---------- input ----------

  const turnActive = working || !!stream;
  const slashQuery = mode.type === "chat" && /^\/\S*$/.test(editor.value) ? editor.value.slice(1) : null;
  const slashMatches = slashQuery !== null ? filterCommands(slashQuery) : [];
  // The menu also works while the agent runs; see runsMidTurn for what runs at once.
  const menuOpen = slashQuery !== null && !busy;

  useEffect(() => setSlashSel(0), [slashQuery]);

  const submitChat = (value: string) => {
    const text = value.replace(/\s+$/, "");
    if (!text.trim()) return;
    setHistory((h) => (h[h.length - 1] === text ? h : [...h, text]));
    setHistIdx(null);
    setEditor(EMPTY);
    // Busy? Don't reject it. Plain messages reach a working agent at its next
    // step; commands and plain-chat messages run when the turn finishes.
    // Informational and stop commands run at once even mid-turn.
    const cmd = text.startsWith("/") ? parseCommand(text) : null;
    if (cmd && (turnActive || busy) && !waitsForTurn(cmd.name, cmd.arg)) {
      void runCommand(text);
      return;
    }
    if (turnActive || busy) {
      queueRef.current.push({ text, source: "user" });
      syncQueueLen();
      const agentWillSee = toolsMode !== "off" && !text.startsWith("/") && working;
      info(`${agentWillSee ? "⏎ Sent to the agent — delivered at its next step" : "⏳ Queued — runs when this turn ends"} · ${clip(text, 56)}`);
      return;
    }
    if (text.startsWith("/")) void runCommand(text);
    else void sendChat(text);
  };

  const onSpecialKey = (key: Key, _input: string, state: EditorState): boolean => {
    if (mode.type === "login") {
      if (key.escape) {
        setMode({ type: "chat" });
        setEditor(EMPTY);
        info("Login cancelled.");
        return true;
      }
      return false;
    }
    if (menuOpen) {
      const n = slashMatches.length;
      if (key.upArrow && n) return setSlashSel((s) => (s - 1 + n) % n), true;
      if (key.downArrow && n) return setSlashSel((s) => (s + 1) % n), true;
      if (key.escape) return setEditor(EMPTY), true;
      const chosen = slashMatches[slashSel];
      if (key.tab && chosen) {
        const v = `/${chosen.name}${chosen.args ? " " : ""}`;
        setEditor({ value: v, cursor: v.length });
        return true;
      }
      if (key.return && !key.shift && !key.meta && chosen) {
        // Commands that need an argument get completed instead of run empty.
        if (chosen.args && /^</.test(chosen.args)) {
          const v = `/${chosen.name} `;
          setEditor({ value: v, cursor: v.length });
          return true;
        }
        submitChat(`/${chosen.name}`);
        return true;
      }
      return false;
    }
    if (key.upArrow && onFirstLine(state) && history.length) {
      const idx = histIdx === null ? history.length - 1 : Math.max(0, histIdx - 1);
      if (histIdx === null) setDraft(state.value);
      setHistIdx(idx);
      const v = history[idx]!;
      setEditor({ value: v, cursor: v.length });
      return true;
    }
    if (key.downArrow && onLastLine(state) && histIdx !== null) {
      const idx = histIdx + 1;
      const v = idx >= history.length ? draft : history[idx]!;
      setHistIdx(idx >= history.length ? null : idx);
      setEditor({ value: v, cursor: v.length });
      return true;
    }
    return false;
  };

  // Mac paste fix (login mode): Terminal.app/iTerm2 deliver Cmd+V in several
  // broken shapes — ESC-prefixed (dropped as escape), per-char with meta set,
  // or one chunk with a trailing newline. Any single input >= 20 chars while
  // the login prompt is up IS the pasted key: capture it wholesale, strip
  // whitespace/control chars, and auto-submit.
  useInput(
    (input, key) => {
      if (mode.type !== "login" || key.ctrl || key.escape || key.meta || key.return) return;
      const cleaned = input.replace(/[\x00-\x1f\x7f]/g, "").replace(/\s+/g, "");
      if (cleaned.length >= 20 && cleaned.startsWith("sk-")) {
        void submitLogin(cleaned);
      }
    },
    { isActive: mode.type === "login" },
  );

  // Global keys: approvals, Esc/Ctrl+C stop, Ctrl+D exits.
  useInput((input, key) => {
    // Pending action approval: only y/a/n (or 1/2/3) answer; Enter and other
    // keys keep waiting. Input in the first 150ms after arming is dropped
    // (the submit-Enter echo on Windows terminals).
    if (approvalAnswerRef.current) {
      const armedFor = Date.now() - approvalArmedAt.current;
      if (key.ctrl && input === "c") {
        approvalAnswerRef.current(false);
        abortRef.current?.abort();
        return;
      }
      // With an empty input, y/a/n (1/2/3) and Esc answer the prompt.
      if (!editor.value) {
        const answer = approvalAnswer(input ?? "", key, armedFor);
        if (answer !== undefined) {
          approvalAnswerRef.current(answer);
          return;
        }
      } else if (key.escape) {
        approvalAnswerRef.current(false);
        return;
      }
      // Anything else is the start of a message: keep it as a draft instead
      // of dropping it. Once a draft exists, every key goes to the draft, so
      // typing can never answer the prompt by accident. Enter sends the draft
      // to the agent (delivered at its next step); the prompt stays open.
      if (armedFor < 150 || key.ctrl || key.meta || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      if (key.return) {
        if (editor.value.trim()) submitChat(editor.value);
        return;
      }
      if (key.backspace || key.delete) {
        const value = editor.value.slice(0, -1);
        setEditor({ value, cursor: value.length });
        return;
      }
      const text = (input ?? "").replace(/[\x00-\x1f\x7f]/g, "");
      if (text) {
        const value = editor.value + text;
        setEditor({ value, cursor: value.length });
      }
      return;
    }
    // plan approval: arrow-select Start/Cancel, Enter confirms, Esc = cancel
    if (mode.type === "plan-approve" && planAnswerRef.current) {
      if (Date.now() - approvalArmedAt.current < 150) return;
      const ch = (input ?? "").trim().toLowerCase();
      if (ch === "y") { planAnswerRef.current(true); return; }
      if (ch === "n") { planAnswerRef.current(false); return; }
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) {
        setMode({ ...mode, selected: mode.selected === 0 ? 1 : 0 });
        return;
      }
      if (key.return && !key.shift) { planAnswerRef.current(mode.selected === 0); return; }
      if (key.escape) { planAnswerRef.current(false); return; }
      if (key.ctrl && input === "c") { planAnswerRef.current(false); abortRef.current?.abort(); }
      return;
    }
    // With the slash menu open, Esc only closes the menu.
    if (key.escape && abortRef.current && (turnActive || busy) && !menuOpen && (mode.type === "chat" || mode.type === "login")) {
      // Two-stage: first Esc arms, second Esc actually stops the running turn
      // (and the queue drains the next one). A stray Esc can't kill a long run.
      if (escArmed.current) {
        escArmed.current = false;
        setFlash(null);
        abortRef.current.abort();
        return;
      }
      escArmed.current = true;
      const waiting = queueRef.current.length;
      showFlash(waiting ? `Esc again to stop — ${waiting} queued will run next` : "Press Esc again to stop", 2500);
      return;
    }
    if (key.ctrl && input === "t") {
      setAgentsExpanded((v) => !v);
      return;
    }
    if (key.ctrl && input === "o") {
      verboseCommand("");
      return;
    }
    if (key.ctrl && input === "c") {
      if (abortRef.current) {
        abortRef.current.abort();
        if (busy) {
          setBusy(null);
          info("Cancelled.");
          if (mode.type === "picker") setMode({ type: "chat" });
        }
        return;
      }
      if (mode.type !== "chat") {
        setMode({ type: "chat" });
        setEditor(EMPTY);
        return;
      }
      if (editor.value) {
        setEditor(EMPTY);
        return;
      }
      if (exitArmed.current) return quit();
      exitArmed.current = true;
      showFlash("Press Ctrl+C again to exit");
      return;
    }
    if (key.ctrl && input === "d" && !editor.value && !turnActive) quit();
  });

  // Effort and skills picker keys.
  useInput(
    (input, key) => {
      if (mode.type === "effort") {
        const n = EFFORTS.length;
        if (key.upArrow) setMode({ ...mode, selected: (mode.selected - 1 + n) % n });
        else if (key.downArrow) setMode({ ...mode, selected: (mode.selected + 1) % n });
        else if (key.escape) setMode({ type: "chat" });
        else if (key.return || key.tab) {
          setMode({ type: "chat" });
          const next = EFFORTS[mode.selected]!;
          if (next === effort) info(`Effort is already ${next}.`);
          else setAndSaveEffort(next);
        }
      } else if (mode.type === "skills") {
        const n = mode.list.length;
        if (key.upArrow) setMode({ ...mode, selected: (mode.selected - 1 + n) % n });
        else if (key.downArrow) setMode({ ...mode, selected: (mode.selected + 1) % n });
        else if (key.escape || key.return) setMode({ type: "chat" });
        else if (input === " " || key.tab) {
          const skill = mode.list[mode.selected];
          if (skill) toggleSkill(skill.name);
        }
      }
    },
    { isActive: mode.type === "effort" || mode.type === "skills" },
  );

  // Tool permission picker keys: an explicit selection is required.
  useInput(
    (_input, key) => {
      if (mode.type !== "tool-permissions") return;
      if (key.escape) {
        setMode({ type: "chat" });
        return;
      }
      if (key.ctrl || key.meta) return;
      if (Date.now() - approvalArmedAt.current < 150) return;
      const n = TOOL_CHOICES.length;
      if (key.upArrow) setMode({ ...mode, selected: (mode.selected - 1 + n) % n });
      else if (key.downArrow || key.tab) setMode({ ...mode, selected: (mode.selected + 1) % n });
      else if (key.return && !key.shift) {
        const choice = TOOL_CHOICES[mode.selected];
        if (choice) {
          setMode({ type: "chat" });
          toolsCommand(choice.key);
        }
      }
    },
    { isActive: mode.type === "tool-permissions" },
  );

  // Session picker keys.
  useInput(
    (input, key) => {
      if (mode.type !== "sessions") return;
      const n = mode.list.length;
      const current = mode.list[mode.selected];
      if (mode.confirmDelete) {
        if (input === "y" && current) {
          deleteSession(current.id);
          if (session.current?.id === current.id) session.current = null;
          const list = mode.list.filter((s) => s.id !== current.id);
          if (list.length === 0) {
            setMode({ type: "chat" });
            success("Deleted. No saved chats left.");
          } else setMode({ ...mode, list, selected: Math.min(mode.selected, list.length - 1), confirmDelete: false });
        } else setMode({ ...mode, confirmDelete: false });
        return;
      }
      if (key.upArrow) setMode({ ...mode, selected: (mode.selected - 1 + n) % n });
      else if (key.downArrow) setMode({ ...mode, selected: (mode.selected + 1) % n });
      else if (key.escape) setMode({ type: "chat" });
      else if ((key.return || key.tab) && current) resumeSession(current);
      else if ((input === "d" || key.delete) && current) setMode({ ...mode, confirmDelete: true });
      else if (input === "a" && mode.scope === "folder") {
        const all = listSessions();
        setMode({ ...mode, list: all, selected: 0, scope: "all" });
      }
    },
    { isActive: mode.type === "sessions" },
  );

  // Model picker keys.
  useInput(
    (_input, key) => {
      if (mode.type !== "picker" || !mode.models) {
        if (key.escape) setMode({ type: "chat" });
        return;
      }
      const n = mode.models.length;
      if (key.upArrow) setMode({ ...mode, selected: (mode.selected - 1 + n) % n });
      else if (key.downArrow) setMode({ ...mode, selected: (mode.selected + 1) % n });
      else if (key.escape) setMode({ type: "chat" });
      else if (key.return || key.tab) {
        const next = mode.models[mode.selected]!;
        setMode({ type: "chat" });
        if (next === model) info(`Already using ${next}.`);
        else setAndSaveModel(next);
      }
    },
    { isActive: mode.type === "picker" },
  );

  // Drain the queue whenever nothing is running: the next queued prompt,
  // goal continuation or due loop run starts here, one at a time.
  const idle = !turnActive && !busy && mode.type === "chat" && !approval;
  useEffect(() => {
    if (!idle || queueRef.current.length === 0 || runningTurn.current) return;
    const next = queueRef.current.shift()!;
    syncQueueLen();
    // A command changes neither `idle` nor the queue tick by itself; re-tick
    // afterwards so whatever was queued behind it runs too.
    const command = async (text: string) => {
      try { await runCommand(text); }
      catch (err) { error(`/${text.slice(1).split(" ")[0]} failed: ${err instanceof Error ? err.message : String(err)}`); }
      finally { setQueueTick((n) => n + 1); }
    };
    if (next.source === "loop" && next.text.startsWith("/")) {
      // A looped slash command: run it, then always schedule the next run.
      void (async () => {
        await command(next.text);
        const l = loopRef.current;
        if (l && l.nextAt === null) {
          const delay = l.intervalMs ?? DYNAMIC_DEFAULT_S * 1000;
          setLoop({ ...l, nextAt: Date.now() + delay });
          info(`↻ Next loop run in ${formatDuration(delay)}.`);
        }
      })();
      return;
    }
    if (next.text.startsWith("/") && next.source === "user") void command(next.text);
    else {
      if (next.source === "loop") push({ kind: "info", text: `↻ Loop run ${loopRef.current?.iteration ?? ""} · ${clip(next.text, 70)}` });
      void sendChat(next.text, next.source);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idle, queueTick]);

  // ---------- render ----------

  const width = size.columns;
  // You can keep typing while a turn runs; Enter queues it or sends it to the agent.
  const promptActive = mode.type === "chat" && approval === null && planAnswerRef.current === null || mode.type === "login";

  if (exiting) {
    return <Transcript key={staticKey} items={items} width={width} />;
  }

  const stopHint = flash ?? "esc esc to stop";
  const liveRows = streamingRowBudget(size.rows, width, editor.value, false, mode.type === "plan-approve" || !!approval) - Math.min(6, live.current.groups.reduce((n, g) => n + g.tasks.length + 1, 0));

  return (
    <>
      <Transcript key={staticKey} items={items} width={width} />

      {fx && <FinishFlourish streaming={turnActive} />}

      {stream?.thinking?.trim() ? (
        <Box flexDirection="column" marginTop={1}>
          <Thinking text={stream.thinking} width={width} maxLines={Math.max(2, Math.min(8, Math.floor(liveRows / 2)))} />
        </Box>
      ) : null}

      {stream && stream.text.trim() ? (
        <Box flexDirection="column" marginTop={1}>
          <AssistantText text={stream.text} first={!stream.flushed} maxLines={Math.max(1, liveRows)} width={width} hiddenCharacters={stream.hiddenCharacters} />
        </Box>
      ) : null}

      {turnActive && (
        <Box marginTop={1}>
          <ActivityBar read={() => live.current} width={width} hint={stopHint} expanded={agentsExpanded} stats={verbose ? () => sessionStats.current : undefined} maxTaskRows={Math.max(2, Math.min(agentsExpanded ? 16 : 8, size.rows - 14))} />
        </Box>
      )}

      {busy && !turnActive && (
        <Box marginTop={1}>
          <Spinner label={busy} />
        </Box>
      )}

      {approval && <ApprovalBox approval={approval} width={width} />}

      {mode.type === "picker" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>{theme.bold("Select a model")}{theme.dim("  ↑/↓ move · Enter select · Esc cancel")}</Text>
          {mode.models ? (
            <SelectList items={mode.models.map((m) => ({ key: m, label: m, hint: MODEL_SPEED_HINTS[m] ?? "", current: m === model }))} selected={mode.selected} max={10} />
          ) : (
            <Spinner label="Loading models" />
          )}
        </Box>
      )}

      {mode.type === "sessions" && (
        <Box flexDirection="column" marginTop={1}>
          <Text wrap="truncate-end">
            {theme.bold(mode.scope === "folder" ? `Resume a chat from ${prettyPath(process.cwd())}` : "Saved chats")}
            {theme.dim(`  ↑/↓ move · Enter resume · d delete${mode.scope === "folder" ? " · a all folders" : ""} · Esc cancel`)}
          </Text>
          <SelectList
            items={mode.list.map((s, i) => ({
              key: s.id,
              label: `${String(i + 1).padStart(2)}. ${s.title}`,
              hint: `${timeAgo(s.updated)} · ${s.count} msg${s.count === 1 ? "" : "s"}${mode.scope === "all" ? " · " + prettyPath(s.cwd) : ""}`,
              current: session.current?.id === s.id,
            }))}
            selected={mode.selected}
            max={Math.max(3, Math.min(10, size.rows - 8))}
          />
          {mode.confirmDelete && <Text>{theme.warn(`Delete "${mode.list[mode.selected]?.title}"? Press y to confirm, any other key to cancel.`)}</Text>}
        </Box>
      )}

      {mode.type === "effort" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            {theme.bold("Reasoning effort")}
            {theme.dim("  ↑/↓ move · Enter select · Esc cancel")}
          </Text>
          <SelectList items={EFFORTS.map((e) => ({ key: e, label: e, hint: EFFORT_HINTS[e], current: e === effort }))} selected={mode.selected} />
        </Box>
      )}

      {mode.type === "tool-permissions" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>{theme.bold("Choose tool permissions")}{theme.dim("  ↑/↓ move · Enter select · Esc cancel")}</Text>
          <Text>{theme.dim("File changes and commands run on your PC. Select the access you authorize.")}</Text>
          <SelectList items={TOOL_CHOICES.map((choice) => ({ key: choice.key, label: choice.label, hint: choice.hint, current: choice.key === toolsMode }))} selected={mode.selected} max={4} />
        </Box>
      )}

      {mode.type === "plan-approve" && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1} width={Math.min(width - 1, 90)}>
          <Text>{theme.bold("Start this plan?")}{theme.dim(`  ${mode.steps.length} steps`)}</Text>
          <SelectList
            items={[
              { key: "yes", label: theme.ok("Yes, start it"), hint: "  y", mark: "" },
              { key: "no", label: theme.warn("No, tell me what to change"), hint: "  n / Esc", mark: "" },
            ]}
            selected={mode.selected}
            max={2}
          />
        </Box>
      )}

      {mode.type === "skills" && (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            {theme.bold("Skills")}
            {theme.dim("  ↑/↓ move · Space toggle · Enter done · /skills new <name> to add one")}
          </Text>
          <SelectList
            items={mode.list.map((k) => ({
              key: k.name,
              label: `${activeSkills.includes(k.name) ? theme.ok("●") : theme.dim("○")} ${k.name}`,
              hint: `${k.description}${k.scope === "project" ? "  (this project)" : ""}`,
              mark: "",
            }))}
            selected={mode.selected}
            max={Math.max(3, Math.min(10, size.rows - 8))}
          />
        </Box>
      )}

      {mode.type !== "picker" && mode.type !== "sessions" && mode.type !== "effort" && mode.type !== "skills" && mode.type !== "tool-permissions" && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor={approval || mode.type === "plan-approve" ? "gray" : mode.type === "login" ? "yellow" : "gray"} paddingX={1} width={width}>
          <Prompt
            width={Math.max(10, width - 4)}
            maxRows={Math.max(1, Math.min(6, Math.floor(size.rows / 4)))}
            state={editor}
            onChange={(s) => {
              setEditor(s);
              if (exitArmed.current) {
                exitArmed.current = false;
                setFlash(null);
              }
              escArmed.current = false;
            }}
            onSubmit={mode.type === "login" ? (v) => void submitLogin(v) : submitChat}
            onSpecialKey={onSpecialKey}
            mask={mode.type === "login"}
            label={mode.type === "login" ? "API key: " : theme.brand("› ")}
            placeholder={mode.type === "login" ? "" : working && toolsMode !== "off" ? "Message the agent mid-task — delivered at its next step" : turnActive ? "Type to queue the next prompt" : 'Message Unjailed, or "/" for commands'}
            isActive={promptActive && !approval}
          />
        </Box>
      )}

      {menuOpen && (
        <Box flexDirection="column" marginLeft={1}>
          {slashMatches.length ? (
            <SelectList
              items={slashMatches.map((c) => ({ key: c.name, label: `/${c.name}${c.args ? " " + c.args : ""}`, hint: c.description + (turnActive && waitsForTurn(c.name, c.args?.startsWith("<") ? "x" : "") ? theme.dim(" · runs when this turn ends") : "") }))}
              selected={slashSel}
              max={8}
            />
          ) : (
            <Text>{theme.dim("  No matching commands")}</Text>
          )}
        </Box>
      )}

      <Footer width={width} model={model} effort={effort} skills={activeSkills.length} toolsMode={toolsMode} autoMode={autoMode} planMode={planMode} loggedIn={!!auth.key} flash={turnActive ? null : flash} queued={queueLen} ctx={usage ? { tokens: usage.ctx, approx: usage.approx } : null} goal={goal} loop={loop} verbose={verbose} session={sessionStats.current} />
    </>
  );
}

const WORKFLOW_TEMPLATE = (name: string) => `export const meta = {
  name: "${name}",
  description: "Investigate each area in parallel, then summarise",
  phases: [{ title: "Investigate" }, { title: "Summarise" }],
};

// args comes from: /workflow ${name} ["area one", "area two"]
const areas = Array.isArray(args) && args.length ? args : ["error handling", "tests"];

phase("Investigate");
const reports = await parallel(areas.map((area) => () =>
  agent(\`Investigate \${area} in this repository. Report concrete findings with file paths and line numbers.\`, { label: area, phase: "Investigate" }),
));

phase("Summarise");
const summary = await agent(
  "Combine these reports into a short prioritised list of findings:\\n\\n" + reports.filter(Boolean).join("\\n\\n---\\n\\n"),
  { label: "summary", phase: "Summarise" },
);

return summary;
`;

/** Latency hints in the model picker (upstream avg, refreshed 2026-10). */
const MODEL_SPEED_HINTS: Record<string, string> = {
  "deepseek-v4.1-flash": "fastest · 4s · $0.20/1M",
  "deepseek-v4-flash-0731": "fast · 4s · $0.25/1M",
  "glm-5.2": "fast · 6s · $0.45/1M",
  "kimi-k3": "quick · 7s · 1M ctx",
  "glm-5.3-flash": "quick · 9s · $0.12/1M",
  "glm-5.3-flash-uncensored": "quick · 9s · uncensored",
  "glm-5.3": "smart · 12s · best for agents",
  "glm-5.3-uncensored": "smart · 12s · uncensored",
  "glm-5.3-flash-abliterated": "slow · 26s · chat-oriented",
  "deepseek-v4-pro-0813": "smart · slow thinker",
};

const EFFORT_HINTS: Record<Effort, string> = {
  auto: "the model decides (default)",
  low: "quick answers, least thinking",
  medium: "balanced",
  high: "thinks longest — slower, uses more tokens",
};

function ApprovalBox({ approval, width }: { approval: Approval; width: number }) {
  const w = Math.min(width - 1, 100);
  const tool = toolTitle(approval.tool, {}).replace(/\x1b\[[0-9;]*m/g, "");
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="yellow" paddingX={1} width={w}>
      <Text wrap="truncate-end">{theme.warn("Permission needed")}{approval.agent ? theme.dim(`  · requested by agent "${approval.agent}"`) : ""}</Text>
      <Text wrap="truncate-end">{approval.title}</Text>
      {approval.body.map((line, i) => (
        <Text key={i} wrap="truncate-end">{"  " + line}</Text>
      ))}
      <Text> </Text>
      <Text wrap="truncate-end">
        {theme.ok("y")} yes   {theme.brand("a")} yes, and don't ask again for {tool} this session   {theme.err("n")} no {theme.dim("(esc)")}
      </Text>
      <Text wrap="truncate-end">{theme.dim("Type anything else to write the agent a message; Enter sends it.")}</Text>
    </Box>
  );
}

/** The line under the input: model and modes on the left, context on the right.
 *  Parts drop out by priority as the terminal narrows. */
function Footer({ width, model, effort, skills, toolsMode, autoMode, planMode, loggedIn, flash, queued, ctx, goal, loop, verbose, session }: {
  verbose: boolean;
  session?: SessionStats;
  width: number; model: string; effort: Effort; skills: number; toolsMode: "off" | "read" | "cmds" | "yolo"; autoMode: "ask" | "auto"; planMode: "off" | "on"; loggedIn: boolean; flash: string | null; queued: number; ctx: { tokens: number; approx: boolean } | null; goal: Goal | null; loop: LoopState | null;
}) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!loop?.nextAt) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [loop?.nextAt]);
  // [text, priority] — lower priority is dropped first on narrow screens.
  const parts: [string, number][] = [];
  if (!loggedIn) parts.push([theme.warn("○ not logged in · /login"), 10]);
  parts.push([theme.brand("◆ ") + model, 9]);
  if (toolsMode !== "off") parts.push([(toolsMode === "read" ? tone.read : toolsMode === "cmds" ? tone.edit : tone.failed)(`tools ${toolsMode}`), 6]);
  if (autoMode === "auto" && toolsMode !== "yolo") parts.push([tone.failed("auto-approve"), 6]);
  if (planMode === "on" && (toolsMode === "cmds" || toolsMode === "yolo")) parts.push([theme.dim("plan"), 3]);
  if (effort !== "auto") parts.push([theme.dim(`effort ${effort}`), 2]);
  if (verbose) parts.push([tone.thinking("verbose"), 5]);
  if (verbose && session && session.turns) parts.push([theme.dim(`Σ ↑${formatTokens(session.tokensIn)} ↓${formatTokens(session.tokens)} · ${session.tools} tools`), 3]);
  if (skills) parts.push([theme.dim(`${skills} skill${skills === 1 ? "" : "s"}`), 2]);
  if (goal) parts.push([tone.goal(`◎ goal ${goal.turns}/${goal.maxTurns}`), 8]);
  if (loop) parts.push([tone.agent(`↻ loop${loop.nextAt ? ` ${formatDuration(Math.max(0, loop.nextAt - Date.now()))}` : loop.lastReason === "paused" ? " paused" : " running"}`), 8]);
  if (queued) parts.push([theme.warn(`${queued} queued`), 7]);
  if (ctx && ctx.tokens > 0) parts.push([theme.dim(`${ctx.approx ? "~" : ""}${formatTokens(ctx.tokens)} ctx`), 4]);
  const right = flash ? theme.warn(flash) : width >= 70 ? theme.dim("/ commands · ? /help") : "";
  const sep = theme.dim(" · ");
  const visible = (s: string) => stringWidth(s.replace(/\x1b\[[0-9;]*m/g, ""));
  const room = width - 2 - (right ? visible(right) + 2 : 0);
  let kept = parts.slice();
  while (kept.length > 1 && visible(kept.map((p) => p[0]).join(sep)) > room) {
    const lowest = kept.reduce((min, p, i) => (p[1] < kept[min]![1] ? i : min), 0);
    kept = kept.filter((_, i) => i !== lowest);
  }
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text wrap="truncate-end">{kept.map((p) => p[0]).join(sep)}</Text>
      {right ? <Text wrap="truncate-start">{right}</Text> : null}
    </Box>
  );
}

/** Keep only the last lines that fit in `maxLines` terminal rows (after wrapping). */
function tailToFit(rendered: string, maxLines: number, width: number): { text: string; hidden: number } {
  const lines = rendered.split("\n");
  const usable = Math.max(10, width - 3);
  let rows = 0;
  let start = lines.length;
  while (start > 0) {
    const h = Math.max(1, Math.ceil(stringWidth(lines[start - 1]!) / usable));
    if (rows + h > maxLines) break;
    rows += h;
    start--;
  }
  return { text: lines.slice(start).join("\n"), hidden: start };
}

const AssistantText = memo(function AssistantText({ text, first, maxLines, width, hiddenCharacters = 0 }: { text: string; first: boolean; maxLines?: number; width?: number; hiddenCharacters?: number }) {
  // Render for the column the text actually gets (the bullet takes two), so
  // Ink never re-wraps a line the markdown renderer already sized.
  const cols = (width ?? (process.stdout.columns || 80)) - 2;
  let body = renderMarkdown(text, { width: cols, highlightCode: !maxLines });
  let hidden = 0;
  // While streaming, the live area must stay shorter than the terminal or Ink redraws the whole
  // screen on every token. Older lines show in full once the paragraph or reply finishes.
  if (maxLines && width) {
    ({ text: body, hidden } = tailToFit(body, maxLines, cols));
    if (hidden || hiddenCharacters) ({ text: body, hidden } = tailToFit(body || "", Math.max(0, maxLines - 1), cols));
  }
  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text>{first ? theme.brand("●") : " "}</Text>
      </Box>
      <Box flexGrow={1} flexShrink={1} flexDirection="column" width={cols}>
        {(hidden > 0 || hiddenCharacters > 0) && <Text wrap="truncate-end">{theme.dim("⋯ earlier text appears in full when this block finishes")}</Text>}
        {body ? <Text>{body}</Text> : null}
      </Box>
    </Box>
  );
});

const COMPACT = new Set(["info", "success", "error", "warn"]);

// Static output is already in terminal scrollback. Typing and streaming must
// not revisit every old message or re-render its markdown on each live update.
export const Transcript = memo(function Transcript({ items, width }: { items: Item[]; width: number }) {
  const { write, stdout } = useStdout();
  const printedThrough = useRef(0);
  const queued = useRef<Item[]>([]);
  const lastKind = useRef<string | null>(null);
  const timer = useRef<NodeJS.Immediate | undefined>(undefined);
  const columns = useRef(width);
  columns.current = width;
  useLayoutEffect(() => {
    const pending = items.filter((item) => item.id > printedThrough.current);
    if (!pending.length) return;
    printedThrough.current = items.reduce((latest, item) => Math.max(latest, item.id), printedThrough.current);
    queued.current.push(...pending);
    if (timer.current) return;
    // renderToString creates/frees a temporary Yoga tree. Run it outside the
    // React commit, then public stdout.write prints above the live UI. Unlike
    // Static, this does not accumulate Ink's fullStaticOutput transcript cache.
    timer.current = setImmediate(() => {
      timer.current = undefined;
      const batch = queued.current;
      queued.current = [];
      const nodes = batch.map((item) => {
        // Consecutive status notes sit together; everything else gets a blank line above.
        const gap = !(COMPACT.has(item.kind) && lastKind.current !== null && COMPACT.has(lastKind.current)) && lastKind.current !== null;
        lastKind.current = item.kind;
        return <TranscriptItem key={item.id} item={item} width={columns.current} gap={gap} />;
      });
      const output = renderToString(<Box flexDirection="column">{nodes}</Box>, { columns: columns.current });
      write(output + "\n");
    });
  }, [items, write]);
  useEffect(() => () => {
    if (timer.current) clearImmediate(timer.current);
    // Ink disables its managed write function before unmount effects run.
    // Flush any not-yet-rendered text directly while stdout is still open;
    // shutdown output is plain markdown, and cannot disappear on immediate exit.
    const remaining = queued.current;
    queued.current = [];
    if (remaining.length && !stdout.destroyed && !stdout.writableEnded) {
      const text = remaining.map((item) => item.kind === "header" ? "Unjailed AI" : "text" in item ? item.text : `${item.kind}`).join("\n\n");
      stdout.write(text + "\n");
    }
  }, []);
  return null;
});

function TranscriptItem({ item, width, gap }: { item: Item; width: number; gap: boolean }) {
  const top = gap ? 1 : 0;
  switch (item.kind) {
    case "header":
      return <Header model={item.model} loggedIn={item.loggedIn} keySource={item.keySource} width={width} />;
    case "user":
      return (
        <Box flexDirection="row" marginTop={top}>
          <Box width={2} flexShrink={0}>
            <Text>{theme.brand("›")}</Text>
          </Box>
          <Box width={Math.max(10, width - 2)}>
            <Text>{theme.bold(sanitizeForDisplay(item.text))}</Text>
          </Box>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={top}>
          <AssistantText text={item.text} first={item.first} width={width} />
        </Box>
      );
    case "tool":
      return (
        <Box marginTop={top} width={width}>
          <Text>{formatToolBlock(item.name, item.args, item.ok, item.output, width, item.note, item.verbose)}</Text>
        </Box>
      );
    case "thinking":
      return (
        <Box marginTop={top}>
          <Thinking text={item.text} width={width} />
        </Box>
      );
    case "turn": {
      const color = item.tone === "error" ? theme.err : item.tone === "warn" ? theme.warn : theme.dim;
      return <Note top={top} width={width} icon={color(item.tone === "error" ? "✗" : item.tone === "warn" ? "!" : "✻")} text={color(sanitizeForDisplay(item.text))} />;
    }
    case "success":
      return <Note top={top} width={width} icon={theme.ok("✓")} text={item.text} />;
    case "error":
      return <Note top={top} width={width} icon={theme.err("✗")} text={item.text} />;
    case "warn":
      return <Note top={top} width={width} icon={theme.warn("!")} text={item.text} />;
    case "info":
      return (
        <Box marginTop={top} width={width} paddingLeft={2}>
          <Text>{theme.dim(item.text)}</Text>
        </Box>
      );
    case "plain":
      return (
        <Box marginTop={top} paddingLeft={2} width={width}>
          <Text>{item.text}</Text>
        </Box>
      );
  }
}

/** An icon column plus text that wraps under itself, not under the icon. */
function Note({ top, width, icon, text }: { top: number; width: number; icon: string; text: string }) {
  return (
    <Box marginTop={top} width={width} flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text>{icon}</Text>
      </Box>
      <Box width={Math.max(10, width - 2)}>
        <Text>{text}</Text>
      </Box>
    </Box>
  );
}

function helpText(): string {
  const cmdW = Math.max(...COMMANDS.map((c) => `/${c.name}${c.args ? " " + c.args : ""}`.length)) + 3;
  const cmds = COMMANDS.map((c) => `${theme.brand(`/${c.name}${c.args ? " " + c.args : ""}`.padEnd(cmdW))}${c.description}`);
  const keys: [string, string][] = [
    ["Enter", "Send · while the agent works, messages reach it at its next step (queued if tools are off) and most /commands run at once"],
    ["Shift+Enter or \\ then Enter", "New line (Alt+Enter / Ctrl+J also work)"],
    ["↑ / ↓", "Previous / next input"],
    ["Tab", "Complete the highlighted /command · select in pickers"],
    ["Ctrl+A / Ctrl+E", "Start / end of line"],
    ["Ctrl+U / Ctrl+K / Ctrl+W", "Delete to line start / to line end / previous word"],
    ["Space", "Toggle a skill in /skills"],
    ["y / a / n  (1 / 2 / 3)", "Answer a permission prompt: yes · yes for the session · no (Esc = no); plan prompts take y / n or ←/→ + Enter"],
    ["Ctrl+T", "Expand or collapse the live agents view"],
    ["Ctrl+O", "Verbose: show thinking, subagent steps and full tool output"],
    ["Esc", "Close menus · while working, press twice to stop"],
    ["Ctrl+C", "Stop the response · close a picker · clear input · press twice to exit"],
    ["Ctrl+D", "Exit (when the input is empty and nothing is running)"],
  ];
  const keyW = Math.max(...keys.map(([k]) => k.length)) + 3;
  return [
    theme.bold("Commands"),
    ...cmds,
    "",
    theme.bold("Keys"),
    ...keys.map(([k, d]) => theme.brand(k.padEnd(keyW)) + d),
  ].join("\n");
}
