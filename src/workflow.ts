import fs from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { configDir } from "./config.js";

/**
 * Workflows: a small JavaScript script that orchestrates subagents.
 *
 *   export const meta = { name: "review", description: "Review then verify", phases: [{ title: "Review" }] };
 *   const areas = ["bugs", "tests"];
 *   const found = await parallel(areas.map((a) => () => agent(`Review for ${a}`, { label: a, phase: "Review" })));
 *   return found;
 *
 * Globals: agent(prompt, {label, phase, schema}), parallel(thunks),
 * pipeline(items, ...stages), phase(title), log(message), console, args.
 * At most 16 agents per run, 4 at a time.
 *
 * The script runs in a worker thread, inside a fresh V8 context, so a typo can't
 * clobber the CLI's globals and a runaway script can be terminated. That is not a
 * security boundary: a script can do anything a command could, so running one
 * needs the same permission as run_command.
 */
export interface WorkflowMeta {
  name: string;
  description?: string;
  phases?: { title: string; detail?: string }[];
}

export interface AgentRequest {
  prompt: string;
  label: string;
  phase?: string;
  /** JSON Schema the agent's final reply must satisfy. */
  schema?: unknown;
}

export interface WorkflowEvents {
  onPhase?: (title: string) => void;
  onAgentStart?: (id: number, req: AgentRequest) => void;
  onAgentEnd?: (id: number, ok: boolean, summary: string) => void;
  onLog?: (message: string) => void;
}

export interface WorkflowOptions {
  script: string;
  args?: unknown;
  signal: AbortSignal;
  /** Runs one subagent to completion and returns its final reply. */
  runAgent: (id: number, req: AgentRequest, signal: AbortSignal) => Promise<string>;
  events?: WorkflowEvents;
  maxAgents?: number;
  concurrency?: number;
}

export interface WorkflowResult {
  meta: WorkflowMeta;
  result: unknown;
  agents: number;
  failed: number;
  durationMs: number;
  logs: string[];
}

export const WORKFLOW_MAX_AGENTS = 16;
export const WORKFLOW_CONCURRENCY = 4;

export class WorkflowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowError";
  }
}

export const META_RE = /export\s+const\s+meta\s*=/;

/**
 * Parse a JavaScript literal (object, array, string, number, boolean, null)
 * starting at `i`, WITHOUT evaluating any code. Unquoted keys, single/double/
 * backtick strings (no ${…}), trailing commas and comments are accepted;
 * anything else (identifiers, calls, expressions) is rejected.
 */
function parseLiteral(src: string, start: number): { value: unknown; end: number } | null {
  let i = start;
  const ws = () => {
    for (;;) {
      while (i < src.length && /\s/.test(src[i]!)) i++;
      if (src.startsWith("//", i)) { while (i < src.length && src[i] !== "\n") i++; continue; }
      if (src.startsWith("/*", i)) { const e = src.indexOf("*/", i + 2); if (e < 0) return; i = e + 2; continue; }
      return;
    }
  };
  const fail = () => { throw new Error("not a literal"); };
  const str = (): string => {
    const q = src[i++]!;
    let out = "";
    while (i < src.length && src[i] !== q) {
      let ch = src[i++]!;
      if (q === "`" && ch === "$" && src[i] === "{") fail();
      if (ch === "\\") {
        const e = src[i++]!;
        ch = e === "n" ? "\n" : e === "t" ? "\t" : e === "r" ? "\r" : e === "u" ? String.fromCharCode(parseInt(src.slice(i, (i += 4)), 16)) : e;
      }
      out += ch;
    }
    if (src[i++] !== q) fail();
    return out;
  };
  const value = (depth: number): unknown => {
    if (depth > 20) fail();
    ws();
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") return str();
    if (ch === "{") {
      i++;
      const obj: Record<string, unknown> = {};
      for (;;) {
        ws();
        if (src[i] === "}") { i++; return obj; }
        let key: string;
        if (src[i] === '"' || src[i] === "'") key = str();
        else {
          const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
          if (!m) fail();
          key = m![0];
          i += key.length;
        }
        ws();
        if (src[i++] !== ":") fail();
        if (key !== "__proto__" && key !== "constructor" && key !== "prototype") obj[key] = value(depth + 1);
        else value(depth + 1);
        ws();
        if (src[i] === ",") { i++; continue; }
        if (src[i] === "}") { i++; return obj; }
        fail();
      }
    }
    if (ch === "[") {
      i++;
      const arr: unknown[] = [];
      for (;;) {
        ws();
        if (src[i] === "]") { i++; return arr; }
        arr.push(value(depth + 1));
        ws();
        if (src[i] === ",") { i++; continue; }
        if (src[i] === "]") { i++; return arr; }
        fail();
      }
    }
    const lit = /^(?:-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|null)/i.exec(src.slice(i));
    if (!lit) fail();
    i += lit![0].length;
    return JSON.parse(lit![0].toLowerCase());
  };
  try {
    const v = value(0);
    return { value: v, end: i };
  } catch {
    return null;
  }
}

