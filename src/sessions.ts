import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import type { ChatMessage } from "./api.js";
import type { ToolEvent } from "./context.js";
import { configDir, readConfig } from "./config.js";

/** One saved conversation. Stored as ~/.unjailed/sessions/<id>.json (mode 600). */
export interface Session {
  id: string;
  title: string;
  cwd: string; // folder the session was started in, used to group sessions by project
  model: string;
  created: number;
  updated: number;
  messages: ChatMessage[];
  notes?: string[];
  toolHistory?: ToolEvent[];
  revision?: string;
  skills?: string[]; // skills that were switched on, restored by /resume
  /** A turn that was still running at the last save (the CLI was closed or
   *  killed mid-run): its partial reply, restored by /resume. */
  pending?: PendingTurn;
  /** An active /goal, restored (paused) by /resume. */
  goal?: { condition: string; turns: number; maxTurns: number; startedAt: number; lastReason?: string };
  /** An active /loop, restored (paused) by /resume. */
  loop?: { prompt: string; intervalMs: number | null; iteration: number };
  /** Recent prompts typed in this chat, for ↑ history after a restart. */
  inputs?: string[];
  /** Running totals shown by /stats and the verbose stats panel. */
  stats?: Record<string, number>;
}

export interface PendingTurn {
  startedAt: number;
  /** Assistant text streamed so far (bounded). */
  partial: string;
}

/** Cap on the partial reply kept for an interrupted turn. */
export const MAX_PENDING_CHARS = 60_000;
export const MAX_SAVED_INPUTS = 200;

export type SessionMeta = Omit<Session, "messages" | "toolHistory"> & { count: number };

const MAX_SESSIONS = 200;

export function sessionsDir(): string {
  return path.join(configDir(), "sessions");
}

/** Saving is on unless UNJAILED_NO_HISTORY is set or config.json has "saveSessions": false. */
export function sessionsEnabled(): boolean {
  const env = process.env.UNJAILED_NO_HISTORY;
  if (env && env !== "0" && env !== "false") return false;
  return readConfig().saveSessions !== false;
}

export function newSession(cwd: string, model: string): Session {
  const now = Date.now();
  const stamp = new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return { id: `${stamp}-${crypto.randomBytes(3).toString("hex")}`, title: "", cwd, model, created: now, updated: now, messages: [] };
}

export function titleFrom(messages: ChatMessage[]): string {
  const first = messages.find((m) => m.role === "user")?.content ?? "";
  const oneLine = first.replace(/\s+/g, " ").trim();
  return oneLine.length > 60 ? oneLine.slice(0, 59) + "…" : oneLine || "(untitled)";
}

function fileFor(id: string): string {
  if (!/^[\w-]+$/.test(id)) throw new Error("bad session id");
  return path.join(sessionsDir(), `${id}.json`);
}

function parse(raw: string): Session | null {
  try {
    const s = JSON.parse(raw);
    if (!s || typeof s.id !== "string" || !Array.isArray(s.messages)) return null;
    return {
      id: s.id,
      title: typeof s.title === "string" ? s.title : "",
      cwd: typeof s.cwd === "string" ? s.cwd : "",
      model: typeof s.model === "string" ? s.model : "",
      created: Number(s.created) || 0,
      updated: Number(s.updated) || 0,
      revision: typeof s.revision === "string" ? s.revision : undefined,
      notes: Array.isArray(s.notes) ? s.notes.filter((x: unknown): x is string => typeof x === "string").slice(-20) : [],
      toolHistory: Array.isArray(s.toolHistory) ? s.toolHistory.filter(validToolEvent) : [],
      skills: Array.isArray(s.skills) ? s.skills.filter((x: unknown): x is string => typeof x === "string") : [],
      pending: s.pending && typeof s.pending === "object" && typeof s.pending.partial === "string" && Number.isFinite(s.pending.startedAt) ? { startedAt: s.pending.startedAt, partial: s.pending.partial.slice(-MAX_PENDING_CHARS) } : undefined,
      goal: s.goal && typeof s.goal.condition === "string" && Number.isFinite(s.goal.turns) && Number.isFinite(s.goal.maxTurns) ? { condition: s.goal.condition, turns: s.goal.turns, maxTurns: s.goal.maxTurns, startedAt: Number(s.goal.startedAt) || 0, lastReason: typeof s.goal.lastReason === "string" ? s.goal.lastReason : undefined } : undefined,
      loop: s.loop && typeof s.loop.prompt === "string" && (s.loop.intervalMs === null || Number.isFinite(s.loop.intervalMs)) ? { prompt: s.loop.prompt, intervalMs: s.loop.intervalMs, iteration: Number(s.loop.iteration) || 0 } : undefined,
      inputs: Array.isArray(s.inputs) ? s.inputs.filter((x: unknown): x is string => typeof x === "string").slice(-MAX_SAVED_INPUTS) : undefined,
      stats: s.stats && typeof s.stats === "object" && !Array.isArray(s.stats) ? Object.fromEntries(Object.entries(s.stats).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1]))) : undefined,
      messages: s.messages.filter(
        (m: unknown): m is ChatMessage =>
          !!m && typeof (m as ChatMessage).content === "string" && ["user", "assistant", "system"].includes((m as ChatMessage).role),
      ),
    };
  } catch {
    return null;
  }
}

