// Unit + integration tests against the built dist/ and the mock server.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "unjailed-test-"));
process.env.UNJAILED_HOME = home;
process.env.NO_COLOR = "1";
delete process.env.UNJAILED_API_KEY;

const PORT = 18000 + Math.floor(Math.random() * 1000);
const BASE = `http://localhost:${PORT}/v1`;
const KEY = "sk-mock-test-a1b2";
let mock;

const { listModels, streamChat, ApiError, AbortedError } = await import("../dist/api.js");
const config = await import("../dist/config.js");
const { filterCommands, parseCommand } = await import("../dist/commands.js");
const { renderMarkdown } = await import("../dist/markdown.js");

before(async () => {
  mock = spawn(process.execPath, ["mock/server.mjs"], { env: { ...process.env, PORT: String(PORT) }, stdio: "pipe" });
  await new Promise((resolve) => mock.stdout.once("data", resolve));
});
after(() => {
  mock.kill();
  fs.rmSync(home, { recursive: true, force: true });
});

test("maskKey never reveals more than the last 4 chars", () => {
  assert.equal(config.maskKey("sk-mock-test-a1b2"), "sk-…a1b2");
  assert.equal(config.maskKey("short"), "…");
  assert.equal(config.maskKey(null), "none");
});

test("config saves with 0600 and env overrides file", () => {
  config.writeConfig({ apiKey: "sk-file-1111", model: "kimi-k3" });
  if (process.platform !== "win32") assert.equal(fs.statSync(config.configPath()).mode & 0o777, 0o600);
  assert.deepEqual(config.resolveKey(), { key: "sk-file-1111", source: "config" });
  process.env.UNJAILED_API_KEY = "sk-env-2222";
  assert.deepEqual(config.resolveKey(), { key: "sk-env-2222", source: "env" });
  delete process.env.UNJAILED_API_KEY;
  config.deleteKey();
  assert.deepEqual(config.resolveKey(), { key: null, source: null });
  assert.equal(config.readConfig().model, "kimi-k3", "logout keeps the model choice");
});

test("legacy uj auth.json is honoured", () => {
  fs.writeFileSync(path.join(home, "auth.json"), JSON.stringify({ key: "sk-legacy-3333" }));
  assert.equal(config.resolveKey().key, "sk-legacy-3333");
  config.deleteKey();
  assert.equal(config.resolveKey().key, null);
});

test("slash command parsing and filtering", () => {
  assert.deepEqual(parseCommand("/model kimi-k3"), { name: "model", arg: "kimi-k3" });
  assert.equal(parseCommand("hello"), null);
  assert.equal(filterCommands("lo")[0].name, "login");
  assert.deepEqual(filterCommands("log").map((c) => c.name), ["login", "logout"]);
  assert.equal(filterCommands("zzz").length, 0);
});

test("markdown renders lists, code and partial fences without throwing", () => {
  const out = renderMarkdown("**hi** `x`\n- a\n1. b\n```js\nconst a = 1;");
  assert.match(out, /hi/);
  assert.match(out, /• a/);
  assert.match(out, /1\. b/);
  assert.match(out, /const a = 1;/);
});

test("markdown renders GitHub tables with aligned columns", () => {
  const out = renderMarkdown("| Model | Price |\n|:--|--:|\n| glm | $0.75 |\n| kimi-k3 | $1 |");
  const lines = out.split("\n");
  assert.equal(lines.length, 4);
  assert.match(lines[0], /^Model\s+│ Price$/);
  assert.match(lines[1], /^─+┼─+$/);
  assert.match(lines[3], /^kimi-k3 │\s+\$1$/);
});

test("GET /models validates keys", async () => {
  const models = await listModels(BASE, KEY);
  assert.ok(models.some((m) => m.id === "kimi-k3"));
  await assert.rejects(listModels(BASE, "sk-bad"), (e) => e instanceof ApiError && e.status === 401 && /login/.test(e.message));
});

test("chat streams token by token with history", async () => {
  const tokens = [];
  await streamChat(BASE, KEY, "kimi-k3", [{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: "history?" }], { onToken: (t) => tokens.push(t) }, new AbortController().signal);
  assert.ok(tokens.length > 3);
  assert.match(tokens.join(""), /sent \*\*2\*\* messages/);
});

