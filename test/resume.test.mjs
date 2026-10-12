import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { render, cleanup } from "ink-testing-library";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "unjailed-resume-"));
process.env.UNJAILED_HOME = home;
process.env.UNJAILED_API_KEY = "sk-local-test";
process.env.UNJAILED_MODEL = "kimi-k3";
process.env.UNJAILED_NO_FX = "1";
process.env.NO_COLOR = "1";
process.env.UNJAILED_AUTOSAVE_SECONDS = "1";
const { App } = await import("../dist/ui/App.js");
const { writeConfig } = await import("../dist/config.js");
const { appendSession, listSessions, loadSession, newSession } = await import("../dist/sessions.js");

test.after(() => { cleanup(); fs.rmSync(home, { recursive: true, force: true }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const all = (ui) => ui.frames.join("\n");
async function waitFor(ui, re, label, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (re.test(all(ui))) return; await sleep(30); }
  assert.fail(`Timed out waiting for ${label}\n${ui.lastFrame()}`);
}

test("a turn in progress is saved continuously: prompt at once, partial reply by the autosave timer", async () => {
  writeConfig({ tools: "off", plan: false, fx: false });
  const original = globalThis.fetch;
  let controller;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "kimi-k3" }] });
    return new Response(new ReadableStream({ start(c) { controller = c; } }), { headers: { "content-type": "text/event-stream" } });
  };
  const ui = render(React.createElement(App));
  const send = (content) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`));
  try {
    await sleep(150);
    ui.stdin.write("write me a long essay"); await sleep(60); ui.stdin.write("\r");
    await sleep(400);
    const saved = () => { const meta = listSessions()[0]; return meta && loadSession(meta.id); };
    assert.equal(saved()?.messages[0]?.content, "write me a long essay", "the prompt is saved before any reply");
    assert.equal(saved()?.pending?.partial, "", "the turn is marked as in progress");
    for (let i = 0; i < 25; i++) { send(`word${i} `); await sleep(100); }
    assert.match(saved()?.pending?.partial ?? "", /word0 word1 .*word1\d/, "the autosave timer keeps the partial reply current");
    controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`));
    controller.close();
    await waitFor(ui, /Worked for/, "turn end");
    await sleep(200);
    assert.equal(saved().pending, undefined, "a finished turn clears the in-progress marker");
    assert.match(saved().messages.at(-1).content, /word24$/);
  } finally { ui.unmount(); globalThis.fetch = original; }
});

test("/resume restores a chat that was killed mid-run: tools in place, partial reply, goal, loop, notes and ↑ history", async () => {
  const cwd = process.cwd();
  const s = newSession(cwd, "kimi-k3");
  Object.assign(s, {
    title: "Fix the parser",
    messages: [{ role: "user", content: "Fix the parser" }, { role: "assistant", content: "Fixed it." }, { role: "user", content: "Now add tests" }],
    toolHistory: [
      { id: "t1", name: "read_file", args: { path: "parser.ts" }, ok: true, output: "a\nb", at: 1, turn: 1 },
      { id: "t2", name: "edit_file", args: { path: "parser.ts", old_text: "a", new_text: "c" }, ok: true, output: "ok", at: 2, turn: 3 },
    ],
    notes: ["never touch the lexer"],
    pending: { startedAt: Date.now() - 5000, partial: "Adding tests for the empty-input case and" },
    goal: { condition: "all parser tests pass", turns: 2, maxTurns: 20, startedAt: Date.now() - 60_000, lastReason: "two tests fail" },
    loop: { prompt: "check CI", intervalMs: 300_000, iteration: 4 },
    inputs: ["Fix the parser", "Now add tests"],
  });
  await appendSession(s);
  writeConfig({ tools: "cmds", plan: false, fx: false });
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [{ id: "kimi-k3" }] });
  const ui = render(React.createElement(App, { startup: "continue" }));
  try {
    await waitFor(ui, /Resumed "Fix the parser"/, "resume note");
    const out = all(ui);
    // Transcript order: prompt, its tool, reply, next prompt, its tool, the interrupted partial.
    const order = ["› Fix the parser", "Read(parser.ts)", "Fixed it.", "› Now add tests", "Update(parser.ts)", "Adding tests for the empty-input case and", "This reply was interrupted"];
    let at = -1;
    for (const piece of order) { const i = out.indexOf(piece, at + 1); assert.ok(i > at, `"${piece}" in order`); at = i; }
    assert.match(out, /interrupted mid-run/);
    assert.match(out, /Goal restored \(paused\): all parser tests pass/);
    assert.match(out, /Loop restored \(paused\): check CI/);
    assert.match(out, /1 pinned note restored/);
    await waitFor(ui, /› Continue where you left off\./, "continue prompt pre-filled");
    // ↑ history from the saved chat
    ui.stdin.write("\x15"); await sleep(50); // clear the line (Ctrl+U)
    ui.stdin.write("\x1b[A"); await sleep(80);
    assert.match(ui.lastFrame(), /Now add tests/);
    await sleep(300);
    const resaved = loadSession(s.id);
    assert.equal(resaved.pending, undefined, "the restored partial became part of the history");
    assert.match(resaved.messages.at(-1).content, /Adding tests for the empty-input case and[\s\S]*interrupted/);
    assert.equal(resaved.goal.condition, "all parser tests pass", "the paused goal stays saved");
  } finally { ui.unmount(); globalThis.fetch = original; }
});

test("↑ history in a new session starts from the latest chat in this folder", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [{ id: "kimi-k3" }] });
  const ui = render(React.createElement(App));
  try {
    await sleep(200);
    ui.stdin.write("\x1b[A"); await sleep(80);
    assert.match(ui.lastFrame(), /Now add tests|write me a long essay/);
  } finally { ui.unmount(); globalThis.fetch = original; }
});