/** Read the meta block without running any of the script (for listings and
 *  approval prompts, which happen before the user has agreed to run it). */
export function readMeta(script: string): WorkflowMeta | null {
  const m = META_RE.exec(script);
  if (!m) return null;
  const parsed = parseLiteral(script, m.index + m[0].length);
  const v = parsed?.value as { name?: unknown; description?: unknown; phases?: unknown } | undefined;
  if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.name !== "string") return null;
  const meta: WorkflowMeta = { name: v.name };
  if (typeof v.description === "string") meta.description = v.description;
  if (Array.isArray(v.phases)) meta.phases = v.phases.filter((p): p is { title: string } => !!p && typeof (p as { title?: unknown }).title === "string");
  return meta;
}

/** Find the outermost JSON object/array in a reply (tolerates fences and prose). */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fenced?.[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const trimmed = c.trim();
    try {
      return JSON.parse(trimmed);
    } catch {
      /* look for an embedded object */
    }
    for (const open of ["{", "["]) {
      const s = trimmed.indexOf(open);
      const e = trimmed.lastIndexOf(open === "{" ? "}" : "]");
      if (s >= 0 && e > s) {
        try {
          return JSON.parse(trimmed.slice(s, e + 1));
        } catch {
          /* next */
        }
      }
    }
  }
  return undefined;
}

/** Messages between the CLI and the workflow worker (src/workflow-worker.ts). */
export type WorkerMessage =
  | { type: "agent"; id: number; req: AgentRequest }
  | { type: "agent-end"; id: number; ok: boolean; summary: string; failed: boolean }
  | { type: "phase"; title: string }
  | { type: "log"; line: string }
  | { type: "done"; result: unknown; meta: WorkflowMeta | null; agents: number; failed: number; logs: string[] }
  | { type: "error"; message: string };

export type MainMessage = { type: "agent-result"; id: number; ok: true; text: string } | { type: "agent-result"; id: number; ok: false; error: string };

/**
 * Run a workflow script. The script runs in a worker thread, so a runaway
 * loop can never freeze the CLI: stopping terminates the worker. Each agent()
 * call is sent back here and run as a subagent by `runAgent`.
 */
