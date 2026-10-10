import React, { useCallback, useEffect, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput, useStdout, type Key } from "ink";
import { AbortedError, ApiError, listModels, streamChatRetry, agentTurn, repairToolPairing, toPlainChat, type AgentMessage, type ChatMessage } from "../api.js";
import { COMMANDS, filterCommands, parseCommand } from "../commands.js";
import { configPath, deleteKey, EFFORTS, maskKey, readConfig, resolveBaseUrl, resolveKey, writeConfig, type Effort, type KeySource } from "../config.js";
import { executeTool, toolDefinitions } from "../tools.js";
import { approvalAnswer } from "./approval.js";
import { currentVersion, latestVersion, runSelfUpdate } from "../updater.js";
import { recoverAuth, tryClearEnvKeyWindows } from "../auth-recovery.js";
import { createSkill, loadSkills, projectSkillsDir, skillsSystemPrompt, userSkillsDir, type Skill } from "../skills.js";
import { agentSystemPrompt } from "../system-prompt.js";
import { DEFAULT_MODEL, DEFAULT_TOOLS } from "../constants.js";
import { planSteps } from "./plan.js";
import { renderMarkdown } from "../markdown.js";
import { theme } from "../theme.js";
import { Header } from "./Header.js";
import { FinishFlourish } from "./Snow.js";
import { fxEnabled } from "./fx.js";
import { onFirstLine, onLastLine, Prompt, type EditorState } from "./Prompt.js";
import { SelectList } from "./SelectList.js";
import { Spinner, type WorkKind } from "./Spinner.js";
import { useTerminalSize } from "./useTerminalSize.js";
import {
  deleteSession,
  findSession,
  listSessions,
  loadSession,
  newSession,
  prettyPath,
  pruneSessions,
  saveSession,
  sessionsDir,
  sessionsEnabled,
  timeAgo,
  titleFrom,
  type Session,
  type SessionMeta,
} from "../sessions.js";
import stringWidth from "string-width";

type Item =
  | { id: number; kind: "header"; model: string; loggedIn: boolean; keySource: KeySource }
  | { id: number; kind: "user"; text: string }
  | { id: number; kind: "assistant"; text: string; first: boolean }
  | { id: number; kind: "info" | "success" | "error" | "plain"; text: string };

// Omit distributed over the union so each variant keeps its own fields.
type NewItem = Item extends infer T ? (T extends Item ? Omit<T, "id"> : never) : never;

type Mode =
  | { type: "chat" }
  | { type: "login" }
  | { type: "picker"; models: string[] | null; selected: number }
  | { type: "sessions"; list: SessionMeta[]; selected: number; scope: "folder" | "all"; confirmDelete: boolean }
  | { type: "effort"; selected: number }
  | { type: "skills"; list: Skill[]; selected: number }
  | { type: "plan-approve"; steps: string[]; selected: number }; // 0 = start, 1 = cancel

interface Stream {
  text: string; // not yet flushed to the transcript
  started: boolean; // any content received
  reasoning: boolean;
  flushed: boolean; // earlier paragraphs already moved to the transcript
  reasoningChars: number; // live thinking volume (models can think for minutes)
  reasoningTail: string; // last ~90 chars of thinking, for a live peek
}

const NOT_LOGGED_IN = "Not logged in — type /login";
const EMPTY: EditorState = { value: "", cursor: 0 };

let nextId = 0;
const id = () => ++nextId;

function friendly(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return "Something went wrong. Try again.";
}

/** Index just past the last blank line that is outside a code fence, or -1. */
function safeFlushPoint(text: string): number {
  let inFence = false;
  let point = -1;
  let offset = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i]!;
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    offset += line.length + 1;
    if (inFence) continue;
    // blank line outside a fence = paragraph boundary (original rule)
    if (line.trim() === "" && i > 0) { point = offset; continue; }
    // completed table row = safe boundary too — tables stream row-by-row and
    // have no blank lines inside them, so without this a mid-table reply sat
    // unflushed in the live area until the whole response finished (and the
    // live area is height-clipped → looked cut off)
    if (line.trim().startsWith("|") && !/^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line)) {
      point = offset;
    }
  }
  return point;
}

