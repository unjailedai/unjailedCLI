import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, renderToString, Text, useApp, useInput, useStdout, type Key } from "ink";
import { AbortedError, ApiError, listModels, streamChatRetry, agentTurn, prepareRequestHistory, type AgentMessage, type ChatMessage } from "../api.js";
import { COMMANDS, filterCommands, parseCommand } from "../commands.js";
import { configPath, deleteKey, EFFORTS, maskKey, readConfig, resolveBaseUrl, resolveKey, writeConfig, type Effort, type KeySource } from "../config.js";
import { executeTool, toolDefinitions } from "../tools.js";
import { approvalAnswer } from "./approval.js";
import { runSelfUpdate } from "../updater.js";
import { recoverAuth, tryClearEnvKeyWindows } from "../auth-recovery.js";
import { createSkill, loadSkills, projectSkillsDir, skillsSystemPrompt, userSkillsDir, type Skill } from "../skills.js";
import { agentSystemPrompt } from "../system-prompt.js";
import { DEFAULT_MODEL } from "../constants.js";
import { renderMarkdown } from "../markdown.js";
import { theme } from "../theme.js";
import { Header } from "./Header.js";
import { FinishFlourish } from "./Snow.js";
import { fxEnabled } from "./fx.js";
import { onFirstLine, onLastLine, Prompt, type EditorState } from "./Prompt.js";
import { SelectList } from "./SelectList.js";
import { Spinner, type WorkKind } from "./Spinner.js";
import { useTerminalSize } from "./useTerminalSize.js";
import { StreamDisplayBuffer, retainDisplayWindow, streamingRowBudget } from "./stream-buffer.js";
import { ToolDraftBuffer, toolActivity, type ToolDraft as Draft } from "./tool-draft.js";
import { ToolDraft } from "./ToolDraft.js";
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
  type Session,
  type SessionMeta,
} from "../sessions.js";
import stringWidth from "string-width";
import { randomUUID } from "node:crypto";
import { HISTORY_TOOL, identifyHistory, protectWorkingContext, searchHistory, workingContext, type ToolEvent } from "../context.js";

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
  | { type: "tool-permissions"; selected: number }
  | { type: "plan-approve"; steps: string[]; selected: number }; // 0 = start, 1 = cancel

const TOOL_CHOICES = [
  { key: "read", label: "Read-only", hint: "inspect files; no changes or commands" },
  { key: "cmds", label: "Files + commands", hint: "ask before each change or command" },
  { key: "yolo", label: "Automatic", hint: "write files and run commands without asking" },
  { key: "off", label: "Off", hint: "plain chat; no computer tools" },
] as const;

interface Stream {
  hiddenCharacters: number;
  phase: "waiting" | "reasoning" | "writing" | "tool";
  draft?: Draft;
  request: number;
  step: number;
  lastStep: string;
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

export function App({ startup }: { startup?: "continue" | "resume" } = {}) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const size = useTerminalSize();

  const [auth, setAuth] = useState(() => resolveKey());
  const [baseUrl] = useState(() => resolveBaseUrl());
  const [model, setModel] = useState(() => process.env.UNJAILED_MODEL || readConfig().model || DEFAULT_MODEL);
  const [effort, setEffort] = useState<Effort>(() => readConfig().effort ?? "auto");
  // Agent tools: "off" | "read" (read_file+list_dir) | "cmds" (+run_command, confirmed) | "yolo" (+run_command, no confirm)
  const [toolsMode, setToolsMode] = useState<"off" | "read" | "cmds" | "yolo">(() => readConfig().tools ?? "off");
  /** Agent autonomy: ask (default) confirms commands · auto runs them · plan drafts first */
  const [autoMode, setAutoMode] = useState<"ask" | "auto">(() => {
    const config = readConfig();
    return (config.tools === "cmds" || config.tools === "yolo") && config.autoMode === "auto" ? "auto" : "ask";
  });
  /** Planning is a fresh, one-task request; never restore a legacy saved flag. */
  const [planMode, setPlanMode] = useState<"off" | "on">("off");
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

