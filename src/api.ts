import { REQUEST_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, VERSION } from "./constants.js";

export type Role = "system" | "user" | "assistant";
export interface ChatMessage {
  role: Role;
  content: string;
}

/** An error whose message is safe and friendly to show the user as-is. */
export class ApiError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

async function serverMessage(res: Response): Promise<string | undefined> {
  try {
    const text = await res.text();
    const json = JSON.parse(text);
    const msg = json?.error?.message ?? json?.message ?? json?.error;
    return typeof msg === "string" ? msg : undefined;
  } catch {
    return undefined;
  }
}

async function httpError(res: Response): Promise<ApiError> {
  const msg = await serverMessage(res);
  switch (res.status) {
    case 401:
      return new ApiError("Invalid or revoked API key. Type /login to enter a new one.", res.status);
    case 403:
      // 403 has a specific reason from the server (e.g. cli-only models, web-chat
      // blocks) — show it verbatim instead of masquerading as a key problem.
      return new ApiError(msg ?? "Access denied for this request.", res.status);
    case 402:
      return new ApiError(msg ?? "Out of credit. Top up at unjailedai.com/dashboard.", res.status);
    case 404:
      return new ApiError(msg ?? "Not found. Check the model (/model) and base URL (/api).", res.status);
    case 429: {
      const retry = res.headers.get("retry-after");
      const hint = retry ? ` Try again in ${retry}s.` : " Wait a moment and try again.";
      if (msg && /rate/i.test(msg)) return new ApiError(msg, res.status);
      return new ApiError(`Rate limited.${msg ? " " + msg : hint}`, res.status);
    }
    default:
      if (res.status >= 500) return new ApiError(`The server had a problem (HTTP ${res.status}). Try again shortly.`, res.status);
      return new ApiError(msg ? `Request failed: ${msg}` : `Request failed (HTTP ${res.status}).`, res.status);
  }
}