export function App({ startup }: { startup?: "continue" | "resume" } = {}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const size = useTerminalSize();

  const [auth, setAuth] = useState(() => resolveKey());
  const [baseUrl] = useState(() => resolveBaseUrl());
  const [model, setModel] = useState(() => process.env.UNJAILED_MODEL || readConfig().model || DEFAULT_MODEL);
  const [effort, setEffort] = useState<Effort>(() => readConfig().effort ?? "auto");
  // Agent tools: "off" | "read" (read-only) | "cmds" (default: writes + commands, each confirmed) | "yolo" (no confirm)
  const [toolsMode, setToolsMode] = useState<"off" | "read" | "cmds" | "yolo">(() => readConfig().tools ?? DEFAULT_TOOLS);
  /** Agent autonomy: ask (default) confirms commands · auto runs them */
  const [autoMode, setAutoMode] = useState<"ask" | "auto">(() => (readConfig().autoMode === "auto" ? "auto" : "ask"));
  /** Plan mode (opt-in via /plan): model writes a plan first, user approves, then it executes */
  const [planMode, setPlanMode] = useState<"off" | "on">(() => (readConfig().plan === true ? "on" : "off"));
  // Skills switched on for this chat (by name). Their files are re-read on every request.
  const [activeSkills, setActiveSkills] = useState<string[]>([]);

  const [items, setItems] = useState<Item[]>(() => [
    { id: id(), kind: "header", model, loggedIn: !!auth.key, keySource: auth.source },
  ]);
  const [staticKey, setStaticKey] = useState(0);
  const [mode, setMode] = useState<Mode>({ type: "chat" });
  const [editor, setEditor] = useState<EditorState>(EMPTY);
  const [slashSel, setSlashSel] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [stream, setStream] = useState<Stream | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  // Token usage for the current conversation: ctx = prompt tokens of the most
  // recent request (= current context size). approx when the server sent none.
  const [usage, setUsage] = useState<{ ctx: number; prompt: number; completion: number; approx: boolean } | null>(null);
  const [fx, setFx] = useState<boolean>(() => fxEnabled());

  // The conversation, including agent tool calls and their results so later
  // turns remember what was done. Folded to plain chat wherever tools aren't sent.
  const messages = useRef<AgentMessage[]>([]);
  const session = useRef<Session | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const exitArmed = useRef(false);
  const flashTimer = useRef<NodeJS.Timeout | undefined>(undefined);
  // Prompts typed while a reply is streaming wait here and run in order.
  const queueRef = useRef<string[]>([]);
  const [queueLen, setQueueLen] = useState(0);
  // Esc is two-stage while working: first press arms, second actually stops/skips.
  const escArmed = useRef(false);

  const push = useCallback((...newItems: NewItem[]) => {
    setItems((prev) => [...prev, ...newItems.map((it) => ({ ...it, id: id() }) as Item)]);
  }, []);
  const info = (text: string) => push({ kind: "info", text });
  const success = (text: string) => push({ kind: "success", text });
  const error = (text: string) => push({ kind: "error", text });

  // Put a prompt on the queue to run after the current reply finishes.
  const enqueue = (text: string) => {
    queueRef.current.push(text);
    setQueueLen(queueRef.current.length);
    const preview = text.length > 56 ? text.slice(0, 56) + "…" : text;
    push({ kind: "info", text: `⏳ Queued (${queueRef.current.length}) · ${preview}` });
  };

  const showFlash = (text: string, ms = 2000) => {
    setFlash(text);
    clearTimeout(flashTimer.current);
    flashTimer.current = setTimeout(() => {
      setFlash(null);
      exitArmed.current = false;
      escArmed.current = false;
    }, ms);
  };

  // After a resize, wipe the screen and reprint the transcript at the new width. Ink alone
  // can't erase lines that the terminal re-wrapped, which leaves broken frames behind.
  const firstSize = useRef(true);
  useEffect(() => {
    if (firstSize.current) {
      firstSize.current = false;
      return;
    }
    const t = setTimeout(() => {
      stdout.write("\x1b[2J\x1b[3J\x1b[H");
      setItems((prev) => (prev[0]?.kind === "header" ? [{ ...prev[0], id: id(), model, loggedIn: !!auth.key, keySource: auth.source }, ...prev.slice(1)] : prev));
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

  // Exit on the next render so the live area (prompt, menus) is cleared first.
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    if (exiting) exit();
  }, [exiting, exit]);
  const quit = () => {
    abortRef.current?.abort();
    setExiting(true);
  };

  // ---------- chat ----------

  const sendChat = async (text: string) => {
    if (!auth.key) {
      push({ kind: "user", text });
      error(NOT_LOGGED_IN);
      return;
    }
    push({ kind: "user", text });
    messages.current.push({ role: "user", content: text });

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let full = "";
    let pending = "";
    let reasoningChars = 0;
    let reasoningTail = "";
    let flushedAny = false;
    let reasoning = false;
    let gotUsage = false;
    let timer: NodeJS.Timeout | undefined;
    let agentHistory: AgentMessage[] | null = null;

    const sync = () => {
      timer = undefined;
      // Move finished paragraphs into the transcript so the live area stays small.
      const point = safeFlushPoint(pending);
      if (point > 0) {
        const done = pending.slice(0, point).replace(/\n+$/, "");
        pending = pending.slice(point);
        if (done.trim()) {
          push({ kind: "assistant", text: done, first: !flushedAny });
          flushedAny = true;
        }
      }
      setStream({ text: pending, started: full.length > 0, reasoning, flushed: flushedAny, reasoningChars, reasoningTail });
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(sync, 40);
    };

    lastDataAt.current = Date.now();
    toolArgs.current = null;
    setStream({ text: "", started: false, reasoning: false, flushed: false, reasoningChars: 0, reasoningTail: "" });
    let outcome: "done" | "stopped" | "error" = "done";
    let errMsg = "";
    const useTools = toolsMode !== "off";
    const yolo = toolsMode === "yolo" || autoMode === "auto";

    try {
      const baseMessages = withSystem(messages.current, useTools);
      const streamHandlers = {
        onToken: (t: string) => {
          lastDataAt.current = Date.now();
          full += t;
          pending += t;
          schedule();
        },
        onReasoning: (t: string) => {
          lastDataAt.current = Date.now();
          if (!reasoning) { reasoning = true; schedule(); }
          reasoningChars += t ? t.length : 0;
          if (t) reasoningTail = (reasoningTail + t).slice(-90);
          schedule();
        },
        onUsage: (u: { prompt: number; completion: number; total: number }) => {
          gotUsage = true;
          // In agent mode onUsage fires each round; the latest request's prompt
          // count is the live context size (last round's completion for "out").
          setUsage({ ctx: u.prompt, prompt: u.prompt, completion: u.completion, approx: false });
        },
        onToolArgs: (name: string, chars: number) => {
          lastDataAt.current = Date.now();
          toolArgs.current = { name, chars };
          schedule();
        },
      };

      // ── auto-effort: trivial asks don't pay for deep thinking ──
      // short prompt + no mutation verbs + no question-of-depth → low effort.
      const autoEffortFor = (t: string): Effort => {
        if (effort !== "auto") return effort; // user pinned a level: respect it
        const words = t.trim().split(/\s+/).length;
        const deep = /\b(why|how|explain|design|architect|debug|refactor|plan|analyz|compare|optimi[sz]e|write|build|implement)\b/i.test(t);
        const trivial = /^(hi|hey|hello|yo|thanks|thank you|ok|okay|test|yes|no)\b/i.test(t.trim());
        if (trivial || (words <= 6 && !deep)) return "low";
        return "auto";
      };

      if (!useTools) {
        // Plain chat: if the model spends its whole token budget on hidden
        // reasoning and finishes with finish_reason=length but no visible text,
        // nudge it to answer and resume (up to 2×) — the same recovery the agent
        // loop already does, so "thinking → empty reply" is fixed here too.
        const msgs = [...baseMessages] as ChatMessage[];
        let resumes = 0;
        for (;;) {
          const before = full.length;
          const res = await streamChatRetry(baseUrl, auth.key, model, msgs, streamHandlers, ctrl.signal, { effort: autoEffortFor(text) });
          const producedNothing = full.length === before;
          if (res?.finishReason === "length" && producedNothing && resumes < 2) {
            resumes++;
            push({ kind: "info", text: "Model spent its budget thinking — nudging it to answer…" });
            msgs.push({ role: "user", content: "Continue now. Skip any further deliberation and give the answer directly." });
            continue;
          }
          break;
        }
      } else {
        // agent loop: definitions + executor; run_command asks unless yolo/auto
        const defs = toolDefinitions(toolsMode);
        const history: AgentMessage[] = [...baseMessages];
        agentHistory = history;

        // ── plan mode: mutating jobs get a numbered plan + explicit approval first ──
        if (planMode === "on" && (toolsMode === "cmds" || toolsMode === "yolo")) {
          const approved = await planFirst(history, ctrl);
          if (!approved) {
            agentHistory = null;
            if (full.trim()) messages.current.push({ role: "assistant", content: full });
            setStream(null);
            abortRef.current = null;
            return;
          }
        }

        // ── context diet: shrink OLD tool results before each turn ──
        // The loop resends the whole history every round; by round 8 that's
        // tens of thousands of tokens of stale output that cost time AND money.
        // Tiered by age (newest→oldest), shrinking content only so tool_call/
        // tool_result pairing is never broken: newest 2 stay full, the next few
        // keep a head+tail, and anything older collapses to a one-line stub.
        const dietHistory = (h: AgentMessage[]): AgentMessage[] => {
          let toolSeenFromEnd = 0;
          for (let i = h.length - 1; i >= 0; i--) {
            const m = h[i]!;
            if (m.role !== "tool" || typeof m.content !== "string") continue;
            toolSeenFromEnd++;
            if (toolSeenFromEnd <= 2) continue; // newest two: full
            if (toolSeenFromEnd <= 5) {         // middle: head + tail
              if (m.content.length > 500) (m as { content: string }).content = m.content.slice(0, 250) + "\n…(trimmed)\n" + m.content.slice(-150);
            } else {                            // oldest: stub
              if (m.content.length > 120) (m as { content: string }).content = m.content.slice(0, 80) + " …[old tool result trimmed]";
            }
          }
          return h;
        };
        dietHistory(history);

        const finalText = await agentTurn(baseUrl, auth.key, model, history, {
          ...streamHandlers,
          onToolCall: (name, args) => {
            let argsObj: Record<string, unknown> = {};
            try { argsObj = JSON.parse(args || "{}"); } catch { /* raw */ }
            toolArgs.current = null;
            liveTool.current = { name, detail: toolDetail(name, argsObj), t0: Date.now() };
            push({ kind: "info", text: `⚙ ${name} ${clipArgs(args)}` });
          },
          onToolResult: (name, ok, output) => {
            liveTool.current = null;
            lastDataAt.current = Date.now(); // the next request starts now
            schedule();
            push({ kind: ok ? "info" : "error", text: ok ? `↳ ${clipResult(output)}` : `↳ failed: ${clipResult(output)}` });
          },
        }, ctrl.signal, {
          effort: autoEffortFor(text),
          tools: defs,
          execute: (name, args) => executeTool(name, args, process.cwd(), async (command) => {
            push({ kind: "plain", text: `${theme.warn("Allow this action?")}\n  ${command}\n${theme.dim("  y = run · n or Esc = skip")}` });
            setConfirmingCommand(command);
            const answer = await askYesNo();
            if (!answer) info("Skipped by user.");
            return answer;
          }, { mode: toolsMode, autoApprove: yolo, signal: ctrl.signal }),
        });
        // keep transcript consistent when the final text already streamed
        if (finalText && !full.trim()) { full = finalText; }
      }
    } catch (err) {
      if (err instanceof AbortedError) outcome = "stopped";
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
      }
      else {
        outcome = "error";
        errMsg = friendly(err);
      }
    } finally {
      clearTimeout(timer);
      abortRef.current = null;
    }

    const rest = pending.replace(/\n+$/, "");
    if (rest.trim()) push({ kind: "assistant", text: rest, first: !flushedAny });
    setStream(null);

    if (agentHistory) {
      // The agent transcript (tool calls + results + replies) becomes the
      // conversation — even after a stop, so finished actions aren't forgotten.
      const h: AgentMessage[] = agentHistory;
      repairToolPairing(h);
      messages.current = h.filter((m) => m.role !== "system");
      if (messages.current[messages.current.length - 1]?.role === "user") {
        // no round completed (stopped or failed mid-reply)
        if (full.trim()) messages.current.push({ role: "assistant", content: full });
        else if (outcome !== "done") messages.current.pop();
      }
    } else if (full.trim()) messages.current.push({ role: "assistant", content: full });
    else if (outcome !== "done") messages.current.pop(); // nothing came back; don't leave a dangling turn
    persist();

    // Server didn't report usage — show a rough estimate (chars/4), clearly marked.
    if (!gotUsage) {
      const chars = messages.current.reduce((n, m) => n + m.content.length, 0);
      const est = Math.round(chars / 4);
      setUsage({ ctx: est, prompt: est, completion: Math.round(full.length / 4), approx: true });
    }

    if (outcome === "stopped") info("Stopped.");
    else if (outcome === "error") error(errMsg);
    else if (!full.trim()) info("(no response text — the model may have hit its output limit mid-reasoning; try /effort medium or rephrase)");
  };

  // ---------- sessions ----------

  /** Save the conversation so /resume can pick it up later. Never throws. */
  const persist = () => {
    if (!sessionsEnabled() || !messages.current.some((m) => m.role === "assistant")) return;
    try {
      const s = session.current ?? newSession(process.cwd(), model);
      const first = !session.current;
      const plain = toPlainChat(messages.current);
      session.current = { ...s, model, skills: activeSkills, title: s.title || titleFrom(plain), updated: Date.now(), messages: plain };
      saveSession(session.current);
      if (first) pruneSessions();
    } catch {
      if (!persistWarned.current) error(`Couldn't save this chat to ${sessionsDir()}. /resume won't find it.`);
      persistWarned.current = true;
    }
  };
  const persistWarned = useRef(false);

  const replayItems = (msgs: ChatMessage[]): NewItem[] =>
    msgs.flatMap((m): NewItem[] =>
      m.role === "user" ? [{ kind: "user", text: m.content }] : m.role === "assistant" ? [{ kind: "assistant", text: m.content, first: true }] : [],
    );

  const resumeSession = (meta: SessionMeta) => {
    const s = loadSession(meta.id);
    if (!s || s.messages.length === 0) {
      error("That session couldn't be read. It may have been deleted.");
      return;
    }
    session.current = s;
    setUsage(null); // new context; counts start fresh on the next message
    const available = new Set(loadSkills().map((k) => k.name));
    setActiveSkills((s.skills ?? []).filter((n) => available.has(n)));
    messages.current = [...s.messages];
    const nextModel = s.model || model;
    if (s.model) setModel(s.model);
    setMode({ type: "chat" });
    stdout.write("\x1b[2J\x1b[3J\x1b[H");
    const header: Item = { id: id(), kind: "header", model: nextModel, loggedIn: !!auth.key, keySource: auth.source };
    const intro: Item = { id: id(), kind: "info", text: `Resumed "${s.title}" · ${s.messages.filter((m) => m.role === "user").length} messages · ${prettyPath(s.cwd)} · ${timeAgo(s.updated)}` };
    setItems([header, ...replayItems(s.messages).map((it) => ({ ...it, id: id() }) as Item), intro]);
    setStaticKey((k) => k + 1);
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
      info("No saved chats yet. Chats are saved automatically after each reply.");
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

  // ---------- skills & effort ----------

  /** Wait for a single y/N keystroke while a tool wants to run a command. */
  /** Wait for a single y/N keystroke while a tool wants to run a command.
   *  Arm-timestamped: input in the first 150ms after arming is ignored — the
   *  Enter that submitted the message (and Windows terminal key-release
   *  sequences) arrive exactly then and were auto-declining the prompt before
   *  the user could answer (2026-10-09 windows bug: every command "Skipped by
   *  user" instantly). */
  const askYesNo = (): Promise<boolean> => {
    return new Promise((resolve) => {
      toolArmedAt.current = Date.now();
      toolAnswerRef.current = (yes) => {
        toolAnswerRef.current = null;
        toolArmedAt.current = 0;
        setConfirmingCommand(null);
        resolve(yes);
      };
    });
  };
  const toolAnswerRef = useRef<((yes: boolean) => void) | null>(null);
  const toolArmedAt = useRef(0);
  /** what the agent is doing right now, for the live status line */
  const liveTool = useRef<{ name: string; detail: string; t0: number } | null>(null);
  /** a tool call the model is still writing (its arguments stream in) */
  const toolArgs = useRef<{ name: string; chars: number } | null>(null);
  /** last time the model sent anything — drives the "no data for Ns" warning */
  const lastDataAt = useRef(0);
  const [confirmingCommand, setConfirmingCommand] = useState<string | null>(null);

  const clipArgs = (s: string) => (s.length > 80 ? s.slice(0, 80) + "…" : s);

  function toolWorkKind(name: string): WorkKind {
    if (name === "write_file" || name === "edit_file") return "coding";
    if (name === "run_command") return "command";
    if (name === "read_file" || name === "list_dir" || name === "glob" || name === "grep") return "reading";
    if (name === "web_fetch" || name === "open_url") return "browsing";
    return "idle";
  }
  /** What the agent is doing right now — always shown while a reply is in
   *  progress, so a working agent never looks like a frozen terminal. */
  function activity(st: Stream): { key: string; kind: WorkKind; label?: string; detail?: string; waitingOnModel: boolean } | null {
    if (planAnswerRef.current) return null; // the plan selector is on screen
    if (confirmingCommand !== null) return { key: "approval", kind: "approval", waitingOnModel: false };
    const tool = liveTool.current;
    if (tool) return { key: `tool:${tool.t0}`, kind: toolWorkKind(tool.name), detail: tool.detail, waitingOnModel: false };
    const args = toolArgs.current;
    if (args) {
      const kind = toolWorkKind(args.name);
      return { key: `args:${args.name}`, kind: kind === "idle" ? "streaming" : kind, label: `Preparing ${args.name}`, detail: `${fmtTokens(args.chars)} chars`, waitingOnModel: true };
    }
    if (st.text.trim()) return { key: "streaming", kind: "streaming", waitingOnModel: true };
    if (st.reasoning && !st.started) return { key: "reasoning", kind: "reasoning", waitingOnModel: true };
    return { key: "idle", kind: "idle", label: st.started ? "Waiting for the model" : undefined, waitingOnModel: true };
  }
  function toolDetail(name: string, args: Record<string, unknown>): string {
    const a = String(args.path ?? args.command ?? args.url ?? args.pattern ?? "");
    return a ? a.split("/").pop()!.slice(0, 40) : name;
  }
  const clipResult = (s: string) => {
    const first = s.split("\n").slice(0, 4).join("\n");
    return first.length > 200 ? first.slice(0, 200) + "…" : first || "(no output)";
  };

  const toolsCommand = (arg: string) => {
    const next = arg.toLowerCase();
    if (next === "" || next === "on" || next === "read") {
      setToolsMode("read");
      writeConfig({ tools: "read" });
      success("Agent tools on — read files and clipboard, search, fetch pages.");
      info("Add /tools cmds to also write files and run commands (you confirm each), /tools yolo to skip asking, /tools off to disable.");
      return;
    }
    if (next === "cmds" || next === "commands") {
      setToolsMode("cmds");
      writeConfig({ tools: "cmds" });
      success("Agent tools on — full toolkit: read/write/edit, search, run commands (you confirm each one).");
      return;
    }
    if (next === "yolo") {
      setToolsMode("yolo");
      writeConfig({ tools: "yolo" });
      success("Agent tools on — full toolkit, changes and commands run WITHOUT confirmation.");
      return;
    }
    if (next === "off") {
      setToolsMode("off");
      writeConfig({ tools: "off" });
      success("Agent tools off — plain chat.");
      return;
    }
    error("Usage: /tools [off|cmds|yolo] — no argument turns on read-only tools.");
  };

  /** The system message for a request: the agent operating contract (only when
   *  tools are on) plus any active skills, read fresh from disk. Null if neither. */
  const systemContent = (toolsOn: boolean): string | null => {
    const parts: string[] = [];
    if (toolsOn && toolsMode !== "off") parts.push(agentSystemPrompt(toolsMode, autoMode, process.cwd()));
    const on = loadSkills().filter((k) => activeSkills.includes(k.name));
    const sk = skillsSystemPrompt(on);
    if (sk) parts.push(sk);
    return parts.length ? parts.join("\n\n") : null;
  };

  /** Prepend the system message (if any) to the chat. Plain chat (toolsOn
   *  false) only ever carries skills, and tool traffic is folded into text —
   *  a request without tools must not contain tool calls. */
  const withSystem = (msgs: AgentMessage[], toolsOn: boolean): AgentMessage[] => {
    const sys = systemContent(toolsOn);
    const body: AgentMessage[] = toolsOn ? msgs : toPlainChat(msgs);
    return sys ? [{ role: "system", content: sys }, ...body] : body;
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
    success(next === "auto" ? "Effort set to auto — the model decides how long to think." : `Effort set to ${next}.`);
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
      error("Unknown command. Type / to see commands.");
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
      case "fun":
        return funCommand(cmd.arg);
      case "api":
        return apiInfo();
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
      const chars = messages.current.reduce((n, m) => n + m.content.length, 0);
      push({ kind: "plain", text: [
        `${theme.dim("Context  ")} ~${fmtTokens(Math.round(chars / 4))} tokens ${theme.dim("(estimated — send a message to get real counts)")}`,
        `${theme.dim("Messages ")} ${count}`,
        `${theme.dim("Model    ")} ${model}`,
      ].join("\n") });
      return;
    }
    push({ kind: "plain", text: [
      `${theme.dim("Context  ")} ${usage.approx ? "~" : ""}${fmtTokens(usage.ctx)} tokens${usage.approx ? theme.dim(" (estimated)") : ""}`,
      `${theme.dim("Last turn")} ${fmtTokens(usage.prompt)} in · ${fmtTokens(usage.completion)} out`,
      `${theme.dim("Messages ")} ${count}`,
      `${theme.dim("Model    ")} ${model}`,
    ].join("\n") });
  };

  // ---------- /auto (bypass) & /plan ----------

  /** Plan mode: before mutating work, get a numbered plan and explicit yes/no. */
  const planFirst = async (history: AgentMessage[], ctrl: AbortController): Promise<boolean> => {
    info("Plan mode — drafting a plan before any changes…");
    let plan = "";
    try {
      await streamChatRetry(baseUrl, auth.key!, model, [
        ...toPlainChat(history),
        { role: "user", content: "Before doing anything: reply with ONLY a short numbered plan (max 8 steps, one line each) for exactly this task. No prose before or after. You will not execute anything yet." },
      ], {
        onToken: (t) => { plan += t; },
      }, ctrl.signal, { effort });
    } catch {
      info("Plan draft failed — no actions were taken. Retry or use /plan off.");
      return false;
    }
    const steps = planSteps(plan);
    if (!steps.length) { info("No valid plan received — no actions were taken. Retry or use /plan off."); return false; }
    push({ kind: "plain", text: `${theme.bold("Draft plan")}\n${steps.map((s) => "  " + theme.brand(s)).join("\n")}` });
    setMode({ type: "plan-approve", steps, selected: 0 });
    const approved = await askPlanApprove();
    setMode({ type: "chat" });
    if (approved) {
      success("Plan approved — executing.");
      // the agent works from the plan the user actually approved
      history.push(
        { role: "assistant", content: `Plan:\n${steps.join("\n")}` },
        { role: "user", content: "Plan approved. Carry it out now with your tools." },
      );
    } else info("Plan rejected. Tell me what to change, or rephrase the task.");
    return approved;
  };

  const planAnswerRef = useRef<((yes: boolean) => void) | null>(null);
  const askPlanApprove = (): Promise<boolean> => {
    return new Promise((resolve) => {
      toolArmedAt.current = Date.now();
      planAnswerRef.current = (yes) => {
        planAnswerRef.current = null;
        toolArmedAt.current = 0;
        resolve(yes);
      };
    });
  };

  const autoCommand = (from: string, arg: string) => {
    const off = arg.toLowerCase() === "off";
    if (off) {
      setAutoMode("ask");
      writeConfig({ autoMode: "ask" });
      success("Auto mode off — changes and commands ask for permission again (unless /tools yolo is selected).");
      return;
    }
    setAutoMode("auto");
    writeConfig({ autoMode: "auto" });
    const label = from === "bypass" ? "/bypass" : "/auto";
    success(`${label} on — the agent makes changes and runs commands without asking. /auto off to restore confirmations.`);
    if (toolsMode !== "cmds" && toolsMode !== "yolo") info("(No commands to auto-run yet — turn on /tools cmds first.)");
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

  const apiInfo = async () => {    push({ kind: "plain", text: apiLines(auth.key, auth.source, model) });
    if (!auth.key) {
      error(`Connection not checked. ${NOT_LOGGED_IN}`);
      return;
    }
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setBusy("Checking connection");
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
      abortRef.current = null;
      setBusy(null);
    }
  };

  const setAndSaveModel = (next: string) => {
    setModel(next);
    writeConfig({ model: next });
    success(`Model set to ${next}${messages.current.length ? " · conversation kept" : ""}`);
  };

  const chooseModel = async (arg: string) => {
    if (!auth.key) {
      error(NOT_LOGGED_IN);
      return;
    }
    if (!arg) setMode({ type: "picker", models: null, selected: 0 });
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    if (arg) setBusy("Checking model");
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
      abortRef.current = null;
      setBusy(null);
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

  const slashQuery = mode.type === "chat" && /^\/\S*$/.test(editor.value) ? editor.value.slice(1) : null;
  const slashMatches = slashQuery !== null ? filterCommands(slashQuery) : [];
  const menuOpen = slashQuery !== null && !stream && !busy;

  useEffect(() => setSlashSel(0), [slashQuery]);

  const submitChat = (value: string) => {
    const text = value.replace(/\s+$/, "");
    if (!text.trim()) return;
    setHistory((h) => (h[h.length - 1] === text ? h : [...h, text]));
    setHistIdx(null);
    setEditor(EMPTY);
    // Busy? Don't reject it — queue it and run it when the current reply finishes.
    if (stream || busy) {
      enqueue(text);
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
  // whitespace/control chars, and auto-submit. Never reaches the Prompt's
  // per-key path, so no shape can freeze or swallow it.
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

  // Global keys: Ctrl+C stops / cancels / exits, Ctrl+D exits.
  useInput((input, key) => {
    // pending run_command approval: ONLY explicit y/yes approves, ONLY
    // n/no/esc declines — anything else (stray newlines, key-release junk,
    // other keys) keeps waiting. Input in the first 150ms after arming is
    // dropped entirely (submit-Enter echo on windows terminals).
    if (toolAnswerRef.current) {
      const answer = approvalAnswer(input ?? "", key, Date.now() - toolArmedAt.current);
      if (answer !== undefined) toolAnswerRef.current(answer);
      if (key.ctrl && input === "c") abortRef.current?.abort();
      return; // any other key: still waiting
    }
    // plan approval: arrow-select Start/Cancel, Enter confirms, Esc = cancel
    if (mode.type === "plan-approve" && planAnswerRef.current) {
      if (Date.now() - toolArmedAt.current < 150) return;
      if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || (input ?? "").trim().toLowerCase() === "y" || (input ?? "").trim().toLowerCase() === "n") {
        setMode({ ...mode, selected: mode.selected === 0 ? 1 : 0 });
        return;
      }
      if (key.return && !key.shift) { planAnswerRef.current(mode.selected === 0); return; }
      if (key.tab) { setMode({ ...mode, selected: mode.selected === 0 ? 1 : 0 }); return; }
      if (key.escape) { planAnswerRef.current(false); return; }
      return;
    }
    if (key.escape && abortRef.current && (stream || busy)) {
      // Two-stage: first Esc arms, second Esc actually stops the running prompt
      // (and the queue drains the next one). Prevents a stray Esc from killing a
      // long reply by accident.
      if (escArmed.current) {
        escArmed.current = false;
        setFlash(null);
        abortRef.current.abort();
        return;
      }
      escArmed.current = true;
      const waiting = queueRef.current.length;
      showFlash(waiting ? `Press Esc again to skip to the next queued prompt (${waiting} waiting)` : "Press Esc again to stop");
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
    if (key.ctrl && input === "d" && !editor.value && !stream) quit();
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

  // Drain the queue: whenever nothing is streaming or working, start the next
  // queued prompt. `idle` only flips (not re-evaluates per token), so this fires
  // once per turn boundary, never mid-stream.
  const idle = !stream && !busy && mode.type === "chat";
  useEffect(() => {
    if (!idle || queueRef.current.length === 0) return;
    const next = queueRef.current.shift()!;
    setQueueLen(queueRef.current.length);
    if (next.startsWith("/")) void runCommand(next);
    else void sendChat(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idle]);

  // ---------- render ----------

  const width = size.columns;
  // You can keep typing while a reply streams; Enter queues it for when this one finishes.
  const promptActive = mode.type === "chat" && confirmingCommand === null && planAnswerRef.current === null;

  if (exiting) {
    return (
      <Static key={staticKey} items={items}>
        {(item) => <TranscriptItem key={item.id} item={item} width={width} />}
      </Static>
    );
  }

  return (
    <>
      <Static key={staticKey} items={items}>
        {(item) => <TranscriptItem key={item.id} item={item} width={width} />}
      </Static>

      {fx && <FinishFlourish streaming={!!stream} />}

      {stream && (
        <Box flexDirection="column" marginBottom={1}>
          {stream.text.trim() ? (
            <AssistantText text={stream.text} first={!stream.flushed} maxLines={Math.max(4, size.rows - 10)} width={width} />
          ) : null}
          {stream.reasoning && !stream.started && !liveTool.current && !toolArgs.current && (
            <Text>{theme.dim(`  thinking… ${stream.reasoningChars.toLocaleString()} chars · ${stream.reasoningTail.slice(-70).replace(/\s+/g, " ").trim()}`)}</Text>
          )}
          {(() => {
            // one status line, always present while the agent works
            const st = activity(stream);
            return st ? <Spinner key={st.key} kind={st.kind} label={st.label} detail={st.detail} quietSince={st.waitingOnModel ? lastDataAt.current : undefined} /> : null;
          })()}
        </Box>
      )}

      {busy && (
        <Box marginBottom={1}>
          <Spinner label={busy} />
        </Box>
      )}

      {mode.type === "picker" && (
        <Box flexDirection="column" marginBottom={1}>
          <Text>{theme.bold("Select a model")}{theme.dim("  ↑/↓ move · Enter select · Esc cancel")}</Text>
          {mode.models ? (
            <SelectList items={mode.models.map((m) => ({ key: m, label: m, hint: MODEL_SPEED_HINTS[m] ?? "", current: m === model }))} selected={mode.selected} max={10} />
          ) : (
            <Spinner label="Loading models" />
          )}
        </Box>
      )}

      {mode.type === "sessions" && (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
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
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            {theme.bold("Reasoning effort")}
            {theme.dim("  ↑/↓ move · Enter select · Esc cancel")}
          </Text>
          <SelectList
            items={EFFORTS.map((e) => ({ key: e, label: e, hint: EFFORT_HINTS[e], current: e === effort }))}
            selected={mode.selected}
          />
        </Box>
      )}

      {mode.type === "plan-approve" && (
        <Box flexDirection="column" marginBottom={1}>
          <Text>
            {theme.bold("Start this plan?")}
            {theme.dim("  ↑/↓ or y/n switch · Enter confirm · Esc cancel")}
          </Text>
          <SelectList
            items={[
              { key: "yes", label: `${mode.selected === 0 ? theme.ok("▶") : " "} ${theme.ok("Yes — start plan")}`, hint: `${mode.steps.length} steps`, mark: "" },
              { key: "no", label: `${mode.selected === 1 ? theme.warn("▶") : " "} ${theme.warn("No — cancel")}`, hint: "tell me what to change", mark: "" },
            ]}
            selected={mode.selected}
            max={2}
          />
        </Box>
      )}

      {mode.type === "skills" && (
        <Box flexDirection="column" marginBottom={1}>
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

      {mode.type !== "picker" && mode.type !== "sessions" && mode.type !== "effort" && mode.type !== "skills" && (
        <Box flexDirection="column">
          <Text>{theme.dim("─".repeat(Math.max(10, width - 1)))}</Text>
          <Prompt
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
            label={mode.type === "login" ? "Paste your API key: " : "› "}
            placeholder={mode.type === "login" ? "" : stream ? "Type to queue the next prompt · Esc Esc to skip" : 'Message Unjailed, or type "/" for commands'}
            isActive={promptActive}
          />
          <Text>{theme.dim("─".repeat(Math.max(10, width - 1)))}</Text>
        </Box>
      )}

      {menuOpen && (
        <Box flexDirection="column" marginLeft={1}>
          {slashMatches.length ? (
            <SelectList
              items={slashMatches.map((c) => ({ key: c.name, label: `/${c.name}${c.args ? " " + c.args : ""}`, hint: c.description }))}
              selected={slashSel}
              max={8}
            />
          ) : (
            <Text>{theme.dim("  No matching commands")}</Text>
          )}
        </Box>
      )}

      <StatusLine width={width} model={model} effort={effort} skills={activeSkills.length} toolsMode={toolsMode} autoMode={autoMode} planMode={planMode} loggedIn={!!auth.key} keyMasked={maskKey(auth.key)} flash={flash} streaming={!!stream} queued={queueLen} ctx={usage ? { tokens: usage.ctx, approx: usage.approx } : null} />
    </>
  );
}

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

/** Compact token count for the status line: 940, 1.2k, 12.4k, 128k. */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 100000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return Math.round(n / 1000) + "k";
}

function StatusLine({ width, model, effort, skills, toolsMode, autoMode, planMode, loggedIn, keyMasked, flash, streaming, queued, ctx }: { width: number; model: string; effort: Effort; skills: number; toolsMode: "off" | "read" | "cmds" | "yolo"; autoMode: "ask" | "auto"; planMode: "off" | "on"; loggedIn: boolean; keyMasked: string; flash: string | null; streaming: boolean; queued: number; ctx: { tokens: number; approx: boolean } | null }) {
  const extras = `${effort !== "auto" ? theme.dim(` · effort ${effort}`) : ""}${skills ? theme.dim(` · ${skills} skill${skills === 1 ? "" : "s"}`) : ""}${toolsMode !== "off" ? theme.dim(` · tools ${toolsMode}`) : ""}${autoMode === "auto" ? theme.warn(" · auto") : ""}${planMode === "on" ? theme.dim(" · plan") : ""}${queued ? theme.warn(` · ${queued} queued`) : ""}${ctx ? theme.dim(` · ${ctx.approx ? "~" : ""}ctx ${fmtTokens(ctx.tokens)}`) : ""}`;
  const left = `${theme.brand("◆")} ${model}${extras}  ${theme.dim("·")}  ${loggedIn ? theme.ok("● Logged in") + theme.dim(` ${keyMasked}`) : theme.warn("○ Not logged in") + theme.dim(" — type /login")}`;
  const right = flash ? theme.warn(flash) : width < 72 ? "" : theme.dim(streaming ? "Esc Esc to skip" : "/ for commands");
  return (
    <Box justifyContent="space-between" paddingX={1}>
      <Text wrap="truncate-end">{left}</Text>
      <Text wrap="truncate-start">{right}</Text>
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

function AssistantText({ text, first, maxLines, width }: { text: string; first: boolean; maxLines?: number; width?: number }) {
  let body = renderMarkdown(text, { width });
  let hidden = 0;
  // While streaming, the live area must stay shorter than the terminal or Ink redraws the whole
  // screen on every token. Older lines show in full once the paragraph or reply finishes.
  if (maxLines && width) ({ text: body, hidden } = tailToFit(body, maxLines, width));
  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text>{first ? theme.brand("●") : " "}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        {hidden > 0 && <Text>{theme.dim(`⋯ ${hidden} more line${hidden === 1 ? "" : "s"} above (shown in full when done)`)}</Text>}
        <Text>{body}</Text>
      </Box>
    </Box>
  );
}

function TranscriptItem({ item, width }: { item: Item; width: number }) {
  switch (item.kind) {
    case "header":
      return <Header model={item.model} loggedIn={item.loggedIn} keySource={item.keySource} width={width} />;
    case "user":
      return (
        <Box flexDirection="row" marginBottom={1}>
          <Box width={2} flexShrink={0}>
            <Text>{theme.dim("›")}</Text>
          </Box>
          <Text>{theme.dim(item.text)}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginBottom={1}>
          <AssistantText text={item.text} first={item.first} />
        </Box>
      );
    case "success":
      return (
        <Box marginBottom={1}>
          <Text>{theme.ok("✓ ") + item.text}</Text>
        </Box>
      );
    case "error":
      return (
        <Box marginBottom={1}>
          <Text>{theme.err("✗ ") + item.text}</Text>
        </Box>
      );
    case "info":
      return (
        <Box marginBottom={1}>
          <Text>{theme.dim("  " + item.text)}</Text>
        </Box>
      );
    case "plain":
      return (
        <Box marginBottom={1} paddingLeft={2}>
          <Text>{item.text}</Text>
        </Box>
      );
  }
}

function helpText(): string {
  const cmdW = Math.max(...COMMANDS.map((c) => `/${c.name}${c.args ? " " + c.args : ""}`.length)) + 3;
  const cmds = COMMANDS.map((c) => `${theme.brand(`/${c.name}${c.args ? " " + c.args : ""}`.padEnd(cmdW))}${c.description}`);
  const keys: [string, string][] = [
    ["Enter", "Send message"],
    ["Shift+Enter or \\ then Enter", "New line (Alt+Enter / Ctrl+J also work)"],
    ["↑ / ↓", "Previous / next input"],
    ["Space", "Toggle a skill in /skills"],
    ["Esc", "Close menus · while working, press twice to stop / skip to next queued"],
    ["Ctrl+C", "Stop the response · clear input · press twice to exit"],
    ["Ctrl+D", "Exit"],
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
