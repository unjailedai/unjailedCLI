import { streamChatRetry, type ChatMessage } from "./api.js";
import type { ToolEvent } from "./context.js";

/**
 * /goal — keep working until a condition holds.
 *
 * After every turn an evaluator request judges the latest evidence (the
 * prompt, the tool calls and their results, and the reply) against the
 * condition. If it is not met, the agent gets the evaluator's reason and
 * continues on its own. The goal ends when it is met or the user clears it.
 * It pauses (and /goal resume continues it) after `maxTurns` turns (default
 * 20, set with --max N up to 100), or when a turn is stopped, errors, or the
 * check itself fails.
 */
export interface Goal {
  condition: string;
  startedAt: number;
  turns: number;
  maxTurns: number;
  lastReason?: string;
}

export const DEFAULT_GOAL_TURNS = 20;
export const MAX_GOAL_TURNS = 100;
/** Longest goal condition accepted by /goal. */
export const MAX_GOAL_CHARS = 4000;

export interface GoalVerdict {
  met: boolean;
  reason: string;
}

/** "/goal tests pass --max 5" → { condition: "tests pass", maxTurns: 5 } */
export function parseGoalArgs(arg: string): { condition: string; maxTurns: number } | { error: string } {
  let text = arg.trim();
  let maxTurns = DEFAULT_GOAL_TURNS;
  const flag = text.match(/(?:^|\s)--max(?:-turns)?[=\s]+(\d+)\s*$/);
  if (flag) {
    maxTurns = Number(flag[1]);
    text = text.slice(0, flag.index).trim();
    if (maxTurns < 1 || maxTurns > MAX_GOAL_TURNS) return { error: `--max must be between 1 and ${MAX_GOAL_TURNS}.` };
  }
  if (!text) return { error: "Describe the condition, e.g. /goal all tests in npm test pass" };
  if (text.length > MAX_GOAL_CHARS) return { error: `Keep the goal to ${MAX_GOAL_CHARS.toLocaleString("en-US")} characters or fewer (it has ${text.length.toLocaleString("en-US")}).` };
  return { condition: text, maxTurns };
}

const EVALUATOR_SYSTEM = [
  "You are a strict goal evaluator for an autonomous coding agent.",
  "Decide whether the GOAL is fully met, using only the EVIDENCE from the agent's latest turn and earlier turns.",
  "Tool results are facts; the agent's own claims are not proof unless a tool result backs them.",
  "If the evidence is missing, partial, failing, or unverified, the goal is NOT met.",
  'Reply with only a JSON object and nothing else: {"met": true or false, "reason": "one short sentence; when not met, say what is still missing"}',
].join("\n");

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + `…(+${s.length - n} chars)` : s);

/** The evidence block the evaluator sees: bounded so it never dominates cost. */
export function goalEvidence(prompt: string, events: ToolEvent[], reply: string, budget = 14_000): string {
  const parts: string[] = [`LATEST INSTRUCTION:\n${clip(prompt, 4500)}`];
  if (events.length) {
    const recent = events.slice(-25);
    const per = Math.max(200, Math.floor((budget - 6000) / recent.length));
    parts.push(
      "TOOL CALLS THIS TURN (most recent last):\n" +
        recent.map((e, i) => `${i + 1}. ${e.name} ${clip(JSON.stringify(e.args), 300)} → ${e.ok ? "ok" : "FAILED"}\n${clip(e.output, per)}`).join("\n"),
    );
  } else parts.push("TOOL CALLS THIS TURN: none");
  parts.push(`AGENT'S FINAL REPLY:\n${clip(reply || "(no reply text)", 3000)}`);
  return parts.join("\n\n");
}

/** Pull {met, reason} out of a model reply; tolerant of code fences and prose. */
export function parseVerdict(text: string): GoalVerdict | null {
  const body = text.replace(/```(?:json)?/gi, "");
  for (const m of body.matchAll(/\{[\s\S]*?\}/g)) {
    try {
      const v = JSON.parse(m[0]) as { met?: unknown; reason?: unknown };
      if (typeof v.met === "boolean") return { met: v.met, reason: typeof v.reason === "string" && v.reason.trim() ? v.reason.trim().replace(/[.\s]+$/, "") : v.met ? "Condition met" : "Condition not yet met" };
    } catch {
      /* try the next object */
    }
  }
  const loose = body.match(/"?met"?\s*[:=]\s*(true|false)/i);
  if (loose) return { met: loose[1]!.toLowerCase() === "true", reason: "Evaluator gave no reason" };
  return null;
}

export async function evaluateGoal(
  conn: { baseUrl: string; key: string; model: string },
  goal: Goal,
  evidence: string,
  signal: AbortSignal,
): Promise<GoalVerdict> {
  const messages: ChatMessage[] = [
    { role: "system", content: EVALUATOR_SYSTEM },
    { role: "user", content: `GOAL:\n${goal.condition}\n\nEVIDENCE:\n${evidence}` },
  ];
  let text = "";
  await streamChatRetry(conn.baseUrl, conn.key, conn.model, messages, { onToken: (t) => { text += t; } }, signal, { effort: "low" });
  return parseVerdict(text) ?? { met: false, reason: "The evaluator's reply was unreadable; continuing to be safe" };
}

/** The message that sends the agent back to work after a "not met" verdict. */
export function continuationPrompt(goal: Goal, verdict: GoalVerdict): string {
  return [
    `[goal] Keep working toward the goal: ${goal.condition}`,
    `An independent check says it is not met yet: ${verdict.reason}`,
    "Continue from where you are. Verify with tools (run the tests/build/program) before claiming it is done.",
  ].join("\n");
}

/** The first message when a goal is set while idle. */
export function kickoffPrompt(goal: Goal): string {
  return `[goal] Work until this condition is met, verifying with tools as you go: ${goal.condition}`;
}