function networkError(err: unknown, baseUrl: string, timedOut: boolean): Error {
  if (timedOut) return new ApiError(`Timed out waiting for ${hostOf(baseUrl)}. Try again.`);
  if (err instanceof ApiError || err instanceof AbortedError) return err;
  const e = err as { name?: string; cause?: { code?: string; errors?: { code?: string }[] } };
  if (e?.name === "AbortError") return new AbortedError();
  const code = e?.cause?.code ?? e?.cause?.errors?.find((x) => x?.code)?.code;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return new ApiError(`Can't reach ${hostOf(baseUrl)} — check your internet connection.`);
  if (code === "ECONNREFUSED") return new ApiError(`Connection refused by ${hostOf(baseUrl)}. Is the base URL right? (/api)`);
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return new ApiError("The connection dropped. Try again.");
  if (code && code.startsWith("CERT") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return new ApiError(`TLS certificate problem talking to ${hostOf(baseUrl)}.`);
  return new ApiError(`Network error talking to ${hostOf(baseUrl)}. Check your connection.`);
}

/** fetch with a header timeout, linked to an optional outer abort signal. */
async function request(baseUrl: string, path: string, init: RequestInit & { key: string; signal?: AbortSignal }): Promise<{ res: Response; controller: AbortController }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  init.signal?.addEventListener("abort", onOuterAbort, { once: true });
  try {
    const res = await fetch(baseUrl + path, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${init.key}`,
        "Content-Type": "application/json",
        Accept: path.includes("chat") ? "text/event-stream" : "application/json",
        "User-Agent": `unjailed-cli/${VERSION}`,
        "X-Unjailed-Client": "cli",
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    return { res, controller };
  } catch (err) {
    if (init.signal?.aborted) throw new AbortedError();
    throw networkError(err, baseUrl, timedOut);
  } finally {
    clearTimeout(timer);
  }
}

export interface ModelInfo {
  id: string;
}

export async function listModels(baseUrl: string, key: string, signal?: AbortSignal): Promise<ModelInfo[]> {
  const { res } = await request(baseUrl, "/models", { method: "GET", key, signal });
  if (!res.ok) throw await httpError(res);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError("The server sent an unexpected response to /models. Check the base URL (/api).");
  }
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new ApiError("The server sent an unexpected response to /models. Check the base URL (/api).");
  return data.filter((m) => m && typeof m.id === "string").map((m) => ({ id: m.id as string }));
}

/** Token counts the server reports for a request (OpenAI `usage` object). */
export interface Usage {
  prompt: number;
  completion: number;
  total: number;
}

export interface StreamHandlers {
  onToken: (text: string) => void;
  onReasoning?: (text: string) => void;
  /** Fired once per request when the server reports token usage. */
  onUsage?: (usage: Usage) => void;
  /** Tool-call arguments streaming in (e.g. a whole file for write_file) —
   *  can take minutes with no visible text, so the UI shows this as progress. */
  onToolArgs?: (name: string, chars: number) => void;
}

/** A function call the model wants made. Arguments stream in as fragments. */
export interface ToolCallAccum {
  index: number;
  id?: string;
  name?: string;
  args: string;
}

export interface AgentStreamResult {
  toolCalls: Array<{ id: string; name: string; args: string }>;
  finishReason?: string | null;
  usage?: Usage;
}

/** Pull an OpenAI-style usage object out of a stream chunk or completion. */
function parseUsage(raw: unknown): Usage | undefined {
  const u = raw as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } | null | undefined;
  if (!u || typeof u !== "object") return undefined;
  const prompt = Number(u.prompt_tokens ?? 0);
  const completion = Number(u.completion_tokens ?? 0);
  const total = Number(u.total_tokens ?? prompt + completion);
  if (!prompt && !completion && !total) return undefined;
  return { prompt, completion, total };
}

/**
 * POST /chat/completions with stream:true and feed tokens to the handlers.
 * Rejects with AbortedError if `signal` fires, ApiError for anything user-facing.
 * When options.tools is set, accumulates streamed tool_calls and returns them.
 */
/** streamChat with one automatic retry on server errors (5xx) — upstream
 *  stalls are transient; retrying once after a short pause fixes most
 *  "The server had a problem (HTTP 503)" reports without user action. */
export async function streamChatRetry(
  baseUrl: string,
  key: string,
  model: string,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  signal: AbortSignal,
  options: { effort?: string; tools?: unknown[]; toolChoice?: unknown } = {},
): Promise<AgentStreamResult | undefined> {
  try {
    return await streamChat(baseUrl, key, model, messages, handlers, signal, options);
  } catch (err) {
    if (signal.aborted) throw err;
    if (err instanceof ApiError && (err.status ?? 0) >= 500) {
      handlers.onToken?.("\n*(server hiccup — retrying)*\n");
      await new Promise((r) => setTimeout(r, 1500));
      if (signal.aborted) throw err;
      return await streamChat(baseUrl, key, model, messages, handlers, signal, options);
    }
    throw err;
  }
}

export async function streamChat(
  baseUrl: string,
  key: string,
  model: string,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  signal: AbortSignal,
  options: { effort?: string; tools?: unknown[]; toolChoice?: unknown } = {},
): Promise<AgentStreamResult | undefined> {
  const { res, controller } = await request(baseUrl, "/chat/completions", {
    method: "POST",
    key,
    signal,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(options.tools && options.tools.length ? { tools: options.tools } : {}),
      ...(options.toolChoice !== undefined ? { tool_choice: options.toolChoice } : {}),
      ...(options.effort && options.effort !== "auto" ? { reasoning_effort: options.effort } : {}),
    }),
  });
  if (!res.ok) throw await httpError(res);
  if (!res.body) throw new ApiError("The server returned an empty response.");

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("event-stream")) {
    // Some servers ignore stream:true; accept a plain JSON completion too.
    try {
      const json = (await res.json()) as {
        choices?: { message?: { content?: string; tool_calls?: Array<{ id?: string; index?: number; function?: { name?: string; arguments?: string } }> } }[];
        usage?: unknown;
      };
      const usage = parseUsage(json.usage);
      if (usage) handlers.onUsage?.(usage);
      const msg = json.choices?.[0]?.message;
      if (msg?.tool_calls?.length) {
        const accum = new Map<number, ToolCallAccum>();
        msg.tool_calls.forEach((tc, i) => {
          accum.set(tc.index ?? i, { index: tc.index ?? i, id: tc.id, name: tc.function?.name, args: tc.function?.arguments ?? "{}" });
        });
        return finishTools(accum, null, usage);
      }
      const text = msg?.content;
      if (typeof text === "string") { handlers.onToken(text); return usage ? { toolCalls: [], usage } : undefined; }
    } catch {
      /* fall through */
    }
    throw new ApiError("The server sent an unexpected response. Check the base URL (/api).");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let idleTimedOut = false;
  let idle: NodeJS.Timeout | undefined;
  const toolAccum = new Map<number, ToolCallAccum>();
  let finishReason: string | null = null;
  let usage: Usage | undefined;
  const armIdle = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      idleTimedOut = true;
      controller.abort();
    }, STREAM_IDLE_TIMEOUT_MS);
  };

  try {
    armIdle();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (!data) continue;
        if (data === "[DONE]") return finishTools(toolAccum, finishReason, usage);
        let evt: any;
        try {
          evt = JSON.parse(data);
        } catch {
          continue;
        }
        if (evt?.usage) {
          const u = parseUsage(evt.usage);
          if (u) { usage = u; handlers.onUsage?.(u); }
        }
        if (evt?.error) {
          const m = typeof evt.error === "string" ? evt.error : evt.error.message;
          throw new ApiError(m ? `The server reported an error: ${m}` : "The server reported an error mid-response.");
        }
        const choice0 = evt?.choices?.[0];
        if (choice0?.finish_reason) finishReason = choice0.finish_reason;
        const delta = choice0?.delta ?? {};
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === "string" && reasoning) handlers.onReasoning?.(reasoning);
        if (typeof delta.content === "string" && delta.content) handlers.onToken(delta.content);
        // OpenAI-style streamed tool calls: fragments keyed by index
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            let slot = toolAccum.get(idx);
            if (!slot) { slot = { index: idx, args: "" }; toolAccum.set(idx, slot); }
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name = tc.function.name;
            if (typeof tc.function?.arguments === "string") slot.args += tc.function.arguments;
          }
          const latest = [...toolAccum.values()].reverse().find((t) => t.name);
          if (latest) handlers.onToolArgs?.(latest.name!, [...toolAccum.values()].reduce((n, t) => n + t.args.length, 0));
        }
      }
    }
    return finishTools(toolAccum, finishReason, usage);
  } catch (err) {
    if (signal.aborted) throw new AbortedError();
    if (idleTimedOut) throw new ApiError("The response stalled and timed out. Try again.");
    throw networkError(err, baseUrl, false);
  } finally {
    clearTimeout(idle);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/** Turn accumulated fragments into complete tool calls; undefined if there's
 *  nothing worth returning (no calls, no length-finish, no usage). */
function finishTools(accum: Map<number, ToolCallAccum>, finishReason: string | null = null, usage?: Usage): AgentStreamResult | undefined {
  const calls: AgentStreamResult["toolCalls"] = [];
  for (const slot of [...accum.values()].sort((a, b) => a.index - b.index)) {
    if (!slot.name) continue;
    calls.push({ id: slot.id ?? `call_${slot.index}`, name: slot.name!, args: slot.args || "{}" });
  }
  if (calls.length) return { toolCalls: calls, finishReason, usage };
  if (finishReason === "length" || usage) return { toolCalls: [], finishReason, usage };
  return undefined;
}

/* ————— agent loop: run tool calls to completion against the API ————— */

export type AgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

/** Fold an agent transcript into plain chat — no tool results, no tool_calls —
 *  for requests sent without tools and for saved sessions. Consecutive
 *  assistant messages are merged so roles still alternate. */
export function toPlainChat(history: AgentMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of history) {
    if (m.role === "tool") continue;
    if (m.role === "assistant") {
      if (!m.content.trim()) continue;
      const prev = out[out.length - 1];
      if (prev?.role === "assistant") { prev.content += "\n\n" + m.content; continue; }
      out.push({ role: "assistant", content: m.content });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return out;
}

/** Servers reject an assistant tool_calls message unless every call id is
 *  answered by a tool message right after it (a cancelled turn can leave one
 *  half-answered). Keep complete groups; reduce the rest to their text. */
export function repairToolPairing(history: AgentMessage[]): void {
  for (let i = 0; i < history.length; i++) {
    const m = history[i]!;
    if (m.role === "assistant" && m.tool_calls?.length) {
      let j = i + 1;
      const answered = new Set<string>();
      for (; j < history.length; j++) {
        const next = history[j]!;
        if (next.role !== "tool") break;
        answered.add(next.tool_call_id);
      }
      if (m.tool_calls.every((c) => answered.has(c.id))) { i = j - 1; continue; }
      history.splice(i, j - i, ...(m.content.trim() ? [{ role: "assistant" as const, content: m.content }] : []));
      i--;
    } else if (m.role === "tool") {
      history.splice(i, 1); // orphan result with no preceding call
      i--;
    }
  }
}

export interface AgentHandlers extends StreamHandlers {
  onToolCall?: (name: string, args: string) => void;
  onToolResult?: (name: string, ok: boolean, output: string) => void;
}

/** One agent turn: stream a response, execute any tool calls, feed results
 *  back, repeat — up to maxRounds — then return the final assistant text. */
export async function agentTurn(
  baseUrl: string,
  key: string,
  model: string,
  history: AgentMessage[],
  handlers: AgentHandlers,
  signal: AbortSignal,
  options: {
    effort?: string;
    tools?: unknown[];
    maxRounds?: number;
    execute: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; output: string }>;
  },
): Promise<string> {
  // 40 rounds ≈ a multi-minute build/setup job. The old cap of 8 made the
  // agent silently stop mid-task ("automode stops working after 5 minutes").
  const maxRounds = options.maxRounds ?? 40;
  let exhausted = false;
  let lengthResumes = 0;
  let lastText = "";
  for (let round = 0; round < maxRounds; round++) {
    exhausted = round === maxRounds - 1;
    if (signal.aborted) throw new AbortedError();
    repairToolPairing(history);
    trimHistory(history);
    let roundText = "";
    const res = await streamChatRetry(baseUrl, key, model, history as ChatMessage[], {
      ...handlers,
      onToken: (t) => { roundText += t; handlers.onToken(t); },
    }, signal, { effort: options.effort, tools: options.tools });
    lastText = roundText || lastText;

    // length-finish with zero content = the model burned its entire token budget
    // on hidden reasoning before writing a word (plan-execute pattern triggers this).
    // Transparently resume with a "stop thinking, act now" nudge instead of
    // returning an empty response. Max 2 resumes per turn.
    if (res && res.finishReason === "length" && !roundText.trim() && res.toolCalls.length === 0) {
      if (lengthResumes < 2) {
        lengthResumes++;
        handlers.onToken("\n*(resuming after long reasoning — continuing)*\n\n");
        history.push({ role: "user", content: "Continue now. Skip any further deliberation: proceed directly with the task. If you were executing a plan, start step 1 immediately." });
        continue;
      }
    }

    if (!res || res.toolCalls.length === 0) {
      // The closing reply belongs in the transcript so the next turn sees it.
      if (roundText.trim()) history.push({ role: "assistant", content: roundText });
      return lastText;
    }

    // record the assistant's tool_calls message
    history.push({
      role: "assistant",
      content: roundText,
      tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args } })),
    });

    for (const call of res.toolCalls) {
      if (signal.aborted) throw new AbortedError();
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(call.args || "{}"); } catch { /* model sent bad json */ }
      handlers.onToolCall?.(call.name, call.args);
      const result = await options.execute(call.name, args);
      handlers.onToolResult?.(call.name, result.ok, result.output);
      history.push({ role: "tool", tool_call_id: call.id, content: result.output });
    }
  }
  if (exhausted) {
    lastText += "\n\n[task still in progress — send \"continue\" to keep going]";
  }
  return lastText;
}


/** Keep the request payload lean and inside upstream limits:
 *  - no single message over 28k chars (upstream rejects >32k strings)
 *  - whole history under ~260k chars (~65k tokens) by SHRINKING old content,
 *    never deleting messages — so every assistant tool_calls message keeps its
 *    paired tool result (dropping one would orphan the other and some servers
 *    400 on that). The system message (index 0) and the most recent turns are
 *    left intact; only old context is compressed. */
const MAX_MSG_CHARS = 28_000;
const MAX_HISTORY_CHARS = 260_000;

/** Approx wire size of a message (content + any tool_calls payload). */
function msgSize(m: AgentMessage): number {
  let n = typeof m.content === "string" ? m.content.length : 0;
  if (m.role === "assistant" && m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  return n + 4;
}

export function trimHistory(history: AgentMessage[]): void {
  // 1) hard per-message cap (protects against a single giant message).
  for (const m of history) {
    if (typeof m.content === "string" && m.content.length > MAX_MSG_CHARS) {
      (m as { content: string }).content = m.content.slice(0, MAX_MSG_CHARS - 30) + "\n…(trimmed)";
    }
  }
  const total = () => history.reduce((n, m) => n + msgSize(m), 0);
  if (total() <= MAX_HISTORY_CHARS) return;

  // 2) stub OLD tool-result bodies first — they dominate the payload. Keep the
  //    message itself (pairing stays valid), just drop the bulky body. The
  //    newest two tool results are left whole; the model usually needs them.
  const toolIdx = history.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - 2))) {
    if (total() <= MAX_HISTORY_CHARS) break;
    const m = history[i]!;
    if (typeof m.content === "string" && m.content.length > 100) {
      (m as { content: string }).content = m.content.slice(0, 80) + " …[old tool result trimmed]";
    }
  }

  // 3) still over budget? compress old assistant/user prose (oldest first),
  //    always keeping the system message (0) and the last 4 messages untouched.
  for (let i = 1; i < history.length - 4 && total() > MAX_HISTORY_CHARS; i++) {
    const m = history[i]!;
    if (m.role === "tool") continue; // already handled above
    if (typeof m.content === "string" && m.content.length > 600) {
      (m as { content: string }).content = m.content.slice(0, 300) + "\n…[earlier context trimmed]\n" + m.content.slice(-200);
    }
  }
}
