import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "unjailed-features-"));
process.env.UNJAILED_HOME = home;
const { parseGoalArgs, parseVerdict, goalEvidence, continuationPrompt, evaluateGoal, DEFAULT_GOAL_TURNS } = await import("../dist/goal.js");
const { parseDuration, parseLoopArgs, formatDuration, clampDynamicDelay, loopSystemNote, DYNAMIC_DEFAULT_S } = await import("../dist/loop.js");
const { runWorkflow, readMeta, extractJson, listWorkflows, loadWorkflow, saveWorkflow, WorkflowError } = await import("../dist/workflow.js");

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

/* ───────────── /goal ───────────── */

test("goal arguments: condition, --max, and validation", () => {
  assert.deepEqual(parseGoalArgs("npm test passes"), { condition: "npm test passes", maxTurns: DEFAULT_GOAL_TURNS });
  assert.deepEqual(parseGoalArgs("all lint errors fixed --max 5"), { condition: "all lint errors fixed", maxTurns: 5 });
  assert.deepEqual(parseGoalArgs("x --max-turns=3"), { condition: "x", maxTurns: 3 });
  assert.ok("error" in parseGoalArgs(""));
  assert.ok("error" in parseGoalArgs("--max 5"));
  assert.ok("error" in parseGoalArgs("x --max 0"));
  assert.ok("error" in parseGoalArgs("x --max 1000"));
  assert.equal(parseGoalArgs("y".repeat(4000)).condition.length, 4000, "4,000 characters are accepted");
  assert.match(parseGoalArgs("y".repeat(4001)).error, /4,000 characters or fewer \(it has 4,001\)/);
  assert.equal(parseGoalArgs("z".repeat(3990) + " --max 5").maxTurns, 5, "--max still parsed on a long goal");
});

test("goal verdicts parse from JSON, fenced JSON, and loose replies", () => {
  assert.deepEqual(parseVerdict('{"met": true, "reason": "Tests pass."}'), { met: true, reason: "Tests pass" });
  assert.deepEqual(parseVerdict('Sure.\n```json\n{"met": false, "reason": "2 tests fail"}\n```'), { met: false, reason: "2 tests fail" });
  assert.equal(parseVerdict('{"note": 1} then {"met": false}').met, false, "skips objects without met");
  assert.equal(parseVerdict("met: true").met, true);
  assert.equal(parseVerdict("I think it's done"), null);
});

test("goal evidence is bounded and marks failed tool calls", () => {
  const events = Array.from({ length: 60 }, (_, i) => ({ id: String(i), name: "run_command", args: { command: `step ${i}` }, ok: i % 2 === 0, output: "x".repeat(5000), at: i }));
  const ev = goalEvidence("make it pass", events, "done");
  assert.ok(ev.length < 20_000, `evidence ${ev.length} chars`);
  assert.match(ev, /FAILED/);
  assert.match(ev, /step 59/, "keeps the most recent calls");
  assert.doesNotMatch(ev, /step 10\b/, "drops old calls");
  assert.match(goalEvidence("p", [], ""), /none[\s\S]*no reply text/);
});

test("evaluateGoal asks a JSON-only evaluator and treats unreadable replies as not met", async () => {
  const original = globalThis.fetch;
  let sent;
  try {
    globalThis.fetch = async (_u, init) => { sent = JSON.parse(init.body); return Response.json({ choices: [{ message: { content: '{"met":true,"reason":"ok"}' } }] }); };
    const v = await evaluateGoal({ baseUrl: "http://x/v1", key: "k", model: "m" }, { condition: "c", turns: 0, maxTurns: 5, startedAt: 0 }, "EVIDENCE", new AbortController().signal);
    assert.equal(v.met, true);
    assert.match(sent.messages[0].content, /strict goal evaluator/);
    assert.equal(sent.tools, undefined, "the evaluator gets no tools");
    globalThis.fetch = async () => Response.json({ choices: [{ message: { content: "no idea" } }] });
    const u = await evaluateGoal({ baseUrl: "http://x/v1", key: "k", model: "m" }, { condition: "c", turns: 0, maxTurns: 5, startedAt: 0 }, "E", new AbortController().signal);
    assert.equal(u.met, false);
  } finally { globalThis.fetch = original; }
  assert.match(continuationPrompt({ condition: "ship it" }, { met: false, reason: "tests fail" }), /ship it[\s\S]*tests fail/);
});

