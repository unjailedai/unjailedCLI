#!/usr/bin/env node
// Mock Unjailed AI API for local development and testing. No dependencies.
//
//   npm run mock                 # listens on http://localhost:8787/v1
//   PORT=9000 npm run mock
//
// Valid API key: sk-mock-test-a1b2 (or set MOCK_KEY). Anything else gets a 401.
//
// Trigger special behaviour by including a word in your chat message:
//   "ratelimit"  → 429        "servererror" → 500        "credit" → 402
//   "slow"       → slow stream (lets you test Ctrl+C)     "hang" → never responds
//   "reason"     → streams reasoning_content before the answer
//   "markdown"   → a long markdown sample with code blocks
//   "longcode"   → an 80-line code block (tests the live-area height cap)
//   "debug"      → reports the reasoning_effort and the active skill names it received
//   "history"    → counts your messages and quotes the first one
//   "usage"      → sends a final usage chunk (123 in / 45 out tokens)
//
// Agent scenarios (scripted tool calls, see agentScenario; all need /tools on except
// mock:tick, mock:goal, mock:drop and mock:outage, and mock:pace inside a self-paced
// /loop, which sends schedule_next even with tools off; mock:workflow needs /tools cmds
// or yolo, the only modes that offer the workflow tool). The mock also answers /goal checks:
// a goal is met once the agent's final reply contains GOAL-DONE.
//   "mock:edit"     read_file → edit_file → run_command → summary (in a folder with calc.py)
//   "mock:agents"   two parallel subagents, then a summary of their reports
//   "mock:workflow" runs a workflow script: two parallel agents + a JSON-schema agent
//   "mock:goal"     replies "step N" until the goal continuation count reaches 2, then GOAL-DONE
//   "mock:stall"    announces a step without a tool call; ask it to "fix" something so the CLI nudges it on
//   "mock:drop"     the first reply is cut off mid-stream (no [DONE]); the CLI should resume it
//   "mock:outage"   the first two requests fail with 503; the CLI should retry and recover
//   "mock:ansi"     runs a command whose output has colors, tabs and carriage returns
//   "mock:tick"     answers "tick N" (for /loop)
//   "mock:emoji"    a reply full of emoji with variation selectors (layout drift)
//   "mock:flaky"    every agent's first request reports "The model stream was interrupted"
//   "mock:batch"    three tool calls in one reply (type a message while the first runs)
//   "mock:think"    the agent and a subagent stream visible reasoning (try /verbose)
//   "mock:pace"     self-paced loop: schedule_next 60s on the first run, stop:true afterwards

import http from "node:http";

const PORT = Number(process.env.PORT || 8787);
const KEY = process.env.MOCK_KEY || "sk-mock-test-a1b2";
const MODELS = ["glm-5.3-uncensored", "glm-5.3", "deepseek-v4-pro-uncensored", "kimi-k3", "mimo-v2.6-pro"];

const MARKDOWN = `Here's a quick tour of what I can render:

**Bold text**, *italics*, and \`inline code\` all work.

1. First numbered item
2. Second item with **emphasis**
   - nested bullet
   - another one

\`\`\`ts
// TypeScript with syntax highlighting
interface User {
  id: number;
  name: string;
}

export function greet(user: User): string {
  return \`Hello, \${user.name}!\`;
}
\`\`\`

\`\`\`python
def fib(n: int) -> int:
    return n if n < 2 else fib(n - 1) + fib(n - 2)
\`\`\`

> Quotes render dimmed.

That's it — ask me anything.`;

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
};
const apiError = (res, status, message, code, headers) => json(res, status, { error: { message, type: "invalid_request_error", code } }, headers);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function authed(req, res) {
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${KEY}`) {
    apiError(res, 401, "Invalid API key. Get yours at https://unjailedai.com/dashboard/api", "invalid_api_key");
    return false;
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve(null);
      }
    });
  });
}

// Split text into small chunks that look like tokens.
const tokens = (text) => text.match(/\s*\S+|\s+/g) ?? [];

const counters = new Map();
const bump = (k) => { const n = (counters.get(k) ?? 0) + 1; counters.set(k, n); return n; };
const call = (name, args, id = `call_${name}_${Math.random().toString(36).slice(2, 8)}`) => ({ id, name, args: JSON.stringify(args) });

// Emoji with and without variation selectors, in prose, lists, tables and code:
// the shapes models use that drift terminal layouts.
const EMOJI_REPLY = [
  "## Status ⚠️ report",
  "",
  "| Check | Result | Note |",
  "|---|---|---|",
  "| Build | ✅ pass | ✔️ clean |",
  "| Lint | ⚠️ warn | ❤️ 3 issues |",
  "| Tests | ❌ fail | ☑️ retry |",
  "",
  "- ✔️ done item with a long tail of text that has to wrap across the terminal width at least once or twice",
  "- ⚠️ warning item",
  "",
  "```text",
  "⚠️ boxed warning line",
  "✅ boxed ok line",
  "```",
  "",
  "Done ✔️.",
].join("\n");