test("friendly errors: 429, 500, network down, timeout", async () => {
  const run = (content, base = BASE) => streamChat(base, KEY, "kimi-k3", [{ role: "user", content }], { onToken() {} }, new AbortController().signal);
  await assert.rejects(run("ratelimit"), (e) => e instanceof ApiError && e.status === 429 && /Retry in 12s/.test(e.message));
  await assert.rejects(run("servererror"), (e) => e instanceof ApiError && /server had a problem/.test(e.message));
  await assert.rejects(run("hi", "http://localhost:1/v1"), (e) => e instanceof ApiError && !/stack/i.test(e.message));
});

test("abort stops a stream", async () => {
  const ctrl = new AbortController();
  let n = 0;
  const p = streamChat(BASE, KEY, "kimi-k3", [{ role: "user", content: "slow" }], { onToken: () => ++n === 2 && ctrl.abort() }, ctrl.signal);
  await assert.rejects(p, (e) => e instanceof AbortedError);
});

const { agentSystemPrompt, environmentBlock } = await import("../dist/system-prompt.js");

test("agent system prompt: environment + finish-the-task contract, mode-aware", () => {
  const read = agentSystemPrompt("read", "ask");
  const cmds = agentSystemPrompt("cmds", "ask");
  const yolo = agentSystemPrompt("yolo", "auto");

  // always present: identity, environment facts, and the "don't stop early" contract
  for (const p of [read, cmds, yolo]) {
    assert.match(p, /autonomous coding agent/i);
    assert.match(p, /Working directory:/);
    assert.match(p, /Finish the whole task/i);
    assert.match(p, /run_command runs through/);
  }

  // read mode must NOT claim it can run commands or write files
  assert.match(read, /read-only mode/i);
  assert.doesNotMatch(read, /Verify your work/i);

  // cmds/yolo get the verify-your-work step and OS command guidance
  assert.match(cmds, /Verify your work/i);
  assert.match(cmds, /Commands:/);

  // confirmation wording differs by autonomy
  assert.match(cmds, /shown to the user to approve/i);
  assert.match(yolo, /without a confirmation prompt/i);
});

test("environment block names this OS and never crashes", () => {
  const env = environmentBlock("/tmp/x");
  const expected = process.platform === "win32" ? /Windows/ : process.platform === "darwin" ? /macOS/ : /Linux/;
  assert.match(env, expected);
  assert.match(env, /Working directory: \/tmp\/x/);
});

// ── markdown: boxed code blocks + html normalisation (renderMarkdown already imported above) ──
test("markdown draws a bordered box around fenced code with a language label", () => {
  const out = renderMarkdown("```js\nconst a = 1;\n```", { width: 50 });
  const lines = out.split("\n");
  assert.match(lines[0], /^╭─ js ─+╮$/);                 // header bar names the language
  assert.match(lines[lines.length - 1], /^╰─+╯$/);        // closed bottom border
  assert.ok(lines.some((l) => /^│ .*const a = 1;.* │$/.test(l)), "code sits inside the box");
  // every box line is the same visible width → right border lines up
  const widths = new Set(lines.map((l) => l.length));
  assert.equal(widths.size, 1);
});

test("markdown boxes a partial (unclosed) fence without throwing", () => {
  let out;
  assert.doesNotThrow(() => { out = renderMarkdown("```python\nprint(1)", { width: 40 }); });
  assert.match(out, /^╭─ python/);
  assert.match(out, /print\(1\)/);
});

test("markdown strips leaked html tags but keeps generics/comparisons", () => {
  const out = renderMarkdown("a <div>x</div> <br> and List<int> with 1 < 2");
  assert.doesNotMatch(out, /<div>|<\/div>|<br>/);
  assert.match(out, /List<int>/);
  assert.match(out, /1 < 2/);
});

const { trimHistory } = await import("../dist/api.js");

