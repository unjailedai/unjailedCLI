import { archivedContext, identifyHistoryEntry, isWorkingContext, protectWorkingContext } from "./context.js";
import { REQUEST_TIMEOUT_MS, STREAM_IDLE_TIMEOUT_MS, REASONING_TIMEOUT_MS, RESPONSE_TIMEOUT_MS, VERSION } from "./constants.js";

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
  // Agent rounds share a signal. Release each old listener as its request ends.
  controller.signal.addEventListener("abort", () => init.signal?.removeEventListener("abort", onOuterAbort), { once: true });
  try {
    if (init.signal?.aborted) throw new AbortedError();
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
    controller.abort();
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
  const { res, controller } = await request(baseUrl, "/models", { method: "GET", key, signal });
  try {
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
  } finally { controller.abort(); }
}

/** Token counts the server reports for a request (OpenAI `usage` object). */
export interface Usage {
  prompt: number;
  completion: number;
  total: number;
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
  options: { effort?: string; tools?: unknown[]; toolChoice?: unknown; reasoningTimeoutMs?: number; responseTimeoutMs?: number } = {},
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
  options: { effort?: string; tools?: unknown[]; toolChoice?: unknown; reasoningTimeoutMs?: number; responseTimeoutMs?: number } = {},
): Promise<AgentStreamResult | undefined> {
  const prepared = prepareRequestHistory(messages as AgentMessage[]);
  handlers.onRequest?.({ characters: prepared.messages.reduce((n, m) => n + msgSize(m), 0), messages: prepared.messages.length });
  if (prepared.trimmed) handlers.onContextTrim?.();
  const { res, controller } = await request(baseUrl, "/chat/completions", {
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
  if (!res.ok) { try { throw await httpError(res); } finally { controller.abort(); } }
  if (!res.body) { controller.abort(); throw new ApiError("The server returned an empty response."); }

  let responseTimedOut = false;
  const responseTimer = setTimeout(() => { responseTimedOut = true; controller.abort(); }, options.responseTimeoutMs ?? RESPONSE_TIMEOUT_MS);

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("event-stream")) {
    // Some servers ignore stream:true; accept a plain JSON completion too.
    try {
      const json = (await res.json()) as {
        choices?: { finish_reason?: string; message?: { content?: string; tool_calls?: Array<{ id?: string; index?: number; function?: { name?: string; arguments?: string } }> } }[];
        usage?: unknown;
      };
      const usage = parseUsage(json.usage);
      if (usage) handlers.onUsage?.(usage);
      const msg = json.choices?.[0]?.message;
      const reason = json.choices?.[0]?.finish_reason ?? null;
      if (typeof msg?.content === "string") handlers.onToken(msg.content);
      if (msg?.tool_calls?.length) {
        const accum = new Map<number, ToolCallAccum>();
        msg.tool_calls.forEach((tc, i) => {
          accum.set(tc.index ?? i, { index: tc.index ?? i, id: tc.id, name: tc.function?.name, args: tc.function?.arguments ?? "{}" });
        });
        return finishTools(accum, reason, usage);
      }
      const text = msg?.content;
      if (typeof text === "string") return { toolCalls: [], usage, finishReason: reason };
    } catch {
      if (signal.aborted) throw new AbortedError();
      if (responseTimedOut) throw new ApiError("The model exceeded the response deadline. Completed work remains saved. Try /effort low or another model.");
      /* fall through */
    } finally {
      clearTimeout(responseTimer);
      controller.abort();
    }
    throw new ApiError("The server sent an unexpected response. Check the base URL (/api).");
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let idleTimedOut = false;
  let idle: NodeJS.Timeout | undefined;
  let reasoningTimer: NodeJS.Timeout | undefined;
  let reasoningTimedOut = false;
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
  const armProgress = () => {
    clearTimeout(reasoningTimer);
    reasoningTimer = setTimeout(() => { reasoningTimedOut = true; controller.abort(); }, options.reasoningTimeoutMs ?? REASONING_TIMEOUT_MS);
  };

  const processLine = (line: string): boolean => {
    if (!line.startsWith("data:")) return false;
    const data = line.slice(5).trim();
    if (!data) return false;
    if (data === "[DONE]") return true;
    let evt: any;
    try { evt = JSON.parse(data); } catch { throw new ApiError("The model sent a malformed stream chunk. No incomplete tool call was executed."); }
    if (evt?.usage) {
      const u = parseUsage(evt.usage);
      if (u) { usage = u; handlers.onUsage?.(u); }
    }
    if (evt?.error) {
      const m = typeof evt.error === "string" ? evt.error : evt.error.message;
      throw new ApiError(m ? `The server reported an error: ${m}` : "The server reported an error mid-response.");
    }
    const choice = evt?.choices?.[0];
    if (choice?.finish_reason) finishReason = choice.finish_reason;
    const delta = choice?.delta ?? {};
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === "string" && reasoning) handlers.onReasoning?.(reasoning);
    const toolProgress = Array.isArray(delta.tool_calls) && delta.tool_calls.some((tc: any) =>
      (typeof tc.function?.name === "string" && tc.function.name.length > 0) ||
      (typeof tc.function?.arguments === "string" && tc.function.arguments.length > 0));
    if ((typeof delta.content === "string" && delta.content.trim()) || toolProgress) {
      armProgress();
    }
    if (typeof delta.content === "string" && delta.content) handlers.onToken(delta.content);
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
    // A heartbeat or continuous reasoning must not keep a request alive forever.
    armProgress();
    for (;;) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (!done) armIdle();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (processLine(line)) return finishTools(toolAccum, finishReason, usage);
      }
      if (done) {
        if (buffer.trim()) processLine(buffer.replace(/\r$/, ""));
        return finishTools(toolAccum, finishReason, usage);
      }
    }
  } catch (err) {
    if (signal.aborted) throw new AbortedError();
    if (responseTimedOut) throw new ApiError("The model exceeded the response deadline. Completed work remains saved. No incomplete tool call was executed. Try /effort low or another model.");
    if (reasoningTimedOut) throw new ApiError("The model made no answer or tool-call progress within the reasoning deadline. Completed work remains saved. No incomplete tool call was executed. Try /effort low or another model.");
    if (idleTimedOut) throw new ApiError("The response stalled and timed out. Try again.");
    throw networkError(err, baseUrl, false);
  } finally {
    clearTimeout(idle);
    clearTimeout(reasoningTimer);
    clearTimeout(responseTimer);
    controller.abort();
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
    if (!slot.name) throw new ApiError("The model returned an incomplete tool call without a name. Nothing from that response was executed.");
    calls.push({ id: slot.id ?? `call_${slot.index}`, name: slot.name!, args: slot.args || "{}" });
  }
  if (calls.length) return { toolCalls: calls, finishReason, usage };
  if (finishReason || usage) return { toolCalls: [], finishReason, usage };
  return undefined;
}