const INTERRUPTED = "The model stream was interrupted. Retry to continue.";

const WORKFLOW_SCRIPT = `export const meta = { name: "mock-review", description: "Two reviewers in parallel, then a JSON verdict", phases: [{ title: "Review" }, { title: "Verdict" }] };
phase("Review");
const reports = await parallel(["alpha", "beta"].map((area) => () => agent("mock-sub review area " + area, { label: "review " + area, phase: "Review" })));
phase("Verdict");
const verdict = await agent("mock-sub json verdict for: " + reports.join(" | "), { label: "verdict", phase: "Verdict", schema: { type: "object", properties: { ok: { type: "boolean" }, count: { type: "number" } } } });
log("reports: " + reports.length);
return { reports, verdict };`;

/** Scripted multi-round agent behaviour. Returns null for the normal echo path. */
function agentScenario(body) {
  const msgs = body.messages;
  const system = msgs.find((m) => m.role === "system")?.content ?? "";
  const lastUserIdx = msgs.map((m) => m.role).lastIndexOf("user");
  const lastUser = String(msgs[lastUserIdx]?.content ?? "");
  // The scenario is chosen by the latest message the person typed; the CLI's own
  // follow-ups (resume/nudge/goal prompts) belong to the same scenario.
  const internal = /^(\[goal\]|\[Sent by the user|Your previous reply was cut off|You hit the output limit|You described a next step|Continue now)/;
  const typed = msgs.filter((m) => m.role === "user" && !internal.test(String(m.content)));
  const goalPrompt = msgs.filter((m) => m.role === "user" && /^\[goal\]/.test(String(m.content))).at(-1)?.content;
  const firstUser = String(goalPrompt && /mock:/.test(goalPrompt) && !/mock:/.test(String(typed.at(-1)?.content ?? "")) ? goalPrompt : typed.at(-1)?.content ?? lastUser);
  // Rounds count from the last message the person typed; mid-task messages
  // and the CLI's own follow-ups don't restart a scenario.
  const internalMsg = /^(\[goal\]|\[Sent by the user|Your previous reply was cut off|You hit the output limit|You described a next step|Continue now)/;
  const typedIdx = msgs.map((m, i) => (m.role === "user" && !internalMsg.test(String(m.content)) ? i : -1)).filter((i) => i >= 0).at(-1) ?? lastUserIdx;
  const toolsSince = msgs.slice((/You are a subagent/.test(system) ? lastUserIdx : typedIdx) + 1).filter((m) => m.role === "tool");
  const allText = msgs.map((m) => m.content ?? "").join("\n");

  if (/strict goal evaluator/i.test(system)) {
    const met = /AGENT'S FINAL REPLY:[\s\S]*GOAL-DONE/.test(lastUser);
    return { text: JSON.stringify({ met, reason: met ? "The agent reported GOAL-DONE." : "GOAL-DONE has not appeared yet." }) };
  }
  // mock:flaky — every agent's first request fails the way the hosted API does:
  // the stream reports "The model stream was interrupted. Retry to continue."
  if (/mock:flaky/.test(String(msgs.find((m) => m.role === "user" && /mock:/.test(String(m.content)))?.content ?? "")) || /mock-flaky/.test(lastUser)) {
    const key = `flaky:${/You are a subagent/.test(system) ? lastUser : "main"}`;
    if (bump(key) === 1) return /You are a subagent/.test(system) ? { streamError: INTERRUPTED } : { text: "Starting the work, ", streamError: INTERRUPTED };
  }
  if (/You are a subagent/.test(system) && /mock-think/.test(lastUser)) {
    if (!toolsSince.length) return { reasoning: "I am the subagent and I am weighing which file to open first, calc.py looks right.", text: "", toolCalls: [call("read_file", { path: "calc.py" })] };
    return { reasoning: "The file is two lines long.", text: "calc.py defines add(a, b)." };
  }
  if (/You are a subagent/.test(system)) {
    if (/json verdict/.test(lastUser)) return { text: "```json\n{\"ok\": true, \"count\": 2}\n```" };
    if (!toolsSince.length) return { text: "Looking around first.", toolCalls: [call("list_dir", { path: "." })] };
    return { text: `Subagent report for "${lastUser.slice(0, 60)}": saw ${toolsSince[0].content.split("\n").length} entries.` };
  }
  if (!body.tools?.length && !/mock:(tick|goal|drop|outage)/.test(firstUser)) return null;
  const round = toolsSince.length;

  if (/mock:edit/.test(firstUser)) {
    if (round === 0) return { text: "Reading the file first.", toolCalls: [call("read_file", { path: "calc.py" })] };
    if (round === 1) return { text: "Found it: `add` subtracts. Fixing:", toolCalls: [call("edit_file", { path: "calc.py", old_text: "    return a-b", new_text: "    return a+b" })] };
    if (round === 2) return { text: "Verifying.", toolCalls: [call("run_command", { command: "python3 -c 'import calc; print(calc.add(2,3))'" })] };
    return { text: "Fixed `calc.py:2` — `add(2, 3)` now prints **5**.\n\n| File | Change |\n|---|---|\n| calc.py | `a-b` → `a+b` |" };
  }
  if (/mock:think/.test(firstUser)) {
    if (round === 0) return { reasoning: "The user wants a look at this folder. First I should list the files.\n\nThen I can delegate a closer read to a subagent.", text: "Looking around.", toolCalls: [call("list_dir", { path: "." }), call("agent", { description: "Deep read", prompt: "mock-think read calc.py closely" })] };
    return { reasoning: "Both results are in; the folder is small and the subagent confirmed it.", text: "The folder holds calc.py and nothing else." };
  }
  if (/mock:batch/.test(firstUser)) {
    // One reply with three tool calls; the first takes a second, leaving time to type.
    if (!msgs.some((m) => m.role === "tool")) return { text: "Running three steps.", toolCalls: [call("run_command", { command: "sleep 1 && echo one" }), call("run_command", { command: "echo two" }), call("run_command", { command: "echo three" })] };
    return { text: /Sent by the user while you were working/.test(allText) ? "Re-planned with your message." : "All three steps ran." };
  }
  if (/mock:flaky/.test(firstUser)) {
    if (round === 0) return { text: "then splitting it across two subagents.", toolCalls: [call("agent", { description: "Flaky left", prompt: "mock-flaky inspect left" }), call("agent", { description: "Flaky right", prompt: "mock-flaky inspect right" })] };
    return { text: `Both flaky subagents reported back:\n\n${toolsSince.map((t) => "- " + t.content.split("\n")[0]).join("\n")}` };
  }
  if (/mock:agents/.test(firstUser)) {
    if (round === 0) return { text: "Splitting this across two subagents.", toolCalls: [call("agent", { description: "Inspect left side", prompt: "mock-sub inspect left" }), call("agent", { description: "Inspect right side", prompt: "mock-sub inspect right" })] };
    return { text: `Both subagents reported back:\n\n${toolsSince.map((t) => "- " + t.content.split("\n")[0]).join("\n")}` };
  }
  if (/mock:workflow/.test(firstUser)) {
    if (round === 0) return { text: "Running a review workflow.", toolCalls: [call("workflow", { script: WORKFLOW_SCRIPT })] };
    return { text: `Workflow done. ${toolsSince[0].content.split("\n")[0]}` };
  }
  if (/mock:goal/.test(firstUser)) {
    const continuations = msgs.filter((m) => m.role === "user" && /^\[goal\] Keep working/.test(m.content)).length;
    return { text: continuations >= 2 ? "All done: GOAL-DONE" : `Working on it — step ${continuations + 1}.` };
  }
  if (/mock:stall/.test(firstUser)) {
    if (/described a next step but did not call a tool/.test(lastUser)) return { text: "Done — the file is fine as it is." };
    return { text: "I checked the file. Now I'll update the tests:" };
  }
  if (/mock:drop/.test(firstUser)) {
    if (bump("drop") === 1) return { text: "This reply is cut off half", drop: true };
    return { text: "-way, and now it is finished." };
  }
  if (/mock:outage/.test(firstUser)) {
    if (bump("outage") <= 2) return { status: 503 };
    return { text: "Recovered after the outage." };
  }
  if (/mock:ansi/.test(firstUser)) {
    if (round === 0) return { text: "Running a noisy command.", toolCalls: [call("run_command", { command: "printf '\\033[31mRED\\033[0m\\tTAB\\n50%%\\r100%% done\\n'" })] };
    return { text: "Output had \u001b[32mcolors\u001b[0m and\ttabs — rendered safely." };
  }
  if (/mock:pace/.test(firstUser)) {
    const runs = bump("pace");
    if (runs === 1) return { text: "First paced run.", toolCalls: [call("schedule_next", { delay_seconds: 60, reason: "checking again in a minute" })] };
    if (round === 0) return { text: "Second run — job finished.", toolCalls: [call("schedule_next", { stop: true, reason: "nothing left to watch" })] };
    return { text: "Stopping the loop." };
  }
  if (/mock:tick/.test(firstUser)) return { text: `tick ${bump("tick")}` };
  if (/mock:emoji/.test(firstUser)) return { text: EMOJI_REPLY };
  return null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const log = (msg) => console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${url.pathname} ${msg}`);

  if (req.method === "GET" && url.pathname === "/v1/models") {
    if (!authed(req, res)) return log("401");
    log("200");
    return json(res, 200, { object: "list", data: MODELS.map((id) => ({ id, object: "model", created: 1735689600, owned_by: "unjailed" })) });
  }

  if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
    if (!authed(req, res)) return log("401");
    const body = await readBody(req);
    if (!body || !Array.isArray(body.messages)) return apiError(res, 400, "messages array is required");
    if (!MODELS.includes(body.model)) return apiError(res, 404, `The model '${body.model}' does not exist.`, "model_not_found");

    const scenario = agentScenario(body);
    if (scenario) {
      log(`scenario turns=${body.messages.length}`);
      if (scenario.status) return apiError(res, scenario.status, "upstream temporarily unavailable");
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      await sleep(250);
      for (const t of tokens(scenario.reasoning ?? "")) { chunk({ reasoning_content: t }); await sleep(25); }
      for (const t of tokens(scenario.text ?? "")) { chunk({ content: t }); await sleep(12); }
      if (scenario.streamError) {
        res.write(`data: ${JSON.stringify({ error: { message: scenario.streamError, type: "server_error" } })}\n\n`);
        res.end();
        return;
      }
      if (scenario.drop) { await sleep(100); res.destroy(); return; }
      (scenario.toolCalls ?? []).forEach((c, index) => chunk({ tool_calls: [{ index, id: c.id, type: "function", function: { name: c.name, arguments: c.args } }] }));
      chunk({}, scenario.toolCalls?.length ? "tool_calls" : "stop");
      res.write(`data: ${JSON.stringify({ id: "mock", choices: [], usage: { prompt_tokens: 1200 + body.messages.length * 50, completion_tokens: 40, total_tokens: 1240 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }

    const last = String(body.messages.at(-1)?.content ?? "");
    const lower = last.toLowerCase();
    log(`model=${body.model} turns=${body.messages.length} "${last.slice(0, 40)}"`);

    if (lower.includes("ratelimit")) return apiError(res, 429, "Rate limit: 30 requests/minute on your tier. Retry in 12s.", "rate_limit", { "retry-after": "12" });
    if (lower.includes("servererror")) return apiError(res, 500, "upstream exploded");
    if (lower.includes("credit")) return apiError(res, 402, "Insufficient credit. Top up at https://unjailedai.com/dashboard.", "insufficient_credit");
    if (lower.includes("hang")) return; // never respond: exercises the client timeout / Ctrl+C

    const userTurns = body.messages.filter((m) => m.role === "user").length;
    let answer;
    if (lower.includes("markdown")) answer = MARKDOWN;
    else if (lower.includes("debug")) {
      const system = body.messages.find((m) => m.role === "system")?.content ?? "";
      const skills = [...system.matchAll(/<skill name="([^"]+)">/g)].map((m) => m[1]);
      answer = `effort: **${body.reasoning_effort ?? "(not sent)"}** · skills: **${skills.join(", ") || "(none)"}**`;
    } else if (lower.includes("history")) answer = `You've sent **${userTurns}** messages in this conversation. The first was: "${body.messages.find((m) => m.role === "user")?.content}"`;
    else answer = `You said: "${last}". I'm the **mock** server running \`${body.model}\` — this is turn ${userTurns}.`;
    if (lower.includes("longcode")) answer = "Here's a long file:\n\n```js\n" + Array.from({ length: 80 }, (_, i) => `console.log("line ${i + 1}");`).join("\n") + "\n```\n\nDone.";
    if (lower.includes("slow")) answer = Array.from({ length: 60 }, (_, i) => `Slow token ${i + 1}.`).join(" ");

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    let closed = false;
    res.on("close", () => (closed = true));
    const send = (delta, finish = null) =>
      res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);

    await sleep(400); // time-to-first-token so the spinner is visible
    if (lower.includes("reason")) {
      for (const t of tokens("Let me think about this carefully before answering.")) {
        if (closed) return log("client closed");
        send({ reasoning_content: t });
        await sleep(60);
      }
    }
    const delay = lower.includes("slow") ? 250 : lower.includes("longcode") ? 8 : 15;
    for (const t of tokens(answer)) {
      if (closed) return log("client closed (stopped)");
      send({ content: t });
      await sleep(delay);
    }
    send({}, "stop");
    if (lower.includes("usage")) {
      // OpenAI sends usage as a final choices-less chunk when stream_options.include_usage is set.
      res.write(`data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", model: body.model, choices: [], usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 } })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  apiError(res, 404, `No route for ${req.method} ${url.pathname}`);
});

server.listen(PORT, () => {
  console.log(`Mock Unjailed API on http://localhost:${PORT}/v1`);
  console.log(`API key: ${KEY}`);
  console.log(`Run the CLI against it:  UNJAILED_BASE_URL=http://localhost:${PORT}/v1 unjailed`);
});
