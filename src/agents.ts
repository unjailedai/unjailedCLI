import { agentTurn, type AgentHandlers, type AgentMessage, type Backoff, type RetryInfo } from "./api.js";
import type { ToolDef } from "./tools.js";
import { WORKFLOW_CONCURRENCY, WORKFLOW_MAX_AGENTS } from "./workflow.js";

/** Subagents: a fresh agent loop with its own context for one focused task. */

export const AGENT_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "agent",
    description:
      "Launch a subagent: a fresh agent with the same file, search and command tools (it cannot launch further subagents or workflows) and an empty context that works autonomously on one focused task and returns a report. " +
      "Use it for independent work that would otherwise flood your context (broad searches, investigating several areas, reviewing a module). " +
      "Several agent calls in the same reply run in parallel. The subagent cannot see this conversation, so the prompt must contain everything it needs: the goal, relevant paths, constraints, and what to report back.",
    parameters: {
      type: "object",
      properties: {
        description: { type: "string", description: "3–6 word label shown to the user, e.g. \"Find auth call sites\"." },
        prompt: { type: "string", description: "The complete, self-contained task for the subagent." },
      },
      required: ["description", "prompt"],
      additionalProperties: false,
    },
  },
};

export const WORKFLOW_TOOL: ToolDef = {
  type: "function",
  function: {
    name: "workflow",
    description:
      "Run a multi-agent workflow: a JavaScript script that orchestrates subagents deterministically (fan out, pipeline, verify). Use it for large tasks that split into independent parts, e.g. review every changed file and then verify each finding. " +
      "Pass either `name` (a saved workflow from .unjailed/workflows) or `script`. A script must begin with `export const meta = { name: \"…\", description: \"…\" }` and may use: " +
      "`await agent(prompt, {label, phase, schema})` → the subagent's final text (or parsed JSON when `schema` is a JSON Schema); " +
      "`await parallel([() => agent(...), ...])` → results array (failed items are null); " +
      "`await pipeline(items, stage1, stage2, ...)` where each stage is `(previous, item, index) => ...` and items progress independently; " +
      "`phase(title)`, `log(message)`, and `args`. `return` a value to report it. " +
      `At most ${WORKFLOW_MAX_AGENTS} agents per run, ${WORKFLOW_CONCURRENCY} at a time. Each agent starts with an empty context: give it complete instructions.`,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "A saved workflow to run." },
        script: { type: "string", description: "The workflow script (when not using name)." },
        args: { description: "Value exposed to the script as `args`." },
      },
      additionalProperties: false,
    },
  },
};

export const SUBAGENT_NOTE = [
  "You are a subagent launched by the main agent to do one focused task. You cannot ask the user anything and nobody will reply to you mid-task.",
  "Work autonomously with your tools until the task is done, then reply with a concise, complete report: what you found or changed, with file paths and line numbers, commands you ran and their results, and anything left unresolved.",
  "Your final reply is handed back verbatim, so it must stand on its own.",
].join("\n");

export interface SubagentActivity {
  state: "waiting" | "thinking" | "writing" | "tool" | "retrying";
  /** The current tool title, or the retry reason. */
  detail?: string;
  /** Prompt tokens summed over the subagent's requests. */
  tokensIn: number;
  /** Completion tokens: reported, plus an estimate for the request in flight. */
  tokens: number;
  /** Reasoning tokens: reported by the server, else estimated from streamed thinking. */
  reasoning: number;
  toolCalls: number;
  /** The end of the subagent's current thinking, for verbose views. */
  thought?: string;
  /** Requests sent (retries included) and transient failures waited out. */
  requests: number;
  retries: number;
}

export interface SubagentRun {
  baseUrl: string;
  key: string;
  model: string;
  systemPrompt: string;
  prompt: string;
  tools: ToolDef[];
  effort?: string;
  maxRounds?: number;
  signal: AbortSignal;
  execute: (name: string, args: Record<string, unknown>, id: string) => Promise<{ ok: boolean; output: string }>;
  describeCall?: (name: string, args: string) => string;
  /** Each tool call the subagent makes (for verbose transcripts). */
  onTool?: (name: string, args: string) => void;
  onActivity?: (a: SubagentActivity) => void;
  onRetry?: (info: RetryInfo) => void;
  /** Retry pacing (tests use a fast one). */
  backoff?: Backoff;
}

export interface SubagentResult {
  text: string;
  toolCalls: number;
  tokens: number;
  end: string;
}

export async function runSubagent(run: SubagentRun): Promise<SubagentResult> {
  const history: AgentMessage[] = [
    { role: "system", content: `${run.systemPrompt}\n\n${SUBAGENT_NOTE}` },
    { role: "user", content: run.prompt },
  ];
  const act: SubagentActivity = { state: "waiting", tokensIn: 0, tokens: 0, reasoning: 0, toolCalls: 0, requests: 0, retries: 0 };
  let completion = 0; // reported completion tokens
  let reportedReasoning = 0;
  let streamedChars = 0; // this request, until its usage arrives
  let reasoningChars = 0;
  const emit = (state?: SubagentActivity["state"], detail?: string) => {
    if (state) {
      act.state = state;
      act.detail = detail;
    }
    act.tokens = completion + Math.round(streamedChars / 4);
    act.reasoning = reportedReasoning + Math.round(reasoningChars / 4);
    run.onActivity?.({ ...act });
  };
  const handlers: AgentHandlers = {
    onRequest: () => { act.requests++; emit("waiting"); },
    onToken: (t) => { streamedChars += t.length; emit(act.state === "writing" ? undefined : "writing"); },
    onReasoning: (t) => {
      streamedChars += t.length;
      reasoningChars += t.length;
      act.thought = ((act.thought ?? "") + t).replace(/\s+/g, " ").slice(-160);
      emit(act.state === "thinking" ? undefined : "thinking");
    },
    onUsage: (u) => {
      act.tokensIn += u.prompt;
      completion += u.completion;
      // Prefer the server's reasoning count; otherwise keep the estimate.
      if (u.reasoning !== undefined) { reportedReasoning += u.reasoning; reasoningChars = 0; }
      else { reportedReasoning += Math.round(reasoningChars / 4); reasoningChars = 0; }
      streamedChars = 0;
      emit();
    },
    onToolCall: (name, args) => {
      act.toolCalls++;
      act.thought = undefined;
      run.onTool?.(name, args);
      emit("tool", run.describeCall ? run.describeCall(name, args) : name);
    },
    onRetry: (info) => { act.retries++; emit("retrying", info.reason); run.onRetry?.(info); },
  };
  const res = await agentTurn(run.baseUrl, run.key, run.model, history, handlers, run.signal, {
    effort: run.effort,
    tools: run.tools,
    maxRounds: run.maxRounds ?? 60,
    backoff: run.backoff,
    execute: run.execute,
  });
  let text = res.text.trim();
  if (!text) text = "(The subagent finished without a written report.)";
  if (res.end === "max-rounds") text += "\n\n[subagent stopped at its round limit; the task may be incomplete]";
  return { text, toolCalls: res.toolCalls, tokens: act.tokens, end: res.end };
}