/* ───────────── /loop ───────────── */

test("durations parse in the forms people type", () => {
  assert.equal(parseDuration("30s"), 30_000);
  assert.equal(parseDuration("5m"), 300_000);
  assert.equal(parseDuration("5 min"), 300_000);
  assert.equal(parseDuration("2 hours"), 7_200_000);
  assert.equal(parseDuration("1h30m"), 5_400_000);
  assert.equal(parseDuration("1h 30m"), 5_400_000);
  assert.equal(parseDuration("1.5h"), 5_400_000);
  assert.equal(parseDuration("1d"), 86_400_000);
  for (const bad of ["", "5", "m", "five minutes", "5m check", "0s"]) assert.equal(parseDuration(bad), null, bad);
});

test("loop arguments: leading interval, trailing 'every', self-paced, and errors", () => {
  assert.deepEqual(parseLoopArgs("5m check the deploy"), { prompt: "check the deploy", intervalMs: 300_000 });
  assert.deepEqual(parseLoopArgs("check the deploy every 2h"), { prompt: "check the deploy", intervalMs: 7_200_000 });
  assert.deepEqual(parseLoopArgs("babysit PR 42"), { prompt: "babysit PR 42", intervalMs: null });
  assert.deepEqual(parseLoopArgs("10m /context"), { prompt: "/context", intervalMs: 600_000 });
  assert.deepEqual(parseLoopArgs("5 things to check"), { prompt: "5 things to check", intervalMs: null }, "a number that isn't a duration is part of the prompt");
  assert.deepEqual(parseLoopArgs("2 hours of logs to scan"), { prompt: "2 hours of logs to scan", intervalMs: null }, "spelled-out leading durations are prose");
  assert.deepEqual(parseLoopArgs("1h30m sync"), { prompt: "sync", intervalMs: 5_400_000 });
  assert.deepEqual(parseLoopArgs("5m do 2 things every 2h"), { prompt: "do 2 things every 2h", intervalMs: 300_000 }, "a leading interval wins");
  assert.deepEqual(parseLoopArgs("check 3 files every 10 minutes"), { prompt: "check 3 files", intervalMs: 600_000 });
  assert.ok("error" in parseLoopArgs(""));
  assert.ok("error" in parseLoopArgs("5m"));
  assert.ok("error" in parseLoopArgs("2s ping"), "below the minimum interval");
  assert.ok("error" in parseLoopArgs("30d ping"), "above the maximum interval");
  assert.ok("error" in parseLoopArgs("5m /loop 1m x"), "no nested loops");
});

test("self-paced delays clamp to 1 minute – 1 hour, and durations format compactly", () => {
  assert.equal(clampDynamicDelay(5), 60);
  assert.equal(clampDynamicDelay(99_999), 3600);
  assert.equal(clampDynamicDelay("120"), 120);
  assert.equal(clampDynamicDelay(undefined), DYNAMIC_DEFAULT_S);
  assert.equal(clampDynamicDelay(NaN), DYNAMIC_DEFAULT_S);
  assert.equal(formatDuration(65_000), "1m 5s");
  assert.equal(formatDuration(3_600_000), "1h");
  assert.equal(formatDuration(90_061_000), "1d 1h");
  assert.equal(formatDuration(0), "0s");
  assert.match(loopSystemNote({ prompt: "x", intervalMs: null, iteration: 2 }), /run 2[\s\S]*schedule_next/);
  assert.match(loopSystemNote({ prompt: "x", intervalMs: 60_000, iteration: 1 }), /every 1m; you do not schedule/);
});

/* ───────────── workflows ───────────── */

const fakeAgent = (impl) => {
  const calls = [];
  return { calls, runAgent: async (id, req, signal) => { calls.push({ id, ...req }); return impl(req, signal, id); } };
};

