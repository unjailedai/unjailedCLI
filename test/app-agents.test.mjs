import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { render, cleanup } from "ink-testing-library";

// Drives the real App against the bundled mock server's scripted agent
// scenarios (see mock/server.mjs → agentScenario).
const home = fs.mkdtempSync(path.join(os.tmpdir(), "unjailed-app-agents-"));
const work = fs.mkdtempSync(path.join(os.tmpdir(), "unjailed-app-work-"));
fs.writeFileSync(path.join(work, "calc.py"), "def add(a,b):\n    return a-b\n");
const port = 18_000 + Math.floor(Math.random() * 2000);
process.env.UNJAILED_HOME = home;
process.env.UNJAILED_API_KEY = "sk-mock-test-a1b2";
process.env.UNJAILED_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.UNJAILED_MODEL = "glm-5.3";
process.env.UNJAILED_NO_FX = "1";
process.env.NO_COLOR = "1";

const mock = spawn(process.execPath, [path.resolve("mock/server.mjs")], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((resolve) => mock.stdout.once("data", resolve));

const { App } = await import("../dist/ui/App.js");
const { writeConfig } = await import("../dist/config.js");
process.chdir(work);

test.after(() => {
  cleanup(); // unmounting also stops any turn still running
  mock.kill();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const all = (ui) => ui.frames.join("\n");
async function waitFor(ui, pattern, label, ms = 15_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pattern.test(all(ui))) return;
    await sleep(40);
  }
  assert.fail(`Timed out waiting for ${label}\n--- last frame ---\n${ui.lastFrame()}`);
}
async function type(ui, text) {
  ui.stdin.write(text);
  await sleep(60);
  ui.stdin.write("\r");
  await sleep(60);
}

test("workflow tool: asks permission in cmds mode, then runs parallel and schema agents", async () => {
  writeConfig({ tools: "cmds", plan: false, autoMode: "ask", fx: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "mock:workflow review please");
    await waitFor(ui, /Permission needed[\s\S]*Workflow\(mock-review\)[\s\S]*Two reviewers in parallel/, "workflow approval with its description");
    await waitFor(ui, /Waiting for your approval/, "the activity bar shows the approval wait");
    await sleep(200);
    ui.stdin.write("y");
    await waitFor(ui, /Done \(3 agents/, "workflow block with agent stats");
    await waitFor(ui, /Worked for/, "turn summary");
    assert.match(all(ui), /mock-review: reports: 2/, "workflow log lines are shown");
    // The model receives the full result (the transcript shows a one-line preview).
    const { listSessions, loadSession } = await import("../dist/sessions.js");
    const saved = loadSession(listSessions()[0].id);
    const wf = saved.toolHistory.find((e) => e.name === "workflow");
    assert.equal(wf.ok, true);
    assert.deepEqual(JSON.parse(wf.output.split("Result:\n")[1].split("\n\nLog:")[0]).verdict, { ok: true, count: 2 }, "the schema agent's JSON is parsed into the result");
  } finally { ui.unmount(); }
});

test("declining a workflow runs nothing and tells the model", async () => {
  writeConfig({ tools: "cmds", plan: false, autoMode: "ask", fx: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "mock:workflow again");
    await waitFor(ui, /Permission needed/, "approval");
    await sleep(200);
    ui.stdin.write("n");
    await waitFor(ui, /Worked for/, "turn end");
    assert.match(all(ui), /declined the workflow/);
    assert.doesNotMatch(all(ui), /Done \(3 agents/);
  } finally { ui.unmount(); }
});

test("parallel subagents show live in the activity panel and report with stats", async () => {
  writeConfig({ tools: "yolo", plan: false, fx: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "mock:agents split it");
    await waitFor(ui, /Inspect left side[\s\S]*Inspect right side/, "both subagents in the live panel");
    await waitFor(ui, /Worked for/, "turn end");
    const out = all(ui);
    assert.equal(out.match(/Done \(1 tool use/g)?.length >= 2, true, "each Agent block has its stats");
    assert.match(out, /Both subagents reported back/);
  } finally { ui.unmount(); }
});

test("/goal keeps working until the evaluator says the goal is met", async () => {
  writeConfig({ tools: "yolo", plan: false, fx: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "/goal mock:goal finish everything");
    await waitFor(ui, /Goal set/, "goal acknowledged");
    await waitFor(ui, /Goal met after 3 turns/, "goal reached after two continuations", 20_000);
    const out = all(ui);
    assert.equal(out.match(/Goal not met yet/g)?.length, 2);
    await type(ui, "/goal");
    await waitFor(ui, /No goal set/, "goal cleared once met");
  } finally { ui.unmount(); }
});

test("a message typed while the agent works is delivered at its next step", async () => {
  writeConfig({ tools: "yolo", plan: false, fx: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "mock:edit fix calc");
    await sleep(80);
    await type(ui, "also keep the old name");
    await waitFor(ui, /Sent to the agent/, "mid-turn acknowledgement");
    await waitFor(ui, /Delivered to the agent mid-turn/, "delivery at the next tool step");
    await waitFor(ui, /Worked for/, "turn end");
    assert.equal(fs.readFileSync(path.join(work, "calc.py"), "utf8"), "def add(a,b):\n    return a+b\n");
    assert.doesNotMatch(all(ui), /Queued — runs when this turn ends/);
  } finally { ui.unmount(); }
});

test("an outage is ridden out with a visible countdown and the turn completes", async () => {
  writeConfig({ tools: "yolo", plan: false, fx: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "mock:outage are you there");
    await waitFor(ui, /retrying automatically/, "outage notice");
    await waitFor(ui, /Reconnecting…[\s\S]*retrying in/, "live retry countdown");
    await waitFor(ui, /Reconnected — continuing[\s\S]*Recovered after the outage[\s\S]*Worked for/, "recovery", 20_000);
  } finally { ui.unmount(); }
});

test("commands queued during a turn don't strand the messages queued after them", async () => {
  writeConfig({ tools: "off", plan: false, fx: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "markdown please");
    await sleep(100);
    await type(ui, "/logout");
    await type(ui, "second message");
    await waitFor(ui, /Queued — runs when this turn ends[\s\S]*Queued — runs when this turn ends/, "both queued");
    await waitFor(ui, /still logged in through the UNJAILED_API_KEY/, "queued command ran", 30_000);
    await waitFor(ui, /You said: "second message"[\s\S]*Worked for/, "the message behind it ran too", 30_000);
  } finally { ui.unmount(); }
});

test("text typed while a permission prompt is open becomes a message, never an answer", async () => {
  writeConfig({ tools: "cmds", plan: false, autoMode: "ask", fx: false });
  fs.writeFileSync(path.join(work, "calc.py"), "def add(a,b):\n    return a-b\n");
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "mock:edit fix calc");
    await waitFor(ui, /Permission needed[\s\S]*Update\(calc\.py\)/, "edit approval");
    await sleep(200);
    // Starts with "k": a draft. The "y" inside it must not approve anything.
    ui.stdin.write("keep it short, yes");
    await sleep(80);
    assert.equal(fs.readFileSync(path.join(work, "calc.py"), "utf8").includes("a+b"), false, "nothing approved by typing");
    assert.match(ui.lastFrame(), /keep it short, yes/, "the draft is visible in the input");
    ui.stdin.write("\r");
    await waitFor(ui, /Sent to the agent/, "draft sent as a mid-task message");
    await sleep(200);
    ui.stdin.write("y");
    await waitFor(ui, /Delivered to the agent mid-turn/, "delivered after the approved step");
    await waitFor(ui, /Permission needed[\s\S]*Bash\(/, "next approval");
    await sleep(200);
    ui.stdin.write("n");
    await waitFor(ui, /Worked for/, "turn end");
    assert.match(fs.readFileSync(path.join(work, "calc.py"), "utf8"), /a\+b/);
  } finally { ui.unmount(); }
});

test("'The model stream was interrupted' is recovered everywhere: main agent mid-reply and every subagent", async () => {
  writeConfig({ tools: "yolo", plan: false, fx: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "mock:flaky please");
    await waitFor(ui, /Both flaky subagents reported back[\s\S]*Worked for/, "turn completes despite interruptions", 40_000);
    const out = all(ui);
    assert.doesNotMatch(out, /Subagent failed/);
    assert.doesNotMatch(out, /✗ The server reported an error/);
    assert.match(out, /Starting the work,/, "the partial reply was kept");
    assert.match(out, /interrupted — resuming where it stopped/, "the resume is visible");
    assert.equal(out.match(/Done \(1 tool use/g)?.length, 2, "both subagents finished");
  } finally { ui.unmount(); }
});

test("a message sent while a batch of tools runs is delivered after the current tool", async () => {
  writeConfig({ tools: "yolo", plan: false, fx: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "mock:batch go");
    await waitFor(ui, /Bash\(sleep 1/, "first tool of the batch started");
    await type(ui, "use the second approach instead");
    await waitFor(ui, /Delivered to the agent mid-turn/, "delivered after the running tool", 15_000);
    await waitFor(ui, /Worked for/, "turn end", 15_000);
    const out = all(ui);
    assert.match(out, /Not run: the user sent a new message/, "the rest of the planned batch was skipped");
    assert.match(out, /Re-planned with your message/);
  } finally { ui.unmount(); }
});

test("/verbose shows the model's thinking, subagent steps and full tool output; off keeps it compact", async () => {
  writeConfig({ tools: "yolo", plan: false, fx: false, verbose: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "mock:think quiet");
    await waitFor(ui, /The folder holds calc\.py/, "compact turn ends");
    await waitFor(ui, /Worked for/, "compact summary");
    let out = all(ui);
    assert.doesNotMatch(out, /First I should list the files/, "thinking hidden when verbose is off");
    assert.doesNotMatch(out, /↳ Deep read/, "subagent steps hidden");
    const before = ui.frames.length;
    await type(ui, "/verbose");
    await waitFor(ui, /Verbose on/, "verbose on");
    await type(ui, "mock:think loud");
    await waitFor(ui, /∴ The user wants a look at this folder\. First I should list the files\./, "main agent thinking in the transcript");
    await waitFor(ui, /↳ Deep read: Read\(calc\.py\)/, "subagent step in the transcript");
    await waitFor(ui, /Worked for[\s\S]*Worked for/, "verbose turn ends");
    out = ui.frames.slice(before).join("\n");
    assert.match(out, /∴ Both results are in/, "thinking after the tools too");
    assert.match(out, /Listed \d+ entr(y|ies)\n\s+\S/, "full tool output under the summary");
    await waitFor(ui, /◆ glm-5\.3[^\n]*verbose/, "footer shows verbose");
    const { readConfig } = await import("../dist/config.js");
    assert.equal(readConfig().verbose, true, "remembered");
    ui.stdin.write("\u000f"); // Ctrl+O
    await waitFor(ui, /Verbose off/, "Ctrl+O toggles");
    assert.equal(readConfig().verbose, false);
  } finally { ui.unmount(); writeConfig({ verbose: false }); }
});

test("/verbose shows live stats during a turn; /stats reports the turn and the session", async () => {
  writeConfig({ tools: "yolo", plan: false, fx: false, verbose: true });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "mock:agents counting");
    await waitFor(ui, /▸ Requests \d+[\s\S]*Tokens ↑[\s\S]*Tools \d+[\s\S]*Session/, "live stats panel");
    await waitFor(ui, /Worked for/, "turn end");
    await type(ui, "/stats");
    await waitFor(ui, /Stats · last turn and session[\s\S]*Requests \d+[\s\S]*Tools 4 \(read 2, agent 2\)[\s\S]*Agents 2 · 2 done[\s\S]*Session 1 turn/, "/stats output");
    await waitFor(ui, /Σ ↑[\d.]+k? ↓\d+/, "session totals in the footer");
  } finally { ui.unmount(); writeConfig({ verbose: false }); }
});

test("the slash menu works while the agent runs; commands run at once unless they would disrupt the turn", async () => {
  writeConfig({ tools: "yolo", plan: false, fx: false, verbose: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "mock:batch go");
    await waitFor(ui, /Bash\(sleep 1/, "turn running");
    ui.stdin.write("/");
    await sleep(120);
    const menu = ui.lastFrame();
    assert.match(menu, /\/model \[id\]\s+Choose a model/, "commands and descriptions are listed mid-turn");
    assert.match(menu, /\/login\s+Log in with your API key · runs when this turn ends/, "disruptive commands are marked");
    assert.doesNotMatch(menu, /\/model \[id\][^\n]*runs when this turn ends/, "the rest are not");
    ui.stdin.write("\x1b"); await sleep(120);
    assert.doesNotMatch(ui.lastFrame(), /Press Esc again to stop/, "Esc closed the menu without arming stop");
    await type(ui, "/stats");
    await waitFor(ui, /Stats · session/, "/stats ran immediately");
    await type(ui, "/effort low");
    await waitFor(ui, /Effort set to low\. Applies from the next turn\./, "settings change at once and say when they apply");
    assert.doesNotMatch(all(ui), /Worked for/, "…all while the turn was still running");
    await type(ui, "/resume");
    await waitFor(ui, /Queued — runs when this turn ends · \/resume/, "disruptive commands wait");
    await waitFor(ui, /Worked for[\s\S]*(Resume a chat|No saved chats|Saved chats)/, "and run after the turn", 15_000);
  } finally { ui.unmount(); writeConfig({ effort: "auto" }); }
});

test("/auto typed mid-run stops the permission prompts for the rest of the running turn", async () => {
  writeConfig({ tools: "cmds", plan: false, autoMode: "ask", fx: false });
  const ui = render(React.createElement(App));
  try {
    await sleep(150);
    await type(ui, "mock:batch three steps");
    await waitFor(ui, /Permission needed[\s\S]*Bash\(sleep 1/, "first approval");
    await sleep(200);
    // Typed into the approval card: becomes a message, sent with Enter, and runs at once.
    ui.stdin.write("/auto"); await sleep(80); ui.stdin.write("\r");
    await waitFor(ui, /\/auto on — the agent makes changes and runs commands without asking/, "auto on mid-run");
    await sleep(100);
    ui.stdin.write("y");
    // The remaining two commands must run without another prompt.
    await waitFor(ui, /Bash\(echo three\)\n\s+⎿\s+three[\s\S]*Worked for/, "rest of the batch ran unattended", 15_000);
  } finally { ui.unmount(); writeConfig({ autoMode: "ask", tools: "yolo" }); }
});