  const messages = useRef<ChatMessage[]>([]);
  const toolHistory = useRef<ToolEvent[]>([]);
  const notes = useRef<string[]>([]);
  const runningTurn = useRef(false);
  const quitRequested = useRef(false);
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
    setItems((prev) => retainDisplayWindow([...prev, ...newItems.map((it) => ({ ...it, id: id() }) as Item)]));
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

  // After a resize, wipe the screen and reprint the recent display window. Ink alone
  // can't erase lines that the terminal re-wrapped, which leaves broken frames behind.
  const firstSize = useRef(true);
  useEffect(() => {
    if (firstSize.current) {
      firstSize.current = false;
      return;
    }
    const t = setTimeout(() => {
      // Preserve terminal scrollback; only repaint the visible recent window.
      stdout.write("\x1b[2J\x1b[H");
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
    quitRequested.current = true;
    if (!runningTurn.current) setExiting(true);
  };

  // ---------- chat ----------

  const sendChat = async (text: string) => {
    runningTurn.current = true;
    try { await performChat(text); }
    finally {
      runningTurn.current = false;
      if (quitRequested.current) setExiting(true);
    }
  };
  const performChat = async (text: string) => {
    if (!auth.key) {
      push({ kind: "user", text });
      error(NOT_LOGGED_IN);
      return;
    }
    push({ kind: "user", text });
    messages.current.push({ role: "user", content: text });
    const toolEventsBefore = toolHistory.current.length;

    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let full = "";
    const displayBuffer = new StreamDisplayBuffer();
    let reasoningChars = 0;
    let reasoningTail = "";
    let flushedAny = false;
    let reasoning = false;
    let gotUsage = false;
    let requestContextChars = 0;
    let phase: Stream["phase"] = "waiting";
    let requestNumber = 0;
    let completedTools = 0;
    let lastStep = "";
    let firstTokenInResponse = true;
    const drafts = new Map<number, ToolDraftBuffer>();
    let draftIndex: number | undefined;
    let trimNotified = false;
    let timer: NodeJS.Timeout | undefined;

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
      const preview = displayBuffer.preview();
      setStream({ text: preview.text, hiddenCharacters: preview.hiddenCharacters, started: full.length > 0, reasoning, flushed: flushedAny, reasoningChars, reasoningTail, phase,
        draft: draftIndex === undefined ? undefined : drafts.get(draftIndex)?.snapshot(), request: requestNumber, step: completedTools + 1, lastStep });
    };
    const schedule = () => {
      if (!timer) timer = setTimeout(sync, 80);
    };
    const flushAssistant = () => {
      const pending = displayBuffer.finish().replace(/\n+$/, "");
      if (pending.trim()) {
        push({ kind: "assistant", text: pending, first: !flushedAny });
        flushedAny = true;
      }
      setStream(current => current ? { ...current, text: "", hiddenCharacters: 0, flushed: flushedAny } : current);
    };

    setStream({ text: "", hiddenCharacters: 0, started: false, reasoning: false, flushed: false, reasoningChars: 0, reasoningTail: "", phase, request: 0, step: 1, lastStep: "" });
    let outcome: "done" | "stopped" | "error" = "done";
    let errMsg = "";
    const useTools = toolsMode !== "off";
    const yolo = toolsMode === "yolo" || autoMode === "auto";

    try {
      const baseMessages = withSystem(messages.current, useTools);
      const streamHandlers = {
        onRetry: (message: string) => info(message),
        onRequest: (context: { characters: number; messages: number }) => {
          requestContextChars = context.characters;
          requestNumber++;
          firstTokenInResponse = true;
          drafts.clear();
          draftIndex = undefined;
          phase = "waiting";
          reasoning = false;
          schedule();
        },
        onContextTrim: () => {
          if (trimNotified) return;
          trimNotified = true;
          info("Older request context compacted with exact excerpts; full history stays available. Pin key instructions with /remember. Agent tools can recover older text with search_history.");
        },
        onToken: (t: string) => {
          if (firstTokenInResponse && t) {
            // Separate assistant responses from distinct agent rounds. Never
            // glue "checking..." and "now fixing..." into one saved monologue.
            if (full && !full.endsWith("\n\n")) {
              const separator = full.endsWith("\n") ? "\n" : "\n\n";
              full += separator; displayBuffer.append(separator);
            }
            firstTokenInResponse = false;
          }
          if (!drafts.size) phase = "writing";
          reasoning = false;
          full += t;
          displayBuffer.append(t);
          schedule();
        },
        onReasoning: (t: string) => {
          if (!drafts.size) phase = "reasoning";
          if (!reasoning) { reasoning = true; schedule(); }
          reasoningChars += t ? t.length : 0;
          if (t) reasoningTail = (reasoningTail + t).slice(-90);
          schedule();
        },
        onToolDelta: (delta: { index: number; name: string; argumentsDelta: string }) => {
          let draft = drafts.get(delta.index);
          if (!draft) { draft = new ToolDraftBuffer(delta.index); drafts.set(delta.index, draft); }
          draft.append(delta.name, delta.argumentsDelta);
          draftIndex = delta.index;
          phase = "tool";
          reasoning = false;
          schedule();
        },
        onUsage: (u: { prompt: number; completion: number; total: number }) => {
          gotUsage = true;
          // In agent mode onUsage fires each round; the latest request's prompt
          // count is the live context size (last round's completion for "out").
          setUsage({ ctx: u.prompt, prompt: u.prompt, completion: u.completion, approx: false });
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
        const msgs: ChatMessage[] = [...baseMessages];
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
        const defs = [...toolDefinitions(toolsMode), HISTORY_TOOL];
        const history: AgentMessage[] = [...baseMessages];

        // ── plan mode: mutating jobs get a numbered plan + explicit approval first ──
        if (planMode === "on" && (toolsMode === "cmds" || toolsMode === "yolo")) {
          setPlanMode("off"); // Consume once, including rejection or a failed draft.
          const approved = await planFirst(history, ctrl);
          if (!approved) {
            if (full.trim()) messages.current.push({ role: "assistant", content: full });
            setStream(null);
            abortRef.current = null;
            setBusy("Saving session");
            await persist();
            setBusy(null);
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
          onRecovery: (message) => { flushAssistant(); info(message); },
          onToolCall: (name, args) => {
            // A model may announce its step without a trailing blank line.
            // Print that actual prose before the matching action/result logs.
            flushAssistant();
            let argsObj: Record<string, unknown> = {};
            try { argsObj = JSON.parse(args || "{}"); } catch { /* raw */ }
            liveTool.current = { name, detail: toolDetail(name, argsObj), t0: Date.now() };
            drafts.clear();
            draftIndex = undefined;
            setStream(current => current ? { ...current, draft: undefined } : current);
            push({ kind: "info", text: `⚙ Step ${completedTools + 1} · ${toolActivity(name)}\n  ${name} ${clipArgs(args)}` });
            schedule();
          },
          onToolResult: (name, ok, output) => {
            lastStep = `${ok ? "Finished" : "Stopped"}: ${toolActivity(name).toLowerCase()}${liveTool.current?.detail ? ` · ${liveTool.current.detail}` : ""}`;
            completedTools++;
            liveTool.current = null;
            phase = "waiting";
            push({ kind: ok ? "info" : "error", text: ok ? `↳ ${clipResult(output)}` : `↳ failed: ${clipResult(output)}` });
            schedule();
          },
        }, ctrl.signal, {
          effort: autoEffortFor(text),
          tools: defs,
          execute: async (name, args) => {
            if (name === "search_history") return searchHistory(messages.current, toolHistory.current, args);
            const result = await executeTool(name, args, process.cwd(), async (command) => {
            push({ kind: "plain", text: `${theme.warn("Allow this action?")}\n  ${command}\n${theme.dim("  y = run · n or Esc = skip")}` });
            setConfirmingCommand(command);
            const answer = await askYesNo();
            if (!answer) info("Skipped by user.");
            return answer;
            }, { mode: toolsMode, autoApprove: yolo, signal: ctrl.signal });
            const event = { id: randomUUID(), name, args, ok: result.ok, output: result.output, at: Date.now() };
            toolHistory.current.push(event);
            return { ...result, historyEntry: `tool:${event.id}` };
          },
        });
        // keep transcript consistent when the final text already streamed
        if (finalText && !full.trim()) { full = finalText; }
        // Keep the original user/assistant transcript, not the shortened agent
        // scratch history. Dropping only tool results used to retain orphaned
        // tool_calls and duplicate intermediate prose in the next turn.
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
      liveTool.current = null;
      abortRef.current = null;
    }

    const rest = displayBuffer.finish().replace(/\n+$/, "");
    if (rest.trim()) push({ kind: "assistant", text: rest, first: !flushedAny });
    setStream(null);
    setBusy("Saving session");

    if (full.trim()) messages.current.push({ role: "assistant", content: full });
    else if (outcome !== "done" && toolHistory.current.length === toolEventsBefore) messages.current.pop();
    // A tool may have changed a file before the model disconnected. Retain
    // that task and its evidence even when no assistant prose arrived.
    await persist();

    // Server didn't report usage — show a rough estimate (chars/4), clearly marked.
    if (!gotUsage) {
      const est = Math.round(requestContextChars / 4);
      setUsage({ ctx: est, prompt: est, completion: Math.round(full.length / 4), approx: true });
    }

    if (outcome === "stopped") info("Stopped.");
    else if (outcome === "error") error(errMsg);
    else if (!full.trim()) info("(no response text — the model may have hit its output limit mid-reasoning; try /effort low or another model)");
    setBusy(null);
  };

  // ---------- sessions ----------

  /** Save the conversation so /resume can pick it up later. Never throws. */
  const persist = async () => {
    if (!sessionsEnabled() || (!messages.current.some((m) => m.role === "assistant") && !toolHistory.current.length && !notes.current.length)) return;
    try {
      const s = session.current ?? newSession(process.cwd(), model);
      const first = !session.current;
      session.current = { ...s, model, skills: activeSkills, title: s.title || titleFrom(messages.current), updated: Date.now(), messages: [...messages.current], toolHistory: [...toolHistory.current], notes: [...notes.current] };
      await appendSession(session.current);
      if (first) pruneSessions();
    } catch (err) {
      if (!persistWarned.current) error(`Couldn't save this chat to ${sessionsDir()}. ${err instanceof Error ? err.message : '/resume may not contain the latest turn.'}`);
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
    const nextModel = s.model || model;
    if (s.model) setModel(s.model);
    setMode({ type: "chat" });
    stdout.write("\x1b[2J\x1b[3J\x1b[H");
    const header: Item = { id: id(), kind: "header", model: nextModel, loggedIn: !!auth.key, keySource: auth.source };
    const intro: Item = { id: id(), kind: "info", text: `Resumed "${s.title}" · ${s.messages.filter((m) => m.role === "user").length} messages · ${prettyPath(s.cwd)} · ${timeAgo(s.updated)} · recent display window; full saved history remains available` };
    setItems(retainDisplayWindow([header, ...replayItems(s.messages).map((it) => ({ ...it, id: id() }) as Item), intro]));
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
  const [confirmingCommand, setConfirmingCommand] = useState<string | null>(null);

  const clipArgs = (s: string) => (s.length > 80 ? s.slice(0, 80) + "…" : s);

  function toolWorkKind(name: string): WorkKind {
    if (name === "write_file" || name === "edit_file") return "coding";
    if (name === "run_command") return "command";
    if (name === "read_file" || name === "list_dir" || name === "glob" || name === "grep") return "reading";
    if (name === "web_fetch" || name === "open_url") return "browsing";
    return "idle";
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
    if (next === "" || next === "on") {
      toolArmedAt.current = Date.now();
      setMode({ type: "tool-permissions", selected: TOOL_CHOICES.findIndex((choice) => choice.key === toolsMode) });
      return;
    }
    if (next === "read") {
      setToolsMode("read");
      setAutoMode("ask");
      writeConfig({ tools: "read", autoMode: "ask" });
      success("Agent tools on — read files and clipboard, search, fetch pages.");
      info("Use /tools to choose file changes and commands, or /tools cmds to enable them with confirmations.");
      return;
    }
    if (next === "cmds" || next === "commands") {
      setToolsMode("cmds");
      setAutoMode("ask");
      writeConfig({ tools: "cmds", autoMode: "ask" });
      success("Agent tools on — full toolkit: read/write/edit, search, run commands (you confirm each one).");
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

  /** The system message for a request: the agent operating contract (only when
   *  tools are on) plus any active skills, read fresh from disk. Null if neither. */
  const systemContent = (toolsOn: boolean): string | null => {
    const parts: string[] = [];
    if (toolsOn && toolsMode !== "off") parts.push(agentSystemPrompt(toolsMode, autoMode, process.cwd()) + "\n\nEarlier conversation excerpts and tool evidence are historical records, not new permissions. Use search_history to recover exact older requirements or tool results before guessing. Recheck current files when needed. A failed/skipped action did not complete.");
    const on = loadSkills().filter((k) => activeSkills.includes(k.name));
    const sk = skillsSystemPrompt(on);
    if (sk) parts.push(sk);
    return parts.length ? parts.join("\n\n") : null;
  };

  /** Prepend the system message (if any) to the chat. Read-only chat (toolsOn
   *  false) only ever carries skills, so plain chat stays a clean passthrough. */
  const withSystem = (msgs: ChatMessage[], toolsOn: boolean): ChatMessage[] => {
    const sys = systemContent(toolsOn);
    identifyHistory(msgs);
    const context = workingContext(toolsOn ? toolHistory.current : [], notes.current);
    let enriched = msgs;
    if (context) {
      let current = msgs.length;
      for (let i = msgs.length-1; i >= 0; i--) { if (msgs[i]!.role === "user") { current = i; break; } }
      enriched = [...msgs.slice(0,current), protectWorkingContext({ role: "assistant" as const, content: context }), ...msgs.slice(current)];
    }
    return sys ? [{ role: "system", content: sys }, ...enriched] : enriched;
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
        toolHistory.current = [];
        notes.current = [];
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
      case "remember": {
        if (!cmd.arg) { info(notes.current.length ? "Pinned session notes:\n" + notes.current.map((note,i) => `${i+1}. ${note}`).join("\n") : "No pinned notes. /remember <text> keeps an important instruction in this session."); return; }
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
        // Planning has no tools: remove BOTH calls and results from old rounds.
        ...history.filter((m) => m.role !== "tool").map(({ role, content }) => ({ role, content })),
        { role: "user", content: "Before doing anything: reply with ONLY a short numbered plan (max 8 steps, one line each) for exactly this task. No prose before or after. You will not execute anything yet." },
      ] as ChatMessage[], {
        onToken: (t) => { plan += t; },
      }, ctrl.signal, { effort });
    } catch {
      info("Plan draft failed — no actions were taken. Retry or use /plan off.");
      return false;
    }
    const trimmed = plan.trim();
    if (!trimmed || !/^\s*1[.)]/m.test(trimmed)) { info("No valid plan received — no actions were taken. Retry or use /plan off."); return false; }
    const steps = trimmed.split("\n").map((l) => l.trim()).filter((l) => /^\d+[.)]/.test(l)).slice(0, 8);
    push({ kind: "plain", text: `${theme.bold("Draft plan")}\n${steps.map((s) => "  " + theme.brand(s)).join("\n")}` });
    setMode({ type: "plan-approve", steps, selected: 0 });
    const approved = await askPlanApprove();
    setMode({ type: "chat" });
    if (approved) success("Plan approved — executing.");
    else info("Plan rejected. Tell me what to change, or rephrase the task.");
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
      if (toolsMode === "yolo") setToolsMode("cmds");
      writeConfig({ autoMode: "ask", ...(toolsMode === "yolo" ? { tools: "cmds" } : {}) });
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
    success("Planning enabled for the next task only — review the plan before execution.");
    info("Planning turns off after that task or a restart. File and command permissions still apply.");
  };

  // ---------- /update ----------

  const updateCommand = async () => {
    setBusy("Checking npm for updates");
    try {
      const result = await runSelfUpdate((line) => {
        setBusy("Updating via npm");
        if (line.trim()) info(line.trim().slice(0, 120));
      });
      if (result.status === "updated" || result.status === "unchanged") success(result.message);
      else error(result.message);
    } catch {
      error("Couldn't complete the update check. Restart the CLI to check your installed version; no fallback install was requested.");
    } finally { setBusy(null); }
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

  useInput((input, key) => {
    if (mode.type !== "tool-permissions") return;
    if (key.escape) { setMode({ type: "chat" }); return; }
    if (key.ctrl || key.meta) return;
    if (Date.now() - toolArmedAt.current < 150) return;
    if (key.upArrow) setMode({ ...mode, selected: (mode.selected - 1 + TOOL_CHOICES.length) % TOOL_CHOICES.length });
    else if (key.downArrow || key.tab) setMode({ ...mode, selected: (mode.selected + 1) % TOOL_CHOICES.length });
    else if (key.return && !key.shift) {
      const choice = TOOL_CHOICES[mode.selected];
      if (choice) {
        setMode({ type: "chat" });
        toolsCommand(choice.key);
      }
    }
  }, { isActive: mode.type === "tool-permissions" });

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
  const draftRows = Math.max(1, Math.min(6, size.rows - 18));
  const showDraft = !!stream?.draft && (!!stream.draft.preview || /^(write_file|edit_file|run_command)$/.test(stream.draft.name));
  // You can keep typing while a reply streams; Enter queues it for when this one finishes.
  const promptActive = mode.type === "chat" && confirmingCommand === null && planAnswerRef.current === null;

  if (exiting) {
    return (
      <Transcript key={staticKey} items={items} width={width} />
    );
  }

  return (
    <>
      <Transcript key={staticKey} items={items} width={width} />

      {fx && <FinishFlourish streaming={!!stream} />}

      {stream && (
        <Box flexDirection="column" marginBottom={1}>
          {stream.text.trim() ? (
            <AssistantText text={stream.text} first={!stream.flushed} maxLines={streamingRowBudget(size.rows - (showDraft ? draftRows + 4 : 0), width, editor.value, stream.phase === "reasoning", mode.type === "plan-approve")} width={width} hiddenCharacters={stream.hiddenCharacters} />
          ) : null}
          {showDraft && stream.draft && !liveTool.current && <ToolDraft draft={stream.draft} rows={draftRows} />}
          {!liveTool.current && <Spinner key={`${stream.request}:${stream.phase}`} kind={stream.phase === "writing" ? "streaming" : stream.phase === "reasoning" ? "reasoning" : stream.phase === "tool" ? "coding" : "idle"} label={confirmingCommand ? "Waiting for permission" : mode.type === "plan-approve" ? "Waiting for plan approval" : stream.phase === "waiting" ? `Step ${stream.step} · Waiting for model` : stream.phase === "tool" ? `Step ${stream.step} · Receiving ${stream.draft?.name === "run_command" ? "command" : "tool draft"}` : undefined} detail={stream.draft?.label} />}
          {stream.phase === "waiting" && !liveTool.current && <Text dimColor wrap="truncate-end">{stream.lastStep ? `${stream.lastStep} · ` : ""}No new model output yet.</Text>}
          {stream.phase === "reasoning" && !liveTool.current && (
            <Text wrap="truncate-end">{theme.dim(`  thinking… ${stream.reasoningChars.toLocaleString()} chars · ${stream.reasoningTail.slice(-70).replace(/\s+/g, " ").trim()}`)}</Text>
          )}
          {liveTool.current && (
            <Spinner key={`execute:${liveTool.current.t0}`} kind={toolWorkKind(liveTool.current.name)} label={confirmingCommand ? "Waiting for permission" : toolActivity(liveTool.current.name)} detail={liveTool.current.detail} />
          )}
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

      {mode.type === "tool-permissions" && (
        <Box flexDirection="column" marginBottom={1}>
          <Text>{theme.bold("Choose tool permissions")}{theme.dim("  ↑/↓ move · Enter select · Esc cancel")}</Text>
          <Text>{theme.dim("File changes and commands run on your PC. Select the access you authorize.")}</Text>
          <SelectList items={TOOL_CHOICES.map((choice) => ({ ...choice, current: choice.key === toolsMode }))} selected={mode.selected} max={4} />
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

      {mode.type !== "picker" && mode.type !== "sessions" && mode.type !== "effort" && mode.type !== "skills" && mode.type !== "tool-permissions" && (
        <Box flexDirection="column">
          <Text>{theme.dim("─".repeat(Math.max(10, width - 1)))}</Text>
          <Prompt
            width={width}
            maxRows={Math.max(1, Math.min(4, Math.floor(size.rows / 4)))}
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

const AssistantText = memo(function AssistantText({ text, first, maxLines, width, hiddenCharacters = 0 }: { text: string; first: boolean; maxLines?: number; width?: number; hiddenCharacters?: number }) {
  let body = renderMarkdown(text, { width, highlightCode: !maxLines });
  let hidden = 0;
  // While streaming, the live area must stay shorter than the terminal or Ink redraws the whole
  // screen on every token. Older lines show in full once the paragraph or reply finishes.
  if (maxLines && width) {
    ({ text: body, hidden } = tailToFit(body, maxLines, width));
    if (hidden || hiddenCharacters) ({ text: body, hidden } = tailToFit(body || "", Math.max(0, maxLines - 1), width));
  }
  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text>{first ? theme.brand("●") : " "}</Text>
      </Box>
      <Box flexGrow={1} flexDirection="column">
        {(hidden > 0 || hiddenCharacters > 0) && <Text wrap="truncate-end">{theme.dim("⋯ earlier text appears in full when this block finishes")}</Text>}
        {body ? <Text>{body}</Text> : null}
      </Box>
    </Box>
  );
});

// Static output is already in terminal scrollback. Typing and streaming must
// not revisit every old message or re-render its markdown on each live update.
export const Transcript = memo(function Transcript({ items, width }: { items: Item[]; width: number }) {
  const { write, stdout } = useStdout();
  const printedThrough = useRef(0);
  const queued = useRef<Item[]>([]);
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
      const output = renderToString(<Box flexDirection="column">{batch.map((item) => <TranscriptItem key={item.id} item={item} width={columns.current} />)}</Box>, { columns: columns.current });
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
      const text = remaining.map((item) => item.kind === "header" ? "Unjailed AI" : item.text).join("\n\n");
      stdout.write(text + "\n");
    }
  }, []);
  return null;
});

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