test("workflow: meta, parallel fan-out, pipeline, phases, logs and the return value", async () => {
  const script = `export const meta = { name: "demo", description: "d", phases: [{ title: "A" }] };
phase("A");
const xs = await parallel(["a", "b", "c"].map((x) => () => agent("look at " + x, { label: x, phase: "A" })));
const ys = await pipeline([1, 2], (n) => agent("double " + n), (prev, n, i) => prev + " / " + n + " @" + i);
log("count", xs.length);
return { xs, ys, meta: meta.name, args };`;
  const phases = [];
  const { calls, runAgent } = fakeAgent((req) => `R(${req.prompt})`);
  const res = await runWorkflow({ script, args: { k: 1 }, signal: new AbortController().signal, runAgent, events: { onPhase: (p) => phases.push(p) } });
  assert.equal(res.meta.name, "demo");
  assert.deepEqual(res.result.xs, ["R(look at a)", "R(look at b)", "R(look at c)"]);
  assert.deepEqual(res.result.ys, ["R(double 1) / 1 @0", "R(double 2) / 2 @1"]);
  assert.equal(res.result.meta, "demo");
  assert.deepEqual(res.result.args, { k: 1 });
  assert.equal(res.agents, 5);
  assert.deepEqual(phases, ["A"]);
  assert.deepEqual(res.logs, ["count 3"]);
  assert.deepEqual(calls.slice(0, 3).map((c) => c.label), ["a", "b", "c"]);
});

test("workflow: concurrency is capped and agents beyond the limit are refused", async () => {
  let active = 0, peak = 0;
  const { runAgent } = fakeAgent(async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 30)); active--; return "ok"; });
  const script = `export const meta = { name: "fan" };
return await parallel(Array.from({ length: 10 }, (_, i) => () => agent("t" + i)));`;
  const res = await runWorkflow({ script, signal: new AbortController().signal, runAgent, concurrency: 3 });
  assert.equal(peak, 3);
  assert.equal(res.result.length, 10);
  const over = `export const meta = { name: "over" };
return await parallel(Array.from({ length: 6 }, (_, i) => () => agent("t" + i)));`;
  // The agent limit stops the run even inside parallel(); it is never swallowed as a null.
  await assert.rejects(runWorkflow({ script: over, signal: new AbortController().signal, runAgent, maxAgents: 4 }), /more than 4 agents/);
});

test("workflow: schema agents return parsed JSON; invalid JSON is reported, not thrown", async () => {
  const { calls, runAgent } = fakeAgent((req) => (/good/.test(req.prompt) ? 'Here:\n```json\n{"ok":true,"n":3}\n```' : "not json at all"));
  const script = `export const meta = { name: "s" };
const schema = { type: "object" };
return [await agent("good", { schema }), await agent("bad", { schema })];`;
  const res = await runWorkflow({ script, signal: new AbortController().signal, runAgent });
  assert.deepEqual(res.result[0], { ok: true, n: 3 });
  assert.equal(res.result[1].error, "agent reply was not valid JSON");
  assert.equal(res.failed, 1);
  assert.match(calls[0].prompt, /JSON Schema/);
});

test("workflow: a failing agent yields null in parallel(); errors elsewhere fail the run", async () => {
  const { runAgent } = fakeAgent((req) => { if (/boom/.test(req.prompt)) throw new Error("subagent crashed"); return "fine"; });
  const ok = await runWorkflow({ script: `export const meta = { name: "p" };\nreturn await parallel([() => agent("a"), () => agent("boom")]);`, signal: new AbortController().signal, runAgent });
  assert.deepEqual(ok.result, ["fine", null]);
  assert.match(ok.logs[0], /subagent crashed/);
  await assert.rejects(runWorkflow({ script: `export const meta = { name: "q" };\nreturn await agent("boom");`, signal: new AbortController().signal, runAgent }), /subagent crashed/);
});

test("workflow: script errors, missing meta, misuse and runaway sync loops are reported clearly", async () => {
  const { runAgent } = fakeAgent(() => "x");
  const signal = new AbortController().signal;
  await assert.rejects(runWorkflow({ script: "return 1", signal, runAgent }), /must start with: export const meta/);
  await assert.rejects(runWorkflow({ script: "export const meta = { name: 'x' };\nreturn (", signal, runAgent }), WorkflowError);
  await assert.rejects(runWorkflow({ script: "export const meta = { name: 'x' };\nreturn await parallel([agent('a')]);", signal, runAgent }), /not a function/);
  await assert.rejects(runWorkflow({ script: "export const meta = { name: 'x' };\nreturn await agent('');", signal, runAgent }), /non-empty prompt/);
  await assert.rejects(runWorkflow({ script: "export const meta = { name: 'x' };\nwhile (true) {}", signal, runAgent }), /timed out|Script execution/i);
  await assert.rejects(runWorkflow({ script: "export const meta = { name: 'x' };\nreturn process.exit(1);", signal, runAgent }), /process is not defined/);
});

