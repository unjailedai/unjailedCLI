import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { render, cleanup } from "ink-testing-library";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "unjailed-long-session-"));
process.env.UNJAILED_HOME = home;
process.env.UNJAILED_API_KEY = "sk-local-test";
process.env.UNJAILED_MODEL = "kimi-k3";
process.env.UNJAILED_NO_FX = "1";
process.env.NO_COLOR = "1";
const { prepareRequestHistory, trimHistory, streamChat } = await import("../dist/api.js");
const { App } = await import("../dist/ui/App.js");
const { writeConfig } = await import("../dist/config.js");
const { loadSession, listSessions, newSession, saveSession } = await import("../dist/sessions.js");

test.after(() => { cleanup(); fs.rmSync(home, { recursive: true, force: true }); });

test("large plain-chat requests shrink copies and preserve the full source and latest turns", async () => {
  const history = [{ role: "system", content: "Keep project rules" }, { role: "user", content: "Initial task" }];
  for (let i = 0; i < 50; i++) history.push({ role: i % 2 ? "assistant" : "user", content: `${i}:` + "body".repeat(1500) });
  const original = JSON.stringify(history);
  const prepared = prepareRequestHistory(history);
  assert.equal(prepared.trimmed, true);
  assert.equal(JSON.stringify(history), original);
  assert.ok(prepared.messages.reduce((n, m) => n + m.content.length, 0) <= 96_000);
  assert.deepEqual(prepared.messages.slice(-4), history.slice(-4));
  assert.deepEqual(prepared.messages.slice(0, 2), history.slice(0, 2));
  const oldFetch = globalThis.fetch;
  let sent, context, trimEvents = 0, requestEvents = 0;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body).messages;
    return Response.json({ choices: [{ message: { content: "done" } }] });
  };
  try {
    await streamChat("http://local.test/v1", "test", "test", history, { onToken() {}, onRequest(c) { context = c; requestEvents++; }, onContextTrim() { trimEvents++; } }, new AbortController().signal);
    assert.deepEqual(sent, prepared.messages, "plain-chat wire payload uses the shortened copy");
    assert.equal(requestEvents, 1);
    assert.equal(trimEvents, 1);
    assert.equal(context.messages, sent.length);
    assert.ok(context.characters < 96_000, "fallback context estimates the wire copy, not saved history");
    assert.equal(JSON.stringify(history), original);
  } finally { globalThis.fetch = oldFetch; }
});

