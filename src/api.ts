import { archivedContext, identifyHistoryEntry, isWorkingContext, protectWorkingContext } from "./context.js";
import { REQUEST_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, REASONING_TIMEOUT_MS, VERSION } from "./constants.js";

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
    /** Seconds from a Retry-After header, when the server sent one. */
    public retryAfter?: number,
    /** Retrying cannot help (bad response shape, TLS, a server-reported error). */
    public permanent = false,
    opts: {
      /** Retry even though the status alone would say otherwise. */
      retryable?: boolean;
      /** Give up after this many retries (a glitch that may repeat). */
      retryLimit?: number;
      /** A machine-readable kind, e.g. "reasoning-deadline". */
      code?: string;
    } = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.retryable = opts.retryable;
    this.retryLimit = opts.retryLimit;
    this.code = opts.code;
  }
  retryable?: boolean;
  retryLimit?: number;
  code?: string;
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
      const after = retry && /^\d+$/.test(retry) ? Number(retry) : undefined;
      const hint = retry ? ` Try again in ${retry}s.` : " Wait a moment and try again.";
      if (msg && /rate/i.test(msg)) return new ApiError(msg, res.status, after);
      return new ApiError(`Rate limited.${msg ? " " + msg : hint}`, res.status, after);
    }
    default:
      if (res.status >= 500) return new ApiError(`The server had a problem (HTTP ${res.status})${msg ? `: ${msg}` : "."}`, res.status);
      // Some gateways answer an upstream interruption with a 4xx; trust the message.
      return new ApiError(msg ? `Request failed: ${msg}` : `Request failed (HTTP ${res.status}).`, res.status, undefined, false, { retryable: !!msg && RETRY_HINT.test(msg) && !PERMANENT_SERVER_ERROR.test(msg) });
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
  if (code && code.startsWith("CERT") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return new ApiError(`TLS certificate problem talking to ${hostOf(baseUrl)}.`, undefined, undefined, true);
  // fetch reports network failures as TypeError; anything else is a bug, not an outage.
  if (err instanceof TypeError || code) return new ApiError(`Network error talking to ${hostOf(baseUrl)}. Check your connection.`);
  return new ApiError(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`, undefined, undefined, true);
}

/** fetch with a header timeout, linked to an optional outer abort signal. */
async function request(baseUrl: string, path: string, init: RequestInit & { key: string; signal?: AbortSignal }): Promise<{ res: Response; controller: AbortController; release: () => void }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort();
  init.signal?.addEventListener("abort", onOuterAbort, { once: true });
  // The outer link must outlive this function (it aborts a streaming body);
  // callers release it when they are done with the response.
  const release = () => init.signal?.removeEventListener("abort", onOuterAbort);
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
    return { res, controller, release };
  } catch (err) {
    release();
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
  const { res, release } = await request(baseUrl, "/models", { method: "GET", key, signal });
  let json: unknown;
  try {
    if (!res.ok) throw await httpError(res);
    json = await res.json();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError("The server sent an unexpected response to /models. Check the base URL (/api).", undefined, undefined, true);
  } finally {
    release();
  }
  const data = (json as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new ApiError("The server sent an unexpected response to /models. Check the base URL (/api).", undefined, undefined, true);
  return data.filter((m) => m && typeof m.id === "string").map((m) => ({ id: m.id as string }));
}

/** Token counts the server reports for a request (OpenAI `usage` object). */
export interface Usage {
  prompt: number;
  completion: number;
  total: number;
  /** Hidden reasoning tokens (part of completion), when the server reports them. */
  reasoning?: number;
}

export interface RetryInfo {
  attempt: number;
  delayMs: number;
  reason: string;
  until: number;
}

export interface StreamHandlers {
  onToken: (text: string) => void;
  /** Each network attempt, including retries and subsequent agent rounds. */
  onRequest?: (context: { characters: number; messages: number }) => void;
  /** Old content was shortened in the request copy; local history is unchanged. */
  onContextTrim?: () => void;
  onReasoning?: (text: string) => void;
  /** Fired once per request when the server reports token usage. */
  onUsage?: (usage: Usage) => void;
  /** A status note for the user (resumes, recoveries). Never part of the reply text. */
  onNotice?: (text: string) => void;
  /** A transient failure; the request is retried at `until`. */
  onRetry?: (info: RetryInfo) => void;
  /** The request succeeded after one or more retries. */
  onRecovered?: () => void;
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
  /** The stream closed without [DONE] or a finish_reason: the reply was cut off. */
  incomplete?: boolean;
}

/** Pull an OpenAI-style usage object out of a stream chunk or completion. */
function parseUsage(raw: unknown): Usage | undefined {
  const u = raw as { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | null | undefined;
  if (!u || typeof u !== "object") return undefined;
  const prompt = Number(u.prompt_tokens ?? 0);
  const completion = Number(u.completion_tokens ?? 0);
  const total = Number(u.total_tokens ?? prompt + completion);
  if (!prompt && !completion && !total) return undefined;
  const reasoning = Number(u.completion_tokens_details?.reasoning_tokens ?? 0);
  return reasoning > 0 ? { prompt, completion, total, reasoning } : { prompt, completion, total };
}

/** Errors the server reports inside a response body (an SSE `error` event or
 *  a JSON `{ error }`). Many are transient (the upstream model stream was
 *  interrupted, overloaded, timed out) and must be retried like an outage;
 *  others (context too long, invalid request, no credit) never succeed. */
const TRANSIENT_SERVER_ERROR = /interrupt|retry|try again|temporar|overload|unavailable|capacity|busy|timed? ?out|timeout|rate.?limit|too many requests|upstream|connection|reset|socket|network|internal (server )?error|bad gateway|gateway|server error|stream (was |got )?(closed|ended|terminated|aborted|cut)|disconnect|unexpected(ly)? (end|eof)|eof/i;
const PERMANENT_SERVER_ERROR = /context|too long|maximum.*tokens|token limit|invalid|not found|does not exist|unsupported|content (policy|filter)|safety|moderation|unauthori[sz]ed|forbidden|api key|credit|quota|billing|payment/i;

/** A 4xx is retried only when its message explicitly says the failure is temporary. */
const RETRY_HINT = /interrupt|retry|try again|temporar|overload|unavailable|timed? ?out|timeout/i;

export function serverReportedError(raw: unknown): ApiError {
  const e = (typeof raw === "string" ? { message: raw } : raw ?? {}) as { message?: unknown; code?: unknown; type?: unknown; status?: unknown };
  const message = typeof e.message === "string" && e.message.trim() ? e.message.trim() : "";
  const status = Number(typeof e.status === "number" ? e.status : typeof e.code === "number" ? e.code : /^\d{3}$/.test(String(e.code ?? "")) ? e.code : NaN);
  const kind = `${typeof e.type === "string" ? e.type : ""} ${typeof e.code === "string" ? e.code : ""}`;
  const text = `${message} ${kind}`;
  let transient: boolean;
  if (Number.isFinite(status)) transient = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
  else if (PERMANENT_SERVER_ERROR.test(text)) transient = false;
  else transient = TRANSIENT_SERVER_ERROR.test(text) || /server_error|overloaded|api_error|timeout/i.test(kind);
  const shown = message ? `The server reported an error: ${message}` : "The server reported an error mid-response.";
  return new ApiError(shown, undefined, undefined, !transient);
}

/** A failure worth waiting out: the network, a timeout, an overloaded or
 *  rate-limited server. Bad keys, no credit and malformed requests are not. */
export function isTransient(err: unknown): boolean {
  if (err instanceof AbortedError) return false;
  if (!(err instanceof ApiError)) return false;
  if (err.retryable) return true;
  if (err.permanent) return false;
  const status = err.status;
  if (status === undefined) return true; // network, timeout, stall, dropped connection
  return status === 408 || status === 409 || status === 425 || status === 429 || status === 499 || status >= 500;
}

/** How long to wait before retry `attempt` (1-based). */
export type Backoff = (attempt: number, retryAfterSeconds?: number) => number;

/** Exponential backoff: 1s, 2s, 4s … capped at 60s, with ±20% jitter. */
export function backoffMs(attempt: number, retryAfterSeconds?: number): number {
  if (retryAfterSeconds && retryAfterSeconds > 0) return Math.min(retryAfterSeconds, 300) * 1000;
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AbortedError());
    const t = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(new AbortedError()); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * streamChat that rides out outages. Transient failures before any output are
 * retried with backoff for as long as it takes (the user can always stop with
 * Esc); a failure after output has streamed returns the partial reply marked
 * `incomplete`, so the agent loop continues from where it stopped instead of
 * repeating text. Permanent errors (401, 402, 400 …) are thrown at once.
 */
export async function streamChatRetry(
  baseUrl: string,
  key: string,
  model: string,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  signal: AbortSignal,
  options: { effort?: string; tools?: unknown[]; toolChoice?: unknown; reasoningTimeoutMs?: number; maxAttempts?: number; backoff?: Backoff } = {},
): Promise<AgentStreamResult> {
  const maxAttempts = options.maxAttempts ?? Infinity;
  const delayFor = options.backoff ?? backoffMs;
  for (let attempt = 1; ; attempt++) {
    let produced = false;
    const watched: StreamHandlers = {
      ...handlers,
      onToken: (t) => { produced = true; handlers.onToken(t); },
      // Visible reasoning counts as output: restarting would show it twice.
      onReasoning: handlers.onReasoning && ((t) => { produced = true; handlers.onReasoning!(t); }),
    };
    try {
      const res = await streamChat(baseUrl, key, model, messages, watched, signal, options);
      if (attempt > 1) handlers.onRecovered?.();
      return res;
    } catch (err) {
      if (signal.aborted) throw new AbortedError();
      if (!isTransient(err)) throw err;
      // The caller (the agent loop) reports the interruption and resumes it.
      if (produced) return { toolCalls: [], finishReason: null, incomplete: true };
      if (attempt >= maxAttempts) throw err;
      if (err instanceof ApiError && err.retryLimit !== undefined && attempt > err.retryLimit) throw err;
      const delay = delayFor(attempt, err instanceof ApiError ? err.retryAfter : undefined);
      handlers.onRetry?.({ attempt, delayMs: delay, reason: err instanceof Error ? err.message : "Request failed", until: Date.now() + delay });
      await sleepAbortable(delay, signal);
    }
  }
}

export async function streamChat(
  baseUrl: string,
  key: string,
  model: string,
  messages: ChatMessage[],
  handlers: StreamHandlers,
  signal: AbortSignal,
  options: { effort?: string; tools?: unknown[]; toolChoice?: unknown; reasoningTimeoutMs?: number } = {},
): Promise<AgentStreamResult> {
  const prepared = prepareRequestHistory(messages as AgentMessage[]);
  handlers.onRequest?.({ characters: prepared.messages.reduce((n, m) => n + msgSize(m), 0), messages: prepared.messages.length });
  if (prepared.trimmed) handlers.onContextTrim?.();
  const { res, controller, release } = await request(baseUrl, "/chat/completions", {
    method: "POST",
    key,
    signal,
    body: JSON.stringify({
      model,
      messages: prepared.messages,
      stream: true,
      stream_options: { include_usage: true },
      ...(options.tools && options.tools.length ? { tools: options.tools } : {}),
      ...(options.toolChoice !== undefined ? { tool_choice: options.toolChoice } : {}),
      ...(options.effort && options.effort !== "auto" ? { reasoning_effort: options.effort } : {}),
    }),
  });
  try {
    return await readCompletion(res, controller, baseUrl, handlers, signal, options.reasoningTimeoutMs ?? REASONING_TIMEOUT_MS);
  } finally {
    release();
  }
}

/** Read a chat completion response (SSE or plain JSON). Usage is reported
 *  once per request — some servers repeat running totals on every chunk. */
async function readCompletion(res: Response, controller: AbortController, baseUrl: string, handlers: StreamHandlers, signal: AbortSignal, reasoningTimeoutMs: number): Promise<AgentStreamResult> {
  const report = (r: AgentStreamResult): AgentStreamResult => {
    if (r.usage) handlers.onUsage?.(r.usage);
    return r;
  };
  if (!res.ok) throw await httpError(res);
  if (!res.body) throw new ApiError("The server returned an empty response.", undefined, undefined, false, { retryLimit: 3 });

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("event-stream")) {
    // Some servers ignore stream:true; accept a plain JSON completion too.
    let json: {
      choices?: { finish_reason?: string; message?: { content?: string; tool_calls?: Array<{ id?: string; index?: number; function?: { name?: string; arguments?: string } }> } }[];
      usage?: unknown;
      error?: unknown;
    };
    try {
      json = await res.json();
    } catch {
      throw new ApiError("The server sent an unexpected response. Check the base URL (/api).", undefined, undefined, true);
    }
    if (json?.error) throw serverReportedError(json.error);
    const usage = parseUsage(json.usage);
    const msg = json.choices?.[0]?.message;
    const reason = json.choices?.[0]?.finish_reason ?? null;
    if (typeof msg?.content === "string" && msg.content) handlers.onToken(msg.content);
    if (msg?.tool_calls?.length) {
      const accum = new Map<number, ToolCallAccum>();
      msg.tool_calls.forEach((tc, i) => {
        accum.set(tc.index ?? i, { index: tc.index ?? i, id: tc.id, name: tc.function?.name, args: tc.function?.arguments ?? "{}" });
      });
      return report(finishTools(accum, reason ?? "tool_calls", usage));
    }
    if (typeof msg?.content === "string") return report({ toolCalls: [], finishReason: reason ?? "stop", usage });
    throw new ApiError("The server sent an unexpected response. Check the base URL (/api).", undefined, undefined, true);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let idleTimedOut = false;
  let idle: NodeJS.Timeout | undefined;
  let reasoningTimer: NodeJS.Timeout | undefined;
  let reasoningTimedOut = false;
  let productive = false; // an answer or a tool call has started
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

  /** Handle one SSE line; true at [DONE]. */
  const processLine = (line: string): boolean => {
    if (!line.startsWith("data:")) return false;
    const data = line.slice(5).trim();
    if (!data) return false;
    if (data === "[DONE]") return true;
    let evt: any;
    try {
      evt = JSON.parse(data);
    } catch {
      // A torn chunk could hold part of a tool call; never guess at it.
      throw new ApiError("The model sent a malformed stream chunk. No incomplete tool call was executed.", undefined, undefined, false, { retryLimit: 3 });
    }
    if (evt?.usage) {
      const u = parseUsage(evt.usage);
      if (u) usage = u;
    }
    // "The model stream was interrupted. Retry to continue." arrives this way:
    // transient errors are retried (or resumed after partial output), the
    // rest stop with the server's message.
    if (evt?.error) throw serverReportedError(evt.error);
    const choice = evt?.choices?.[0];
    if (choice?.finish_reason === "error") throw serverReportedError(choice.error ?? "The model stream ended with an error. Retry to continue.");
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta ?? {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === "string" && reasoning) handlers.onReasoning?.(reasoning);
    if ((typeof delta.content === "string" && delta.content) || delta.tool_calls?.length) {
      productive = true;
      clearTimeout(reasoningTimer);
    }
    if (typeof delta.content === "string" && delta.content) handlers.onToken(delta.content);
    // OpenAI-style streamed tool calls: fragments keyed by index. Some servers
    // also split the function name across chunks.
    if (Array.isArray(delta.tool_calls)) {
      for (const [i, tc] of delta.tool_calls.entries()) {
        const idx = typeof tc.index === "number" ? tc.index : i;
        let slot = toolAccum.get(idx);
        if (!slot) { slot = { index: idx, args: "" }; toolAccum.set(idx, slot); }
        if (tc.id) slot.id = tc.id;
        const name = tc.function?.name;
        if (typeof name === "string" && name) {
          if (!slot.name || name.startsWith(slot.name)) slot.name = name;
          else if (name !== slot.name) slot.name += name;
        }
        if (typeof tc.function?.arguments === "string") slot.args += tc.function.arguments;
      }
    }
    return false;
  };

  try {
    armIdle();
    // Reasoning heartbeats must not keep a request alive forever.
    reasoningTimer = setTimeout(() => {
      if (!productive) { reasoningTimedOut = true; controller.abort(); }
    }, reasoningTimeoutMs);
    for (;;) {
      const { value, done } = await reader.read();
      // Don't rely on the abort alone to end the body: stop reading once a timer fired.
      if (reasoningTimedOut || idleTimedOut) throw new Error("timed out");
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (!done) armIdle();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (processLine(line)) return report(finishTools(toolAccum, finishReason ?? "stop", usage));
      }
      if (done) {
        // The last event may arrive without a trailing newline.
        if (buffer.trim() && processLine(buffer.replace(/\r$/, ""))) return report(finishTools(toolAccum, finishReason ?? "stop", usage));
        // Closed without [DONE] or a finish_reason: an interrupted reply, not a
        // finished one. Silently returning here is how long agent runs used to
        // "just stop" with no explanation.
        return report({ ...finishTools(toolAccum, finishReason, usage), incomplete: !finishReason });
      }
    }
  } catch (err) {
    if (signal.aborted) throw new AbortedError();
    if (reasoningTimedOut) throw new ApiError("The model produced no answer or tool call within the reasoning deadline. Completed work remains saved. Try /effort low or another model.", undefined, undefined, true, { code: "reasoning-deadline" });
    if (idleTimedOut) throw new ApiError("The response stalled and timed out. Try again.");
    throw networkError(err, baseUrl, false);
  } finally {
    clearTimeout(idle);
    clearTimeout(reasoningTimer);
    controller.abort();
    // Stop the body itself too: not every stream source honours the abort.
    reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

/** Turn accumulated fragments into complete tool calls. */
function finishTools(accum: Map<number, ToolCallAccum>, finishReason: string | null = null, usage?: Usage): AgentStreamResult {
  const calls: AgentStreamResult["toolCalls"] = [];
  for (const slot of [...accum.values()].sort((a, b) => a.index - b.index)) {
    if (!slot.name) throw new ApiError("The model returned an incomplete tool call without a name. Nothing from that response was executed.", undefined, undefined, false, { retryLimit: 2 });
    calls.push({ id: slot.id ?? `call_${slot.index}`, name: slot.name!, args: slot.args || "{}" });
  }
  return { toolCalls: calls, finishReason, usage };
}

/* ————— agent loop: run tool calls to completion against the API ————— */

export type AgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

export interface AgentHandlers extends StreamHandlers {
  /** The loop is recovering on its own (a nudge, a resume); also sent to onNotice. */
  onRecovery?: (message: string) => void;
  onToolCall?: (name: string, args: string, id: string) => void;
  onToolResult?: (name: string, ok: boolean, output: string, id: string) => void;
}

/** Why an agent turn ended — always reported to the user, never silent. */
export type TurnEnd = "done" | "max-rounds" | "gave-up";

export interface AgentTurnResult {
  /** The reply since the last tool round (continuations included). */
  text: string;
  end: TurnEnd;
  rounds: number;
  toolCalls: number;
}

const MAX_EMPTY_CLOSES = 12; // ~8 minutes of backoff
const MAX_CUT_OFFS = 12; // with backoff, several minutes of an unstable upstream
const CONTINUE_CUT_OFF = "Your previous reply was cut off before it finished. Continue exactly where it stopped. Do not repeat text you already wrote.";
const CONTINUE_LENGTH = "You hit the output limit mid-reply. Continue exactly where you stopped. Do not repeat text you already wrote. Split large files into several smaller edits.";
const CONTINUE_REASONING = "Continue now. Skip further deliberation and proceed directly with the task.";
const CONTINUE_STALLED = "You described a next step but did not call a tool, so nothing happened. Carry out that step now with your tools. If the whole task is already complete, reply with a brief final summary instead.";

/** A reply that announces work ("Now I'll update the tests:") instead of
 * finishing. Ending the turn there looks like the agent silently stopped. */
export function announcesNextStep(text: string): boolean {
  const tail = text.trim().slice(-240);
  if (!tail) return false;
  if (/[:…]$/.test(tail)) return true;
  const last = tail.split(/(?<=[.!?])\s+/).pop() ?? "";
  return /^(?:now,?\s+|next,?\s+|then,?\s+|ok(?:ay)?,?\s+|great,?\s+|first,?\s+)?(?:let me|let's|i'll|i will|i'm going to|i am going to|going to)\b/i.test(last.trim());
}

/** One agent turn: stream a response, execute any tool calls, feed results
 *  back, repeat until the model answers without tools. Cut-off replies,
 *  dropped connections and announced-but-unperformed steps are resumed
 *  automatically (bounded), and the reason the turn ended is returned. */
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
    /** Tool calls for which this returns true run concurrently when adjacent. */
    parallelSafe?: (name: string) => boolean;
    execute?: (name: string, args: Record<string, unknown>, id: string) => Promise<{ ok: boolean; output: string; historyEntry?: string }>;
    /** Messages the user typed mid-turn, delivered after the current tool. */
    interject?: () => string[];
    /** Retry pacing (tests use a fast one). */
    backoff?: Backoff;
    /** How long a request may produce only reasoning (default UNJAILED_REASONING_TIMEOUT). */
    reasoningTimeoutMs?: number;
  },
): Promise<AgentTurnResult> {
  const maxRounds = options.maxRounds ?? 100;
  const delayFor = options.backoff ?? backoffMs;
  let deadlines = 0; // reasoning-deadline recoveries
  const hasTools = !!options.tools?.length && !!options.execute;
  let recoveries = 0; // length / reasoning-only resumes
  let emptyCloses = 0; // streams closed before any output, in a row
  let cutOffs = 0; // replies cut off mid-way, in a row
  let nudges = 0; // announced-but-unperformed steps
  let answer = "";
  let toolCalls = 0;
  // Only push for action when the task asks for one and nothing was denied:
  // a model that stops after a declined change must be allowed to explain.
  const task = [...history].reverse().find((m) => m.role === "user")?.content ?? "";
  const actionable = /\b(fix|edit|write|create|make|build|implement|add|update|upgrade|wire|run|test|debug|refactor|change|remove|delete|rename|install)\b/i.test(task);
  let permissionBlocked = false;
  const resume = (partial: string, instruction: string, notice: string) => {
    handlers.onNotice?.(notice);
    handlers.onRecovery?.(notice);
    if (partial.trim()) history.push({ role: "assistant", content: partial });
    history.push({ role: "user", content: instruction });
  };
  for (let round = 0; round < maxRounds; round++) {
    if (signal.aborted) throw new AbortedError();
    let roundText = "";
    let res: AgentStreamResult;
    try {
      res = await streamChatRetry(baseUrl, key, model, history as ChatMessage[], {
        ...handlers,
        onToken: (t) => { roundText += t; handlers.onToken(t); },
      }, signal, { effort: options.effort, tools: hasTools ? options.tools : undefined, backoff: options.backoff, reasoningTimeoutMs: options.reasoningTimeoutMs });
    } catch (err) {
      // A model that only deliberates past the deadline is asked to act now,
      // rather than ending the turn.
      if (err instanceof ApiError && err.code === "reasoning-deadline" && deadlines++ < 2) {
        answer += roundText;
        resume(roundText, CONTINUE_REASONING, "The model reasoned past the deadline without acting — asking it to proceed.");
        continue;
      }
      throw err;
    }
    answer += roundText;

    if (res.incomplete && !res.toolCalls.length) {
      if (!roundText.trim()) {
        // Closed before a single token: usually an outage. Wait it out, but a
        // server that always does this (a filter, a broken proxy) must not spin forever.
        if (++emptyCloses > MAX_EMPTY_CLOSES) throw new ApiError(`The server closed the stream without replying ${MAX_EMPTY_CLOSES} times in a row. Send "continue" to try again, or try another /model.`, undefined, undefined, true);
        const delay = delayFor(emptyCloses);
        handlers.onRetry?.({ attempt: emptyCloses, delayMs: delay, reason: "The server closed the stream without replying", until: Date.now() + delay });
        await sleepAbortable(delay, signal);
        round--; // waiting out an outage is not a round of work
        continue;
      }
      emptyCloses = 0;
      if (++cutOffs > MAX_CUT_OFFS) return { text: answer, end: "gave-up", rounds: round + 1, toolCalls };
      resume(roundText, CONTINUE_CUT_OFF, "The reply was interrupted — resuming where it stopped.");
      // Repeated interruptions usually mean an unstable upstream: wait a bit longer each time.
      if (cutOffs > 1) {
        const delay = delayFor(cutOffs - 1);
        handlers.onRetry?.({ attempt: cutOffs, delayMs: delay, reason: "The reply keeps getting interrupted", until: Date.now() + delay });
        await sleepAbortable(delay, signal);
      }
      continue;
    }
    emptyCloses = 0;
    if (!res.incomplete) cutOffs = 0;
    if (res.finishReason === "length" && !res.toolCalls.length) {
      if (recoveries++ < 3) {
        resume(roundText, roundText.trim() ? CONTINUE_LENGTH : CONTINUE_REASONING,
          roundText.trim() ? "Reply hit the output limit — continuing it." : "The model used its whole budget reasoning — asking it to continue.");
        continue;
      }
      return { text: answer, end: "gave-up", rounds: round + 1, toolCalls };
    }

    if (!res.toolCalls.length) {
      const lastLine = roundText.trim().split("\n").filter(Boolean).at(-1) ?? "";
      const blockerOrQuestion = /[?]\s*$/.test(lastLine) || /\b(cannot|can't|unable|permission|approval|denied|blocked|done|finished|completed)\b/i.test(lastLine);
      if (hasTools && actionable && !permissionBlocked && !blockerOrQuestion && announcesNextStep(roundText)) {
        if (nudges < 2 && round < maxRounds - 1) {
          nudges++;
          resume(roundText, CONTINUE_STALLED, "The agent described a step without doing it — prompting it to continue.");
          continue;
        }
        const warning = "\n\n[Model stopped without performing its announced action. Try another model or send continue; no success is implied.]";
        handlers.onToken(warning);
        return { text: answer + warning, end: "gave-up", rounds: round + 1, toolCalls };
      }
      return { text: answer, end: "done", rounds: round + 1, toolCalls };
    }

    // Tool arguments cut off by the output limit are not valid JSON; running
    // them would act on garbage. Tell the model instead.
    // Arguments must be a JSON object; never execute guessed arguments.
    const parsedArgs = new Map<string, Record<string, unknown>>();
    for (const c of res.toolCalls) {
      try {
        const v = JSON.parse(c.args || "{}");
        if (v && typeof v === "object" && !Array.isArray(v)) parsedArgs.set(c.id, v);
      } catch { /* invalid: reported below */ }
    }
    history.push({
      role: "assistant",
      content: roundText,
      tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args } })),
    });
    answer = "";

    // Adjacent parallel-safe calls (subagents) run together; everything else
    // runs one at a time. Results go back in the order the model asked.
    // A message the user sends meanwhile is delivered after the tool that is
    // running: the rest of this batch was planned without it, so those calls
    // are skipped (and reported as such) and the model re-plans with it.
    const calls = res.toolCalls;
    let delivered: string[] = [];
    for (let i = 0; i < calls.length;) {
      if (signal.aborted) throw new AbortedError();
      if (i > 0) delivered = options.interject?.() ?? [];
      if (delivered.length) {
        for (const call of calls.slice(i)) {
          const output = "Not run: the user sent a new message before this step. Re-plan with it; repeat this call only if it is still needed.";
          handlers.onToolCall?.(call.name, call.args, call.id);
          handlers.onToolResult?.(call.name, false, output, call.id);
          history.push({ role: "tool", tool_call_id: call.id, content: output });
        }
        break;
      }
      let j = i + 1;
      if (options.parallelSafe?.(calls[i]!.name)) while (j < calls.length && options.parallelSafe(calls[j]!.name)) j++;
      const group = calls.slice(i, j);
      const results = await Promise.all(group.map(async (call) => {
        toolCalls++;
        handlers.onToolCall?.(call.name, call.args, call.id);
        let result: { ok: boolean; output: string; historyEntry?: string };
        const args = parsedArgs.get(call.id);
        if (!args) {
          result = { ok: false, output: "Invalid or incomplete tool arguments. Nothing executed. Send a corrected JSON object; if the arguments were cut off, split large content into several smaller edits." };
        } else {
          // A failing tool is reported to the model, which can adjust; it must not end the turn.
          try {
            result = await options.execute!(call.name, args, call.id);
          } catch (err) {
            if (err instanceof AbortedError || signal.aborted) throw new AbortedError();
            result = { ok: false, output: `The tool failed: ${err instanceof Error ? err.message : String(err)}` };
          }
        }
        if (!result.ok && /declined|approval is unavailable|cancelled|unavailable in .* mode/i.test(result.output)) permissionBlocked = true;
        handlers.onToolResult?.(call.name, result.ok, result.output, call.id);
        return result;
      }));
      group.forEach((call, k) => {
        const result = results[k]!;
        const evidence: AgentMessage = { role: "tool", tool_call_id: call.id, content: result.output };
        if ("historyEntry" in result && result.historyEntry) identifyHistoryEntry(evidence, result.historyEntry);
        history.push(evidence);
      });
      i = j;
    }
    if (!delivered.length) delivered = options.interject?.() ?? [];
    for (const text of delivered) {
      history.push({ role: "user", content: `[Sent by the user while you were working — take it into account now]\n${text}` });
    }
  }
  return { text: answer, end: "max-rounds", rounds: maxRounds, toolCalls };
}


/** Keep the request payload lean and inside upstream limits:
 *  - no single message over 28k chars (upstream rejects >32k strings)
 *  - target history under ~96k chars (~24k tokens) by SHRINKING old content,
 *    never deleting messages — so every assistant tool_calls message keeps its
 *    paired tool result (dropping one would orphan the other and some servers
 *    400 on that). The system message (index 0) and the most recent turns are
 *    left intact; only old context is compressed. */
const MAX_MSG_CHARS = 28_000;
const MAX_HISTORY_CHARS = 96_000;
const MAX_REQUEST_MESSAGES = 159; // reserve one slot for recovered context

/** Prepare only the wire copy. Completed chats and resumable sessions retain
 * their full text. Old saved chats may contain tool calls whose results were
 * never saved: drop those calls rather than send orphaned protocol entries. */
export function prepareRequestHistory(history: AgentMessage[]): { messages: AgentMessage[]; trimmed: boolean } {
  // Tiny messages can evade a character budget. Retain the initial task and
  // recent complete user turns, never cutting inside a live tool-call group.
  let selected = history;
  if (history.length > MAX_REQUEST_MESSAGES) {
    const target = history.length - MAX_REQUEST_MESSAGES;
    let cut = history.findIndex((m, i) => i >= target && m.role === "user");
    if (cut < 0) {
      // A single active tool-heavy turn can exceed the target; retain it whole.
      for (let i = target - 1; i >= 0; i--) {
        if (history[i]!.role === "user") { cut = i; break; }
      }
    }
    if (cut > 0) {
      const firstUser = history.findIndex((m) => m.role === "user");
      selected = history.filter((m, i) => i >= cut || m.role === "system" || i === firstUser || isWorkingContext(m));
    }
  }
  const resultIds = new Set(selected.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  const messages: AgentMessage[] = selected.map((m) => {
    if (m.role !== "assistant" || !m.tool_calls) {
      const copy = { ...m };
      return isWorkingContext(m) ? protectWorkingContext(copy) : copy;
    }
    const calls = m.tool_calls.filter((call) => resultIds.has(call.id));
    return calls.length ? { ...m, tool_calls: calls } : { role: "assistant", content: m.content };
  });
  trimHistory(messages, 84_000);
  const trimmed = selected.length !== history.length || messages.some((m, i) => m.content !== selected[i]!.content);
  const archive = trimmed ? archivedContext(history, selected, messages) : "";
  if (archive) {
    // Keep the initial system/task at the front and the current request at the
    // end; memory excerpts are bounded and carry exact source references.
    const firstUser = messages.findIndex(m => m.role === "user");
    const position = firstUser >= 0 ? (firstUser === messages.length - 1 ? firstUser : firstUser + 1) : messages.filter(m => m.role === 'system').length;
    messages.splice(position, 0, { role: "assistant", content: archive });
  }
  return { messages, trimmed };
}

/** Approx wire size of a message (content + any tool_calls payload). */
function msgSize(m: AgentMessage): number {
  let n = typeof m.content === "string" ? m.content.length : 0;
  if (m.role === "assistant" && m.tool_calls) n += JSON.stringify(m.tool_calls).length;
  return n + 4;
}

export function trimHistory(history: AgentMessage[], budget = MAX_HISTORY_CHARS): void {
  // 1) hard per-message cap (protects against a single giant message).
  for (const m of history) {
    if (typeof m.content === "string" && m.content.length > MAX_MSG_CHARS) {
      (m as { content: string }).content = m.content.slice(0, MAX_MSG_CHARS - 30) + "\n…(trimmed)";
    }
  }
  // Account once, then subtract each reduction. Repeated full-history scans
  // here made trimming quadratic in long coding conversations.
  let total = history.reduce((n, m) => n + msgSize(m), 0);
  if (total <= budget) return;
  const shorten = (m: AgentMessage, content: string) => {
    total -= m.content.length - content.length;
    m.content = content;
  };

  // 2) stub OLD tool-result bodies first — they dominate the payload. Keep the
  //    message itself (pairing stays valid), just drop the bulky body. The
  //    newest two tool results are left whole; the model usually needs them.
  const toolIdx = history.map((m, i) => (m.role === "tool" ? i : -1)).filter((i) => i >= 0);
  for (const i of toolIdx.slice(0, Math.max(0, toolIdx.length - 2))) {
    if (total <= budget) break;
    const m = history[i]!;
    if (typeof m.content === "string" && m.content.length > 100) {
      shorten(m, m.content.slice(0, 80) + " …[old tool result trimmed]");
    }
  }

  // 3) still over budget? compress old assistant/user prose (oldest first),
  //    always keeping the system message (0) and the last 4 messages untouched.
  for (let i = 1; i < history.length - 4 && total > budget; i++) {
    const m = history[i]!;
    if (isWorkingContext(m)) continue;
    if (m.role === "tool") continue; // already handled above
    if (typeof m.content === "string" && m.content.length > 600) {
      shorten(m, m.content.slice(0, 300) + "\n…[earlier context trimmed]\n" + m.content.slice(-200));
    }
  }
}