/* ————— agent loop: run tool calls to completion against the API ————— */

export type AgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

export interface AgentHandlers extends StreamHandlers {
  onRecovery?: (message: string) => void;
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
    execute: (name: string, args: Record<string, unknown>) => Promise<{ ok: boolean; output: string; historyEntry?: string }>;
  },
): Promise<string> {
  // 40 rounds ≈ a multi-minute build/setup job. The old cap of 8 made the
  // agent silently stop mid-task ("automode stops working after 5 minutes").
  const maxRounds = options.maxRounds ?? 40;
  let exhausted = false;
  let resumes = 0;
  let permissionBlocked = false;
  const failedEdits = new Map<string, number>();
  const stableArgs = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stableArgs).join(",")}]`;
    if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stableArgs(v)}`).join(",")}}`;
    return JSON.stringify(value) ?? "null";
  };
  const task = [...history].reverse().find(m => m.role === "user")?.content ?? "";
  const actionable = /\b(fix|edit|write|create|make|build|implement|add|update|upgrade|wire|run|test|debug|refactor)\b/i.test(task);
  let lastText = "";
  for (let round = 0; round < maxRounds; round++) {
    exhausted = round === maxRounds - 1;
    if (signal.aborted) throw new AbortedError();
    let roundText = "";
    const res = await streamChatRetry(baseUrl, key, model, history as ChatMessage[], {
      ...handlers,
      onToken: (t) => { roundText += t; handlers.onToken(t); },
    }, signal, { effort: options.effort, tools: options.tools });
    lastText = roundText || lastText;

    const reasoningOnly = !roundText.trim() && res?.finishReason === "length";
    const lastLine = roundText.trim().split("\n").filter(Boolean).at(-1) ?? "";
    const promise = actionable && !!options.tools?.length && !permissionBlocked &&
      !/[?`]/.test(lastLine) && !/\b(cannot|can't|unable|permission|approval|denied|blocked|done|finished|completed)\b/i.test(lastLine) &&
      /^(?:let me|i(?:'ll| will| am going to)|now i(?:'ll| will))\b.{0,100}\b(start|begin|wire|wiring|edit|fix|implement|create|write|run|inspect|read|check|add|update)\b/i.test(lastLine);
    if ((!res || !res.toolCalls.length) && (reasoningOnly || promise)) {
      if (resumes < 2 && round < maxRounds - 1) {
        resumes++;
        handlers.onRecovery?.("The model stopped before acting; requesting an actual tool call.");
        if (roundText.trim()) history.push({ role: "assistant", content: roundText });
        history.push({ role: "user", content: "Continue the original task now. Use an available tool to perform the announced next step, respecting all permissions. If you cannot proceed, clearly state the blocker. Do not end with another promise to act." });
        continue;
      }
      const warning = "\n\n[Model stopped without performing its announced action. Try another model or send continue; no success is implied.]";
      handlers.onToken(warning);
      return lastText + warning;
    }
    if (!res || !res.toolCalls.length) {
      if (!roundText.trim()) {
        const warning = "\n\n[The model ended without an answer or tool call. Completed work remains saved; try /effort low or another model.]";
        handlers.onToken(warning);
        return lastText + warning;
      }
      return lastText;
    }

    // record the assistant's tool_calls message
    history.push({
      role: "assistant",
      content: roundText,
      tool_calls: res.toolCalls.map((c) => ({ id: c.id, type: "function" as const, function: { name: c.name, arguments: c.args } })),
    });

    let repeatedEdit = false;
    for (const call of res.toolCalls) {
      if (signal.aborted) throw new AbortedError();
      let args: Record<string, unknown> | undefined;
      try {
        const parsed = JSON.parse(call.args || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) args = parsed;
      } catch { /* Never execute guessed arguments. */ }
      handlers.onToolCall?.(call.name, call.args);
      const editKey = args && /^(edit_file|write_file)$/.test(call.name) ? `${call.name}:${stableArgs(args)}` : undefined;
      const failures = editKey ? failedEdits.get(editKey) ?? 0 : 0;
      const result = failures > 0 ? { ok: false, output: "This identical file change already failed. Nothing retried. Read the current file and send corrected arguments instead of repeating the failed change." } : args ? await options.execute(call.name, args) :
        { ok: false, output: "Invalid or incomplete tool arguments. Nothing executed. Send a corrected JSON object." };
      if (editKey && !result.ok) {
        failedEdits.set(editKey, failures + 1);
        if (failures > 0) handlers.onRecovery?.("Repeated failed file change blocked; requesting fresh file context and corrected arguments.");
        if (failures >= 2) repeatedEdit = true;
      }
      // A successful change or command may change the file and make an old anchor valid.
      if (result.ok && /^(edit_file|write_file|run_command)$/.test(call.name)) failedEdits.clear();
      if (!result.ok && /declined|approval is unavailable|cancelled|unavailable in .* mode/i.test(result.output)) permissionBlocked = true;
      handlers.onToolResult?.(call.name, result.ok, result.output);
      const evidence: AgentMessage = { role: "tool", tool_call_id: call.id, content: result.output };
      if (result.historyEntry) identifyHistoryEntry(evidence, result.historyEntry);
      history.push(evidence);
    }
    if (repeatedEdit) {
      const warning = "\n\n[Stopped: the model repeated the same failed file change without correcting it. Completed work remains saved. Read the file again or switch models; no success is implied.]";
      handlers.onToken(warning);
      return lastText + warning;
    }
  }
  if (exhausted) {
    const warning = "\n\n[task still in progress — send \"continue\" to keep going]";
    handlers.onToken(warning);
    lastText += warning;
  }
  return lastText;
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