test("thousands of tiny turns have bounded request count; live tool groups remain paired", () => {
  const history = [{ role: "system", content: "Rules" }];
  for (let i = 0; i < 4_000; i++) {
    history.push({ role: "user", content: `task ${i}` });
    history.push({ role: "assistant", content: "", tool_calls: [{ id: `call-${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] });
    history.push({ role: "tool", content: "ok", tool_call_id: `call-${i}` });
    history.push({ role: "assistant", content: "done" });
  }
  history.push({ role: "user", content: "Current task" });
  const result = prepareRequestHistory(history);
  assert.ok(result.messages.length <= 162, `received ${result.messages.length} messages`);
  assert.equal(result.messages[0].content, "Rules");
  assert.equal(result.messages[1].content, "task 0");
  assert.equal(result.messages.at(-1).content, "Current task");
  const ids = new Set(result.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  assert.ok(result.messages.flatMap((m) => m.tool_calls ?? []).every((c) => ids.has(c.id)));
  assert.equal(history.length, 16_002, "local conversation not shortened");
  const orphan = prepareRequestHistory([{ role: "assistant", content: "Old answer", tool_calls: [{ id: "missing", type: "function", function: { name: "read_file", arguments: "{}" } }] }]);
  assert.equal(orphan.messages[0].tool_calls, undefined);
  const active = [{ role: "user", content: "One live task" }];
  for (let i = 0; i < 200; i++) {
    active.push({ role: "assistant", content: "", tool_calls: [{ id: `a${i}`, type: "function", function: { name: "read_file", arguments: "{}" } }] });
    active.push({ role: "tool", content: "ok", tool_call_id: `a${i}` });
  }
  assert.equal(prepareRequestHistory(active).messages.length, active.length, "large current tool task is retained whole rather than cut into orphan groups");
});

test("trimming serializes each tool payload once instead of rescanning per old result", () => {
  let serializations = 0;
  const history = [{ role: "system", content: "Rules" }, { role: "user", content: "Task" }];
  for (let i = 0; i < 1_000; i++) {
    const fn = { name: "read_file", get arguments() { serializations++; return "{}"; } };
    history.push({ role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: fn }] });
    history.push({ role: "tool", content: "x".repeat(16_000), tool_call_id: `c${i}` });
  }
  trimHistory(history);
  assert.equal(serializations, 1_000, "linear accounting across 1,000 tool rounds");
  assert.equal(history.at(-1).content.length, 16_000, "latest tool output untouched");
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, detail) {
  for (let i = 0; i < 120; i++) { if (predicate()) return; await sleep(25); }
  assert.fail(`Timed out: ${detail}`);
}
async function submit(ui, text) { ui.stdin.write(text); await sleep(80); ui.stdin.write("\r"); await sleep(80); }

test("terminal keeps activity visible after text, waits for approval, and preserves resumable full history", async () => {
  writeConfig({ tools: "cmds", autoMode: "ask", plan: false, fx: false });
  const session = newSession(process.cwd(), "kimi-k3");
  session.messages = [{ role: "user", content: "Original task" }];
  for (let i = 0; i < 24; i++) session.messages.push({ role: i % 2 ? "assistant" : "user", content: `history-${i}:` + "x".repeat(7_000) });
  saveSession(session);
  const oldFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/models")) return Response.json({ data: [{ id: "kimi-k3" }] });
    const request = { body: JSON.parse(init.body), controller: null };
    const body = new ReadableStream({ start(controller) { request.controller = controller; } });
    requests.push(request);
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  const ui = render(React.createElement(App, { startup: "continue" }));
  const send = (request, delta, finish = null) => request.controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`));
  const done = (request) => { request.controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); request.controller.close(); };
  try {
    await sleep(200);
    await submit(ui, "Write a test file");
    await waitFor(() => requests.length === 1 && /Waiting for model/.test(ui.lastFrame()), "first request activity");
    assert.ok(requests[0].body.messages.reduce((n, m) => n + m.content.length, 0) < 96_000);
    send(requests[0], { content: "Checking first.\n\n" });
    await waitFor(() => /Writing.*Ctrl\+C/.test(ui.lastFrame()), "activity remains after visible text is flushed");
    send(requests[0], { tool_calls: [{ index: 0, id: "write-test", function: { name: "write_file", arguments: JSON.stringify({ path: path.join(home, "must-not-exist.txt"), content: "test" }) } }] }, "tool_calls");
    done(requests[0]);
    await waitFor(() => /Waiting for permission/.test(ui.lastFrame()), "explicit approval waiting status");
    await sleep(200);
    ui.stdin.write("n");
    await waitFor(() => requests.length === 2 && /Waiting for model/.test(ui.lastFrame()), "later agent request shows activity after earlier text");
    assert.equal(fs.existsSync(path.join(home, "must-not-exist.txt")), false, "denied write never executes");
    assert.ok(requests[1].body.messages.some((m) => m.role === "tool" && m.tool_call_id === "write-test"), "live round retains its matching result");
    send(requests[1], { content: "Write skipped." }, "stop");
    done(requests[1]);
    await waitFor(() => loadSession(session.id)?.messages.length > session.messages.length, "turn is saved");
    const saved = loadSession(listSessions()[0].id);
    assert.deepEqual(saved.messages.slice(0, session.messages.length), session.messages, "original long transcript remains on disk");
    assert.ok(saved.messages.every((m) => !m.tool_calls), "saved conversation has no orphan calls");
    assert.equal(saved.toolHistory.length, 1);
    assert.equal(saved.toolHistory[0].ok, false, "denied actions are archived as failed, not performed");
    await submit(ui, "/remember Never remove the sapphire configuration");
    await waitFor(() => loadSession(session.id)?.notes?.length === 1, "session note saves");
    await submit(ui, "Continue reading");
    await waitFor(() => requests.length === 3, "following turn");
    assert.ok(requests[2].body.messages.every((m) => !m.tool_calls && m.role !== "tool"), "following turn has a clean chat transcript");
    assert.ok(requests[2].body.tools.some(t => t.function.name === "search_history"), "read-only exact history recovery is available");
    assert.ok(requests[2].body.messages.some(m => m.content.includes("failed/skipped") && m.content.includes("Nothing executed")), "the next turn retains actual denied tool evidence");
    assert.ok(requests[2].body.messages.some(m => m.content.includes("Never remove the sapphire configuration")), "pinned requirements stay in request context");
    send(requests[2], { tool_calls: [{ index: 0, id: "history-test", function: { name: "search_history", arguments: JSON.stringify({ entry: "tool:" + saved.toolHistory[0].id, length: 12000 }) } }] }, "tool_calls");
    done(requests[2]);
    await waitFor(() => requests.length === 4, "history retrieval completes");
    const result = requests[3].body.messages.find(m => m.role === "tool" && m.tool_call_id === "history-test");
    assert.match(result.content,/must-not-exist.txt/);
    assert.match(result.content,/Nothing executed/);
    assert.equal(fs.existsSync(path.join(home, "must-not-exist.txt")), false, "history recovery never performs an old action");
    send(requests[3], { content: "Finished." }, "stop");
    done(requests[3]);
    await waitFor(() => loadSession(session.id)?.messages.at(-1)?.content === "Finished.", "follow-up ends");
    ui.unmount(); ui.cleanup();
    const resumed = render(React.createElement(App, { startup: "continue" }));
    try {
      await sleep(200);
      await submit(resumed, "Recover our previous skipped write");
      await waitFor(() => requests.length === 5, "resumed request");
      assert.ok(requests[4].body.messages.some(m => m.content.includes("Never remove the sapphire configuration")));
      assert.ok(requests[4].body.messages.some(m => m.content.includes("failed/skipped") && m.content.includes("must-not-exist.txt")), "exact tool evidence persists across process-style resume");
      send(requests[4], { content: "Recovered safely." }, "stop");
      done(requests[4]);
      await waitFor(() => loadSession(session.id)?.messages.at(-1)?.content === "Recovered safely.", "resumed save");
    } finally { resumed.unmount(); resumed.cleanup(); }
  } finally {
    for (const request of requests) { try { request.controller.close(); } catch {} }
    ui.unmount(); ui.cleanup(); globalThis.fetch = oldFetch;
  }
});

test('a completed tool and its task survive a model error before any assistant prose', async () => {
  writeConfig({ tools:'read', plan:false, fx:false });
  const file=path.join(home,'read-before-error.txt');fs.writeFileSync(file,'unique cobalt evidence');
  const oldFetch=globalThis.fetch;
  let calls=0;
  globalThis.fetch=async (url) => {
    if(String(url).endsWith('/models'))return Response.json({data:[{id:'kimi-k3'}]});
    calls++;
    if(calls===1)return Response.json({choices:[{message:{tool_calls:[{id:'read-before-error',function:{name:'read_file',arguments:JSON.stringify({path:file})}}]}}]});
    return Response.json({error:{message:'Local test model disconnected'}},{status:400});
  };
  const ui=render(React.createElement(App));
  try {
    await sleep(200);await submit(ui,'Read cobalt evidence');
    await waitFor(()=>listSessions().some(meta=>meta.title==='Read cobalt evidence'),'failed response task saves');
    const saved=loadSession(listSessions().find(meta=>meta.title==='Read cobalt evidence').id);
    assert.equal(saved.messages[0].content,'Read cobalt evidence');
    assert.equal(saved.toolHistory[0].ok,true);
    assert.match(saved.toolHistory[0].output,/unique cobalt evidence/);
    assert.equal(saved.messages.some(m=>m.role==='assistant'),false,'no invented assistant response');
  } finally { ui.unmount();ui.cleanup();globalThis.fetch=oldFetch; }
});