test("trimHistory shrinks old context without deleting messages or breaking tool pairing", () => {
  const h = [{ role: "system", content: "SYS ".repeat(100) }, { role: "user", content: "do the thing" }];
  for (let r = 0; r < 25; r++) {
    h.push({ role: "assistant", content: `r${r}`, tool_calls: [{ id: `c${r}`, type: "function", function: { name: "read_file", arguments: "{}" } }] });
    h.push({ role: "tool", tool_call_id: `c${r}`, content: "y".repeat(16000) });
  }
  h.push({ role: "user", content: "finish now" });

  const callIds = h.filter((m) => m.tool_calls).flatMap((m) => m.tool_calls.map((t) => t.id));
  const beforeLen = h.length;
  const beforeChars = h.reduce((n, m) => n + (m.content?.length ?? 0), 0);

  trimHistory(h);

  const afterChars = h.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  const toolIds = new Set(h.filter((m) => m.role === "tool").map((m) => m.tool_call_id));

  assert.equal(h.length, beforeLen, "no messages deleted (pairing preserved)");
  assert.ok(callIds.every((id) => toolIds.has(id)), "every tool_call still has its tool result");
  assert.ok(afterChars < beforeChars, "history got smaller");
  assert.ok(afterChars <= 260_000, "under the budget");
  assert.ok(h[0].role === "system" && h[0].content.startsWith("SYS "), "system message intact");
  assert.equal(h[h.length - 1].content, "finish now", "most recent user turn intact");
});

const { repairToolPairing, toPlainChat } = await import("../dist/api.js");
const { planSteps } = await import("../dist/ui/plan.js");

test("repairToolPairing keeps answered calls and reduces half-answered ones to text", () => {
  const call = (id) => ({ id, type: "function", function: { name: "read_file", arguments: "{}" } });
  const h = [
    { role: "user", content: "go" },
    { role: "assistant", content: "", tool_calls: [call("a")] },
    { role: "tool", tool_call_id: "a", content: "ok" },
    { role: "assistant", content: "two at once", tool_calls: [call("b"), call("c")] },
    { role: "tool", tool_call_id: "b", content: "ok" }, // c never answered (turn cancelled)
    { role: "tool", tool_call_id: "zzz", content: "orphan" },
    { role: "user", content: "next" },
  ];
  repairToolPairing(h);
  assert.deepEqual(h.map((m) => m.role), ["user", "assistant", "tool", "assistant", "user"]);
  assert.equal(h[3].content, "two at once");
  assert.equal(h[3].tool_calls, undefined);
});

test("toPlainChat drops tool traffic and merges adjacent assistant text", () => {
  const plain = toPlainChat([
    { role: "user", content: "make it" },
    { role: "assistant", content: "Writing.", tool_calls: [{ id: "a", type: "function", function: { name: "write_file", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "a", content: "Wrote 3 chars" },
    { role: "assistant", content: "Done." },
  ]);
  assert.deepEqual(plain, [{ role: "user", content: "make it" }, { role: "assistant", content: "Writing.\n\nDone." }]);
});

test("planSteps accepts markdown numbering and rejects drafts without a step 1", () => {
  assert.deepEqual(planSteps("**1.** Read app.py\n**2.** Fix the bug"), ["1. Read app.py", "2. Fix the bug"]);
  assert.deepEqual(planSteps("Here's the plan:\nStep 1: inspect\nStep 2) edit"), ["1. inspect", "2. edit"]);
  assert.deepEqual(planSteps("- 1) a\n- 2) b"), ["1. a", "2. b"]);
  assert.deepEqual(planSteps("I will just do it."), []);
  assert.deepEqual(planSteps("2. starts late"), []);
  assert.equal(planSteps(Array.from({ length: 12 }, (_, i) => `${i + 1}. s`).join("\n")).length, 8);
});

test("streamChat surfaces server token usage via onUsage and the result", async () => {
  let got = null;
  const res = await streamChat(BASE, KEY, "kimi-k3", [{ role: "user", content: "usage please" }], { onToken() {}, onUsage: (u) => (got = u) }, new AbortController().signal);
  assert.deepEqual(got, { prompt: 123, completion: 45, total: 168 });
  assert.deepEqual(res?.usage, { prompt: 123, completion: 45, total: 168 });
});

test("streamChat without usage leaves onUsage uncalled and doesn't crash", async () => {
  let called = false;
  await streamChat(BASE, KEY, "kimi-k3", [{ role: "user", content: "plain hi" }], { onToken() {}, onUsage: () => (called = true) }, new AbortController().signal);
  assert.equal(called, false);
});
