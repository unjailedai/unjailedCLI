import { parentPort, workerData } from "node:worker_threads";
import vm from "node:vm";
import { extractJson, META_RE, type AgentRequest, type MainMessage, type WorkerMessage, type WorkflowMeta } from "./workflow.js";

/**
 * Runs one workflow script (see src/workflow.ts). The script gets only the
 * workflow API in a fresh V8 context; agent() calls go to the main thread,
 * which runs them as subagents. This thread can be terminated at any time,
 * so a runaway script never blocks the CLI.
 */

const { script, args, maxAgents, concurrency } = workerData as { script: string; args: unknown; maxAgents: number; concurrency: number };
const port = parentPort!;
const send = (msg: WorkerMessage) => port.postMessage(msg);

/** Errors that must stop the whole workflow, even inside parallel()/pipeline(). */
class FatalError extends Error {}

const pending = new Map<number, { resolve: (text: string) => void; reject: (err: Error) => void }>();
port.on("message", (msg: MainMessage) => {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.text);
  else p.reject(new Error(msg.error));
});

let active = 0;
const waiting: (() => void)[] = [];
async function limited<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= concurrency) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

let launched = 0;
let failed = 0;
const logs: string[] = [];
const metaBox: { v?: WorkflowMeta } = {};

const toText = (p: unknown) => (typeof p === "string" ? p : JSON.stringify(p));
const log = (...parts: unknown[]) => {
  const line = parts.map(toText).join(" ").slice(0, 500);
  logs.push(line);
  send({ type: "log", line });
};

const agent = async (prompt: unknown, options: { label?: unknown; phase?: unknown; schema?: unknown } = {}): Promise<unknown> => {
  if (typeof prompt !== "string" || !prompt.trim()) throw new FatalError("agent(prompt) needs a non-empty prompt string.");
  if (launched >= maxAgents) throw new FatalError(`This workflow tried to start more than ${maxAgents} agents.`);
  const id = ++launched;
  const req: AgentRequest = {
    prompt: options.schema === undefined ? prompt : `${prompt}\n\nYour final reply must be ONLY a JSON value matching this JSON Schema (no prose, no code fence):\n${JSON.stringify(options.schema)}`,
    label: typeof options.label === "string" && options.label ? options.label.slice(0, 60) : `agent ${id}`,
    phase: typeof options.phase === "string" ? options.phase : undefined,
    schema: options.schema,
  };
  return limited(async () => {
    let text: string;
    try {
      text = await new Promise<string>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ type: "agent", id, req });
      });
    } catch (err) {
      failed++;
      send({ type: "agent-end", id, ok: false, summary: err instanceof Error ? err.message : String(err), failed: true });
      throw err;
    }
    if (req.schema === undefined) {
      send({ type: "agent-end", id, ok: true, summary: text, failed: false });
      return text;
    }
    const value = extractJson(text);
    if (value === undefined) {
      failed++;
      send({ type: "agent-end", id, ok: false, summary: "Reply was not valid JSON", failed: true });
      return { error: "agent reply was not valid JSON", raw: text.slice(0, 4000) };
    }
    send({ type: "agent-end", id, ok: true, summary: JSON.stringify(value), failed: false });
    return value;
  });
};

/** Run thunks concurrently; a failed one yields null instead of sinking the rest. */
const parallel = async (thunks: unknown): Promise<unknown[]> => {
  if (!Array.isArray(thunks)) throw new FatalError("parallel() takes an array of functions, e.g. parallel(items.map((x) => () => agent(...)))");
  thunks.forEach((t, i) => {
    if (typeof t !== "function") throw new FatalError(`parallel(): item ${i} is not a function. Wrap calls: () => agent(...)`);
  });
  return Promise.all(thunks.map(async (t: () => unknown, i) => {
    try {
      return await t();
    } catch (err) {
      if (err instanceof FatalError) throw err;
      log(`parallel item ${i} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }));
};

/** Each item flows through every stage on its own; items don't wait for each other. */
const pipeline = async (items: unknown, ...stages: unknown[]): Promise<unknown[]> => {
  if (!Array.isArray(items)) throw new FatalError("pipeline(items, ...stages) needs an array of items.");
  if (!stages.length || stages.some((st) => typeof st !== "function")) throw new FatalError("pipeline() stages must be functions.");
  return Promise.all(items.map(async (item, index) => {
    let value: unknown = item;
    try {
      for (const stage of stages as ((v: unknown, item: unknown, i: number) => unknown)[]) {
        value = await stage(value, item, index);
        if (value === null || value === undefined) break;
      }
      return value;
    } catch (err) {
      if (err instanceof FatalError) throw err;
      log(`pipeline item ${index} failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }));
};

const phase = (title: unknown) => {
  if (typeof title === "string") send({ type: "phase", title });
};

async function main() {
  const body = script.replace(META_RE, "const meta = __meta.v =");
  const context = vm.createContext({ __meta: metaBox, agent, parallel, pipeline, phase, log, args, console: { log, info: log, warn: log, error: log } });
  let run: Promise<unknown>;
  try {
    run = new vm.Script(`(async () => {\n${body}\n})()`, { filename: "workflow.js" }).runInContext(context, { timeout: 2000 }) as Promise<unknown>;
  } catch (err) {
    send({ type: "error", message: `The workflow script has an error: ${err instanceof Error ? err.message : String(err)}` });
    return;
  }
  try {
    const result = await run;
    // Results cross the thread boundary as plain JSON.
    let plain: unknown = null;
    try {
      plain = result === undefined ? null : JSON.parse(JSON.stringify(result));
    } catch {
      plain = String(result);
    }
    const meta = metaBox.v && typeof metaBox.v.name === "string" ? { name: metaBox.v.name, description: typeof metaBox.v.description === "string" ? metaBox.v.description : undefined } : null;
    send({ type: "done", result: plain, meta, agents: launched, failed, logs });
  } catch (err) {
    send({ type: "error", message: err instanceof FatalError ? err.message : `The workflow failed: ${err instanceof Error ? err.message : String(err)}` });
  }
}

void main();