export async function runWorkflow(opts: WorkflowOptions): Promise<WorkflowResult> {
  const started = Date.now();
  if (!META_RE.test(opts.script)) throw new WorkflowError("A workflow script must start with: export const meta = { name: \"…\", description: \"…\" }");
  if (opts.signal.aborted) throw new WorkflowError("Workflow stopped.");
  let args: unknown = null;
  try {
    args = opts.args === undefined ? null : JSON.parse(JSON.stringify(opts.args));
  } catch {
    throw new WorkflowError("Workflow args must be JSON-serialisable.");
  }
  const worker = new Worker(new URL("./workflow-worker.js", import.meta.url), {
    workerData: { script: opts.script, args, maxAgents: opts.maxAgents ?? WORKFLOW_MAX_AGENTS, concurrency: Math.max(1, opts.concurrency ?? WORKFLOW_CONCURRENCY) },
    stdout: true,
    stderr: true,
  });
  const agentControllers = new Set<AbortController>();
  return new Promise<WorkflowResult>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      opts.signal.removeEventListener("abort", onAbort);
      for (const c of agentControllers) c.abort();
      void worker.terminate();
      fn();
    };
    const onAbort = () => finish(() => reject(new WorkflowError("Workflow stopped.")));
    opts.signal.addEventListener("abort", onAbort, { once: true });
    worker.on("error", (err) => finish(() => reject(new WorkflowError(`The workflow failed: ${err.message}`))));
    worker.on("exit", (code) => finish(() => reject(new WorkflowError(`The workflow exited unexpectedly (code ${code}).`))));
    worker.on("message", (msg: WorkerMessage) => {
      if (settled) return;
      switch (msg.type) {
        case "phase":
          opts.events?.onPhase?.(msg.title);
          return;
        case "log":
          opts.events?.onLog?.(msg.line);
          return;
        case "agent-end":
          opts.events?.onAgentEnd?.(msg.id, msg.ok, msg.summary);
          return;
        case "agent": {
          const ctrl = new AbortController();
          agentControllers.add(ctrl);
          const forward = () => ctrl.abort();
          opts.signal.addEventListener("abort", forward, { once: true });
          opts.events?.onAgentStart?.(msg.id, msg.req);
          opts.runAgent(msg.id, msg.req, ctrl.signal).then(
            (text) => !settled && worker.postMessage({ type: "agent-result", id: msg.id, ok: true, text } satisfies MainMessage),
            (err) => !settled && worker.postMessage({ type: "agent-result", id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) } satisfies MainMessage),
          ).finally(() => {
            agentControllers.delete(ctrl);
            opts.signal.removeEventListener("abort", forward);
          });
          return;
        }
        case "done":
          finish(() => resolve({ meta: msg.meta ?? readMeta(opts.script) ?? { name: "workflow" }, result: msg.result, agents: msg.agents, failed: msg.failed, durationMs: Date.now() - started, logs: msg.logs }));
          return;
        case "error":
          finish(() => reject(new WorkflowError(msg.message)));
          return;
      }
    });
  });
}

/* ───────────── saved workflows ───────────── */

export interface SavedWorkflow {
  name: string;
  description: string;
  file: string;
  scope: "project" | "user";
}

export const projectWorkflowsDir = (cwd = process.cwd()) => path.join(cwd, ".unjailed", "workflows");
export const userWorkflowsDir = () => path.join(configDir(), "workflows");

/** Saved .js workflows; a project workflow wins over a user one with the same name. */
export function listWorkflows(cwd = process.cwd()): SavedWorkflow[] {
  const found = new Map<string, SavedWorkflow>();
  for (const [dir, scope] of [[userWorkflowsDir(), "user"], [projectWorkflowsDir(cwd), "project"]] as const) {
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith(".js") || f.endsWith(".mjs"));
    } catch {
      continue;
    }
    for (const f of entries) {
      const file = path.join(dir, f);
      let meta: WorkflowMeta | null = null;
      try {
        meta = readMeta(fs.readFileSync(file, "utf8"));
      } catch {
        /* unreadable */
      }
      const name = path.basename(f).replace(/\.m?js$/, "");
      found.set(name, { name, description: meta?.description ?? "", file, scope });
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadWorkflow(name: string, cwd = process.cwd()): SavedWorkflow & { script: string } | null {
  const hit = listWorkflows(cwd).find((w) => w.name === name.toLowerCase() || w.name === name);
  if (!hit) return null;
  return { ...hit, script: fs.readFileSync(hit.file, "utf8") };
}

/** Save a workflow script as <dir>/<name>.js; refuses to overwrite. */
export function saveWorkflow(name: string, script: string, scope: "project" | "user", cwd = process.cwd()): string {
  if (!/^[a-z0-9][a-z0-9-_]{0,48}$/i.test(name)) throw new Error("Workflow names use letters, numbers, - and _ (max 49 characters).");
  if (!readMeta(script)) throw new Error("The script needs an `export const meta = { name, description }` block.");
  const dir = scope === "project" ? projectWorkflowsDir(cwd) : userWorkflowsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.js`);
  if (fs.existsSync(file)) throw new Error(`${file} already exists.`);
  fs.writeFileSync(file, script.endsWith("\n") ? script : script + "\n");
  return file;
}