/** Write atomically (temp file + rename) so a crash never leaves a half-written session. */
export function saveSession(session: Session): void {
  const dir = sessionsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = fileFor(session.id);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(session) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, file);
  if (process.platform !== "win32") {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* best effort */
    }
  }
}

export function loadSession(id: string): Session | null {
  try {
    const raw = fs.readFileSync(fileFor(id), "utf8");
    const meta = JSON.parse(raw);
    if (meta.format !== 2) return parse(raw);
    const replay = replayJournal(fs.readFileSync(journalFor(id), "utf8"));
    return parse(JSON.stringify({ ...meta, messages: replay.messages, toolHistory: replay.tools }));
  } catch {
    return null;
  }
}

export function deleteSession(id: string): void {
  try {
    fs.rmSync(fileFor(id));
    fs.rmSync(journalFor(id), { force: true });
    cursors.delete(fileFor(id));
  } catch {
    /* already gone */
  }
}

/** All saved sessions, most recently updated first. */
export function listSessions(): SessionMeta[] {
  let names: string[];
  try {
    names = fs.readdirSync(sessionsDir()).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const out: SessionMeta[] = [];
  for (const name of names) {
    let s: Session | null = null;
    try {
      const raw = fs.readFileSync(path.join(sessionsDir(), name), "utf8");
      const meta = JSON.parse(raw);
      if (meta.format === 2 && typeof meta.id === "string" && /^[\w-]+$/.test(meta.id) && (meta.messageCount > 0 || (Array.isArray(meta.notes) && meta.notes.length > 0))) {
        const parsed = parse(JSON.stringify({ ...meta, messages: [] }));
        if (parsed) {
          const { messages, toolHistory, ...details } = parsed;
          out.push({ ...details, count: Number(meta.count) || 0 });
        }
        continue;
      }
      s = parse(raw);
    } catch {
      /* unreadable; skip */
    }
    if (!s || (!s.messages.length && !s.notes?.length)) continue;
    const { messages, toolHistory, ...meta } = s;
    out.push({ ...meta, count: messages.filter((m) => m.role === "user").length });
  }
  return out.sort((a, b) => b.updated - a.updated);
}

/** Keep the newest MAX_SESSIONS; delete the rest. */
export function pruneSessions(): void {
  for (const s of listSessions().slice(MAX_SESSIONS)) deleteSession(s.id);
}

/** Find a session by exact id, id prefix, or 1-based position in `list`. */
export function findSession(query: string, list: SessionMeta[]): SessionMeta | undefined {
  const q = query.trim();
  if (/^\d{1,3}$/.test(q)) return list[Number(q) - 1];
  return list.find((s) => s.id === q) ?? list.find((s) => s.id.startsWith(q));
}

export function timeAgo(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toISOString().slice(0, 10);
}

/** ~/projects/foo instead of /home/me/projects/foo. */
export function prettyPath(p: string, home = process.env.HOME || process.env.USERPROFILE || ""): string {
  if (home && (p === home || p.startsWith(home + path.sep))) return "~" + p.slice(home.length);
  return p;
}

function validToolEvent(value: unknown): value is ToolEvent {
  if (!value || typeof value !== "object") return false;
  const e = value as ToolEvent;
  return typeof e.id === "string" && typeof e.name === "string" && typeof e.output === "string" && typeof e.ok === "boolean" && !!e.args && typeof e.args === "object" && !Array.isArray(e.args) && Number.isFinite(e.at);
}
function journalFor(id: string): string { return fileFor(id).replace(/\.json$/, ".jsonl"); }
interface JournalBatch { start: number; messages: ChatMessage[]; toolStart: number; tools: ToolEvent[] }
function replayJournal(raw: string): { messages: ChatMessage[]; tools: ToolEvent[]; bytes: number } {
  const end = raw.lastIndexOf("\n") + 1;
  const messages: ChatMessage[] = [], tools: ToolEvent[] = [];
  // A crash can interrupt only the last append. Never accept corrupt complete
  // records or gaps: silently losing an earlier instruction is worse than a
  // clearly reported unreadable session.
  for (const line of raw.slice(0, end).split("\n")) {
    if (!line) continue;
    const batch = JSON.parse(line) as JournalBatch;
    if (batch.start !== messages.length || batch.toolStart !== tools.length || !Array.isArray(batch.messages) || !Array.isArray(batch.tools)) throw new Error("Invalid session journal sequence");
    if (!batch.messages.every(m => m && ["user", "assistant", "system"].includes(m.role) && typeof m.content === "string") || !batch.tools.every(validToolEvent)) throw new Error("Invalid session journal entry");
    messages.push(...batch.messages); tools.push(...batch.tools);
  }
  return { messages, tools, bytes: Buffer.byteLength(raw.slice(0, end)) };
}
interface Cursor { messages: number; tools: number; users: number; last: string; lastTool: string }
const cursors = new Map<string, Cursor>();
const writes = new Map<string, Promise<void>>();

/** Append only the newly completed turn, asynchronously. The small .json file
 * is an atomic manifest; the private .jsonl journal retains exact messages and
 * tool results. Existing .json chats migrate once, without losing their text. */
export function appendSession(session: Session): Promise<void> {
  const file = fileFor(session.id);
  const snapshot = { ...session, messages: [...session.messages], toolHistory: [...(session.toolHistory ?? [])], notes: [...(session.notes ?? [])] };
  const previous = writes.get(file) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    // Queued snapshots from the same live object inherit the last successful
    // revision after the prior save settles. Independently loaded/cloned
    // sessions keep their own revision and cannot replace another writer's notes.
    snapshot.revision = session.revision;
    session.revision = await appendLocked(snapshot);
  });
  writes.set(file, pending);
  void pending.finally(() => { if (writes.get(file) === pending) writes.delete(file); }).catch(() => {});
  return pending;
}
async function appendLocked(session: Session): Promise<string> {
  const file = fileFor(session.id), journal = journalFor(session.id), lockPath = file + ".lock";
  const io = fs.promises;
  await io.mkdir(sessionsDir(), { recursive: true, mode: 0o700 });
  // Publish a fully written owner record atomically. open('wx') followed by a
  // separate PID write could leave an ownerless lock if the process crashed.
  const candidate = lockPath + "." + process.pid + "." + crypto.randomUUID();
  const recoveryPath = lockPath + ".recovering";
  let acquired = false;
  let recovering = false;
  const tmp = file + "." + process.pid + ".tmp";
  try {
    await io.writeFile(candidate, String(process.pid), { flag: "wx", mode: 0o600 });
    try { await io.link(candidate, lockPath); acquired = true; }
    catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw new Error("Could not acquire the atomic session lock on this filesystem; history was not overwritten.", { cause: err });
      // Serialize dead-owner recovery. Two stale readers must not unlink a
      // fresh lock acquired by the other terminal between owner check/unlink.
      try { await io.link(candidate, recoveryPath); recovering = true; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("Session lock recovery is already in progress. Retry after the other CLI finishes; if recovery was interrupted, close all CLI windows before removing " + recoveryPath);
        throw error;
      }
      let alive = true;
      const ownerText = await io.readFile(lockPath, "utf8");
      const owner = Number(ownerText);
      if (!Number.isInteger(owner) || owner <= 0) throw new Error("The session lock has no valid owner. Close other CLI windows before manually removing " + lockPath);
      try { process.kill(owner, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false; }
      if (alive) throw new Error("This session is being saved by another CLI. Use a new chat in this terminal.");
      await io.rm(lockPath, { force: true });
      await io.link(candidate, lockPath);
      acquired = true;
    }
    let meta: Record<string, unknown> | undefined;
    try { meta = JSON.parse(await io.readFile(file, "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (meta?.format === 2 && meta.revision !== session.revision) throw new Error("Session revision changed in another terminal; refusing to overwrite its history or pinned notes.");
    let cursor = cursors.get(file);
    if (cursor && meta && (meta.format !== 2 || meta.messageCount !== cursor.messages || meta.toolCount !== cursor.tools)) cursor = undefined;
    if (!cursor) {
      let oldMessages: ChatMessage[] = [], oldTools: ToolEvent[] = [];
      if (meta?.format === 2) {
        const raw = await io.readFile(journal, "utf8");
        const replay = replayJournal(raw);
        oldMessages = replay.messages; oldTools = replay.tools;
        if (replay.bytes !== Buffer.byteLength(raw)) await io.truncate(journal, replay.bytes);
      } else {
        if (meta) {
          const legacy = parse(JSON.stringify(meta));
          if (!legacy) throw new Error("Existing session cannot be read; refusing to overwrite it.");
          oldMessages = legacy.messages; oldTools = legacy.toolHistory ?? [];
        }
        // Write a complete migration journal first. The original manifest stays
        // readable until the atomic manifest switch, even if this write fails.
        await io.writeFile(journal + ".tmp", JSON.stringify({ start: 0, messages: oldMessages, toolStart: 0, tools: oldTools }) + "\n", { mode: 0o600 });
        await io.rename(journal + ".tmp", journal);
      }
      if (oldMessages.length > session.messages.length || oldTools.length > (session.toolHistory?.length ?? 0) || oldMessages.some((m,i) => JSON.stringify(m) !== JSON.stringify(session.messages[i])) || oldTools.some((e,i) => JSON.stringify(e) !== JSON.stringify(session.toolHistory?.[i]))) throw new Error("Session changed in another terminal; refusing to overwrite its history.");
      cursor = { messages: oldMessages.length, tools: oldTools.length, users: oldMessages.filter(m => m.role === "user").length, last: oldMessages.length ? JSON.stringify(oldMessages.at(-1)) : "", lastTool: oldTools.length ? JSON.stringify(oldTools.at(-1)) : "" };
    }
    if (session.messages.length < cursor.messages || (session.toolHistory?.length ?? 0) < cursor.tools || (cursor.messages && JSON.stringify(session.messages[cursor.messages-1]) !== cursor.last) || (cursor.tools && JSON.stringify(session.toolHistory?.[cursor.tools-1]) !== cursor.lastTool)) throw new Error("Saved history changed; start a new chat rather than overwriting it.");
    const fresh = session.messages.slice(cursor.messages), freshTools = (session.toolHistory ?? []).slice(cursor.tools);
    if (fresh.length || freshTools.length) {
      await io.appendFile(journal, JSON.stringify({ start: cursor.messages, messages: fresh, toolStart: cursor.tools, tools: freshTools }) + "\n", { mode: 0o600 });
    }
    const { messages, toolHistory, ...details } = session;
    const revision = crypto.randomUUID();
    const users = cursor.users + fresh.filter(m => m.role === "user").length;
    await io.writeFile(tmp, JSON.stringify({ ...details, revision, format: 2, messageCount: messages.length, toolCount: toolHistory?.length ?? 0, count: users }) + "\n", { mode: 0o600 });
    await io.rename(tmp, file);
    cursors.set(file, { messages: messages.length, tools: toolHistory?.length ?? 0, users, last: messages.length ? JSON.stringify(messages.at(-1)) : "", lastTool: toolHistory?.length ? JSON.stringify(toolHistory.at(-1)) : "" });
    return revision;
  } catch (error) { cursors.delete(file); throw error; }
  finally {
    if (acquired) await io.rm(lockPath, { force: true });
    if (recovering) await io.rm(recoveryPath, { force: true });
    await io.rm(candidate, { force: true });
    await io.rm(tmp, { force: true });
  }
}