test("workflow: a script stuck in an async busy loop can still be stopped", async () => {
  const ctrl = new AbortController();
  const { runAgent } = fakeAgent(() => { setTimeout(() => ctrl.abort(), 50); return "x"; });
  const t0 = Date.now();
  await assert.rejects(runWorkflow({ script: `export const meta = { name: "spin" };\nawait agent("a");\nwhile (true) {}`, signal: ctrl.signal, runAgent }), /stopped/i);
  assert.ok(Date.now() - t0 < 3000, "the main thread stayed responsive");
});

test("workflow: listing or approving never executes the script's meta block", async () => {
  const marker = path.join(home, "pwned");
  const evil = `export const meta = { name: this.constructor.constructor("return process")().getBuiltinModule("fs").writeFileSync(${JSON.stringify(marker)}, "x") };`;
  assert.equal(readMeta(evil), null);
  assert.equal(readMeta('export const meta = { name: `a${1}` };'), null, "template expressions are not literals");
  assert.equal(readMeta("export const meta = { name: 'x', __proto__: { polluted: true } };").polluted, undefined);
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "unjailed-wf-evil-"));
  fs.mkdirSync(path.join(cwd, ".unjailed", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".unjailed", "workflows", "evil.js"), evil);
  assert.deepEqual(listWorkflows(cwd).map((w) => w.name), ["evil"]);
  assert.equal(fs.existsSync(marker), false);
  fs.rmSync(cwd, { recursive: true, force: true });
  assert.deepEqual(readMeta(`export const meta = {
    // a comment
    name: 'multi', description: "line \\"two\\"", phases: [{ title: "A", }, ], n: -1.5e2, ok: true, none: null,
  };`), { name: "multi", description: 'line "two"', phases: [{ title: "A" }] });
});

test("workflow: stopping aborts running agents and the run", async () => {
  const ctrl = new AbortController();
  let sawAbort = false;
  const { runAgent } = fakeAgent((_req, signal) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => { sawAbort = true; reject(new Error("aborted")); });
    setTimeout(() => ctrl.abort(), 20); // stop once agents are actually running
  }));
  const p = runWorkflow({ script: `export const meta = { name: "long" };\nreturn await parallel([() => agent("a"), () => agent("b")]);`, signal: ctrl.signal, runAgent });
  await assert.rejects(p, /stopped/i);
  assert.ok(sawAbort);
});

test("workflow helpers: readMeta without running code, extractJson, saved workflows", () => {
  assert.deepEqual(readMeta(`export const meta = { name: "n", description: "has } and \\" inside", phases: [{ title: "T" }] };\nawait agent("x")`), { name: "n", description: 'has } and " inside', phases: [{ title: "T" }] });
  assert.equal(readMeta("const x = 1"), null);
  assert.equal(readMeta("export const meta = { name: require('fs') };"), null, "meta is evaluated with no globals");
  assert.deepEqual(extractJson('prefix {"a": [1, 2]} suffix'), { a: [1, 2] });
  assert.deepEqual(extractJson("[1,2]"), [1, 2]);
  assert.equal(extractJson("nothing"), undefined);

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "unjailed-wf-"));
  const script = `export const meta = { name: "audit", description: "Audit things" };\nreturn 1;`;
  const file = saveWorkflow("audit", script, "project", cwd);
  assert.equal(file, path.join(cwd, ".unjailed", "workflows", "audit.js"));
  assert.throws(() => saveWorkflow("audit", script, "project", cwd), /already exists/);
  assert.throws(() => saveWorkflow("../evil", script, "project", cwd), /names use/);
  assert.throws(() => saveWorkflow("nometa", "return 1", "project", cwd), /meta/);
  saveWorkflow("audit", script.replace("Audit things", "user copy"), "user", cwd);
  const list = listWorkflows(cwd);
  assert.deepEqual(list.map((w) => [w.name, w.scope, w.description]), [["audit", "project", "Audit things"]], "project wins over user");
  assert.match(loadWorkflow("audit", cwd).script, /Audit things/);
  assert.equal(loadWorkflow("missing", cwd), null);
  fs.rmSync(cwd, { recursive: true, force: true });
});
