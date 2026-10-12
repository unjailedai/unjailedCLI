import { test } from "node:test";
import assert from "node:assert/strict";
import { agentTurn, announcesNextStep, backoffMs, isTransient, streamChatRetry, ApiError, AbortedError } from "../dist/api.js";

const enc = new TextEncoder();
const sse = (obj) => enc.encode(`data: ${JSON.stringify(obj)}\n\n`);
const delta = (d, finish = null) => sse({ choices: [{ delta: d, finish_reason: finish }] });

/** A scripted fetch: each call takes the next handler from `script`. */
function scriptedFetch(script) {
  const requests = [];
  const fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    const step = script[requests.length - 1];
    if (!step) throw new Error(`unexpected request #${requests.length}`);
    return step(body);
  };
  return { fetch, requests };
}

/** An SSE response that sends `chunks`, then [DONE] (unless `end` says otherwise). */
function stream(chunks, end = "done") {
  return () => new Response(new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      if (end === "done") c.enqueue(enc.encode("data: [DONE]\n\n"));
      // A real socket delivers what it received before failing; error after a tick.
      if (end === "error") setTimeout(() => c.error(Object.assign(new TypeError("terminated"), { cause: { code: "UND_ERR_SOCKET" } })), 20);
      else c.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}
const text = (t, finish = "stop") => stream([delta({ content: t }), delta({}, finish)]);
const status = (code, headers = {}) => () => Response.json({ error: { message: "upstream" } }, { status: code, headers });
const toolCall = (calls, prose = "") => stream([...(prose ? [delta({ content: prose })] : []), delta({ tool_calls: calls.map((c, index) => ({ index, id: c.id, function: { name: c.name, arguments: c.args } })) }), delta({}, "tool_calls")]);

async function withFetch(script, fn) {
  const { fetch, requests } = scriptedFetch(script);
  const original = globalThis.fetch;
  globalThis.fetch = fetch;
  try { return await fn(requests); } finally { globalThis.fetch = original; }
}

const run = (history, extra = {}, handlers = {}) => {
  const notices = [];
  const retries = [];
  let streamed = "";
  return agentTurn("http://local.test/v1", "k", "m", history, {
    onToken: (t) => { streamed += t; },
    onNotice: (n) => notices.push(n),
    onRetry: (r) => retries.push(r),
    ...handlers,
  }, extra.signal ?? new AbortController().signal, { backoff: extra.slow ? undefined : () => 5, ...extra }).then((r) => ({ ...r, notices, retries, streamed }));
};

test("a stream that closes without [DONE] mid-reply is resumed, not treated as finished", async () => {
  await withFetch([stream([delta({ content: "The answer is forty" })], "close"), text("-two.")], async (requests) => {
    const r = await run([{ role: "user", content: "q" }]);
    assert.equal(r.end, "done");
    assert.equal(r.streamed, "The answer is forty-two.");
    assert.equal(requests.length, 2);
    const resumeAsk = requests[1].messages.at(-1);
    assert.equal(resumeAsk.role, "user");
    assert.match(resumeAsk.content, /cut off/);
    assert.deepEqual(requests[1].messages.at(-2), { role: "assistant", content: "The answer is forty" });
    assert.equal(r.notices.length, 1, "exactly one visible notice");
  });
});

test("a network error after text has streamed resumes from the partial reply", async () => {
  await withFetch([stream([delta({ content: "Partial" })], "error"), text(" rest")], async (requests) => {
    const r = await run([{ role: "user", content: "q" }]);
    assert.equal(r.streamed, "Partial rest");
    assert.equal(requests.length, 2);
    assert.match(requests[1].messages.at(-1).content, /cut off/);
  });
});

test("transient HTTP errors are retried with backoff until the service recovers", async () => {
  await withFetch([status(503), status(502), text("back")], async (requests) => {
    const t0 = Date.now();
    const r = await run([{ role: "user", content: "q" }], { slow: true });
    assert.equal(r.streamed, "back");
    assert.equal(requests.length, 3);
    assert.equal(r.retries.length, 2);
    assert.deepEqual(r.retries.map((x) => x.attempt), [1, 2]);
    assert.ok(Date.now() - t0 >= 2_000, "waited roughly 1s + 2s");
  });
});

test("Retry-After on 429 is honoured", async () => {
  await withFetch([status(429, { "retry-after": "1" }), text("ok")], async () => {
    const r = await run([{ role: "user", content: "q" }], { slow: true });
    assert.equal(r.retries[0].delayMs, 1000);
    assert.equal(r.streamed, "ok");
  });
});

test("permanent errors are not retried", async () => {
  for (const code of [400, 401, 402, 404]) {
    await withFetch([status(code)], async (requests) => {
      await assert.rejects(run([{ role: "user", content: "q" }]), ApiError);
      assert.equal(requests.length, 1, `HTTP ${code} is final`);
    });
  }
});

test("stopping during a backoff wait aborts promptly", async () => {
  await withFetch([status(503), status(503), status(503)], async () => {
    const ctrl = new AbortController();
    const p = run([{ role: "user", content: "q" }], { signal: ctrl.signal, slow: true }, { onRetry: () => setTimeout(() => ctrl.abort(), 20) });
    const t0 = Date.now();
    await assert.rejects(p, AbortedError);
    assert.ok(Date.now() - t0 < 900, "did not sit out the full backoff");
  });
});

test("a stream that closes before any token waits and retries without using up rounds", async () => {
  await withFetch([stream([], "close"), text("fine")], async () => {
    const r = await run([{ role: "user", content: "q" }], { maxRounds: 1 });
    assert.equal(r.streamed, "fine");
    assert.equal(r.end, "done");
    assert.equal(r.retries.length, 1);
  });
});

test("finish_reason=length continues the reply instead of ending silently", async () => {
  await withFetch([text("Long part one, ", "length"), text("part two.")], async (requests) => {
    const r = await run([{ role: "user", content: "q" }]);
    assert.equal(r.streamed, "Long part one, part two.");
    assert.match(requests[1].messages.at(-1).content, /output limit/);
  });
});

test("an agent that announces a step without acting is prompted to continue (bounded)", async () => {
  const exec = async () => ({ ok: true, output: "done" });
  const tools = [{ type: "function", function: { name: "read_file", description: "", parameters: {} } }];
  const task = [{ role: "user", content: "fix the failing tests" }];
  await withFetch([text("Now I'll update the tests:"), toolCall([{ id: "c1", name: "read_file", args: "{}" }]), text("All finished.")], async (requests) => {
    const r = await run([...task], { tools, execute: exec });
    assert.equal(r.end, "done");
    assert.match(requests[1].messages.at(-1).content, /did not call a tool/);
    assert.equal(r.toolCalls, 1);
  });
  // Without tools there is nothing to nudge toward.
  await withFetch([text("Let me think:")], async (requests) => {
    await run([...task]);
    assert.equal(requests.length, 1);
  });
  // A question or a task that asks for no action is a normal ending.
  await withFetch([text("Let me know which file:")], async (requests) => {
    await run([{ role: "user", content: "what does this repo do?" }], { tools, execute: exec });
    assert.equal(requests.length, 1);
  });
  // At most two nudges, then the turn ends with a visible warning.
  await withFetch([text("Let me check:"), text("Next, I'll look:"), text("I will now go:")], async (requests) => {
    const r = await run([...task], { tools, execute: exec });
    assert.equal(requests.length, 3);
    assert.equal(r.end, "gave-up");
    assert.match(r.streamed, /no success is implied/);
  });
});

test("announcesNextStep recognises hand-offs but not finished summaries", () => {
  for (const t of ["Now I'll update the tests:", "Let me check the config.", "I found the bug. Next, I will fix it", "Running the build…"]) assert.ok(announcesNextStep(t), t);
  for (const t of ["Fixed — all 12 tests pass.", "The bug was in parse(). Tests pass now.", "", "I'll leave the rest to you if you want changes. Done."]) assert.equal(announcesNextStep(t), false, t);
});

test("tool calls with truncated JSON arguments are reported back, never executed", async () => {
  let executed = 0;
  const exec = async () => { executed++; return { ok: true, output: "x" }; };
  const tools = [{ type: "function", function: { name: "write_file", description: "", parameters: {} } }];
  await withFetch([
    stream([delta({ tool_calls: [{ index: 0, id: "w1", function: { name: "write_file", arguments: '{"path":"a.txt","content":"hal' } }] }), delta({}, "length")]),
    text("Retried smaller."),
  ], async (requests) => {
    const r = await run([{ role: "user", content: "q" }], { tools, execute: exec });
    assert.equal(executed, 0);
    const result = requests[1].messages.find((m) => m.role === "tool");
    assert.match(result.content, /cut off/);
    assert.equal(r.end, "done");
  });
});

test("adjacent subagent calls run in parallel; others stay sequential and ordered", async () => {
  const log = [];
  const exec = async (name, args, id) => {
    log.push(`start ${id}`);
    await new Promise((r) => setTimeout(r, name === "agent" ? 150 : 10));
    log.push(`end ${id}`);
    return { ok: true, output: `result ${id}` };
  };
  const tools = [{ type: "function", function: { name: "agent", description: "", parameters: {} } }];
  await withFetch([
    toolCall([{ id: "a1", name: "agent", args: "{}" }, { id: "a2", name: "agent", args: "{}" }, { id: "a3", name: "agent", args: "{}" }, { id: "r1", name: "read_file", args: "{}" }]),
    text("merged"),
  ], async (requests) => {
    const t0 = Date.now();
    await run([{ role: "user", content: "q" }], { tools, execute: exec, parallelSafe: (n) => n === "agent" });
    assert.ok(Date.now() - t0 < 400, "three 150ms agents overlapped");
    assert.deepEqual(log.slice(0, 3), ["start a1", "start a2", "start a3"]);
    assert.equal(log.at(-2), "start r1", "the non-agent call waits for the group");
    const results = requests[1].messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    assert.deepEqual(results, ["a1", "a2", "a3", "r1"], "results return in the order requested");
  });
});

test("messages typed mid-turn are delivered after the current tool step", async () => {
  const pending = ["also update the README"];
  const tools = [{ type: "function", function: { name: "read_file", description: "", parameters: {} } }];
  await withFetch([toolCall([{ id: "c1", name: "read_file", args: "{}" }]), text("ok")], async (requests) => {
    await run([{ role: "user", content: "q" }], { tools, execute: async () => ({ ok: true, output: "file" }), interject: () => pending.splice(0) });
    const last = requests[1].messages.at(-1);
    assert.equal(last.role, "user");
    assert.match(last.content, /also update the README/);
    assert.equal(requests[1].messages.at(-2).role, "tool", "tool results stay paired with their call");
  });
});

test("streamChatRetry with a partial reply returns it as incomplete instead of throwing", async () => {
  await withFetch([stream([delta({ content: "half" })], "error")], async () => {
    let got = "";
    const res = await streamChatRetry("http://local.test/v1", "k", "m", [{ role: "user", content: "q" }], { onToken: (t) => { got += t; } }, new AbortController().signal);
    assert.equal(res.incomplete, true);
    assert.equal(got, "half");
  });
});

test("isTransient and backoffMs classify and pace retries", () => {
  assert.equal(isTransient(new ApiError("x", 503)), true);
  assert.equal(isTransient(new ApiError("x", 429)), true);
  assert.equal(isTransient(new ApiError("x")), true, "network/timeout errors carry no status");
  assert.equal(isTransient(new ApiError("x", 401)), false);
  assert.equal(isTransient(new ApiError("x", 400)), false);
  assert.equal(isTransient(new AbortedError()), false);
  for (let a = 1; a <= 12; a++) {
    const ms = backoffMs(a);
    assert.ok(ms >= 800 && ms <= 72_000, `attempt ${a}: ${ms}`);
  }
  assert.equal(backoffMs(3, 7), 7000);
});

test("permanent failures are not mistaken for outages", async () => {
  // A wrong base URL that answers 200 with HTML.
  await withFetch([() => new Response("<html>hi</html>", { headers: { "content-type": "text/html" } })], async (requests) => {
    await assert.rejects(run([{ role: "user", content: "q" }]), /unexpected response/);
    assert.equal(requests.length, 1);
  });
  // A server-reported error mid-stream (e.g. context length exceeded).
  await withFetch([stream([sse({ error: { message: "context length exceeded" } })], "close")], async (requests) => {
    await assert.rejects(run([{ role: "user", content: "q" }]), /context length exceeded/);
    assert.equal(requests.length, 1);
  });
  assert.equal(isTransient(new Error("handler bug")), false, "bugs are not retried forever");
});

test("usage is reported once per request even when every chunk repeats it", async () => {
  const chunk = (content, completion) => sse({ choices: [{ delta: { content }, finish_reason: null }], usage: { prompt_tokens: 100, completion_tokens: completion } });
  await withFetch([stream([chunk("a", 1), chunk("b", 2), chunk("c", 3), delta({}, "stop")])], async () => {
    const seen = [];
    await run([{ role: "user", content: "q" }], {}, { onUsage: (u) => seen.push(u) });
    assert.deepEqual(seen.map((u) => u.completion), [3]);
  });
});

test("reasoning tokens from completion_tokens_details are surfaced", async () => {
  await withFetch([stream([delta({ content: "x" }, "stop"), sse({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 42 } } })])], async () => {
    const seen = [];
    await run([{ role: "user", content: "q" }], {}, { onUsage: (u) => seen.push(u) });
    assert.equal(seen[0].reasoning, 42);
  });
});

test("a tool that throws is reported to the model instead of ending the turn", async () => {
  const tools = [{ type: "function", function: { name: "read_file", description: "", parameters: {} } }];
  await withFetch([toolCall([{ id: "t1", name: "read_file", args: "{}" }]), text("handled")], async (requests) => {
    const r = await run([{ role: "user", content: "q" }], { tools, execute: async () => { throw new Error("disk on fire"); } });
    assert.equal(r.end, "done");
    assert.match(requests[1].messages.find((m) => m.role === "tool").content, /The tool failed: disk on fire/);
  });
});

test("endless cut-off replies end the turn with a reason instead of looping", async () => {
  const script = Array.from({ length: 14 }, (_, i) => stream([delta({ content: `part ${i} ` })], "close"));
  await withFetch(script, async (requests) => {
    const r = await run([{ role: "user", content: "q" }]);
    assert.equal(r.end, "gave-up");
    assert.equal(requests.length, 13, "12 resumes (with backoff), then a visible stop");
    assert.ok(r.retries.length >= 10, "repeated interruptions back off");
  });
});

test("visible reasoning counts as output: a drop after it resumes instead of re-streaming", async () => {
  await withFetch([stream([delta({ reasoning_content: "thinking hard" })], "error"), text("answer")], async (requests) => {
    let reasoning = "";
    const r = await run([{ role: "user", content: "q" }], {}, { onReasoning: (t) => { reasoning += t; } });
    assert.equal(reasoning, "thinking hard", "reasoning shown once");
    assert.equal(r.streamed, "answer");
    assert.equal(r.retries.length, 1, "no text yet, so the empty close is waited out like an outage");
    assert.equal(requests.length, 2);
  });
});

const INTERRUPTED = "The model stream was interrupted. Retry to continue.";

test("a server-reported stream interruption before any output is retried, not fatal", async () => {
  await withFetch([stream([sse({ error: { message: INTERRUPTED } })], "close"), text("recovered")], async (requests) => {
    const r = await run([{ role: "user", content: "q" }]);
    assert.equal(r.streamed, "recovered");
    assert.equal(requests.length, 2);
    assert.equal(r.retries.length, 1);
  });
});

test("a server-reported interruption mid-reply resumes from the partial text", async () => {
  await withFetch([stream([delta({ content: "First half, " }), sse({ error: { message: INTERRUPTED } })], "close"), text("second half.")], async (requests) => {
    const r = await run([{ role: "user", content: "q" }]);
    assert.equal(r.streamed, "First half, second half.");
    assert.match(requests[1].messages.at(-1).content, /cut off/);
    assert.deepEqual(requests[1].messages.at(-2), { role: "assistant", content: "First half, " });
  });
});

test("interruptions reported as a JSON error body or finish_reason=error are retried too", async () => {
  await withFetch([() => Response.json({ error: { message: INTERRUPTED } }), text("ok after json error")], async () => {
    const r = await run([{ role: "user", content: "q" }]);
    assert.equal(r.streamed, "ok after json error");
  });
  await withFetch([stream([delta({}, "error")], "close"), text("ok after finish error")], async () => {
    const r = await run([{ role: "user", content: "q" }]);
    assert.equal(r.streamed, "ok after finish error");
  });
});

test("an interrupted subagent retries and completes instead of failing", async () => {
  const { runSubagent } = await import("../dist/agents.js");
  await withFetch([stream([sse({ error: { message: INTERRUPTED } })], "close"), stream([delta({ content: "Half a rep" }), sse({ error: INTERRUPTED })], "close"), text("ort.")], async (requests) => {
    const res = await runSubagent({ baseUrl: "http://local.test/v1", key: "k", model: "m", systemPrompt: "sys", prompt: "count things", tools: [], signal: new AbortController().signal, execute: async () => ({ ok: true, output: "" }), backoff: () => 5 });
    assert.equal(res.text, "Half a report.");
    assert.equal(requests.length, 3);
  });
});

test("server-reported errors are classified: transient ones retry, real failures stop", async () => {
  const { serverReportedError } = await import("../dist/api.js");
  for (const e of [INTERRUPTED, "Upstream timed out", "The model is overloaded", "Service temporarily unavailable", { message: "x", code: 503 }, { message: "boom", type: "server_error" }, { message: "Internal server error" }, "Rate limit reached, try again in 2s"]) {
    assert.equal(serverReportedError(e).permanent, false, JSON.stringify(e));
  }
  for (const e of ["This model's maximum context length is 128000 tokens", "Invalid request: messages must be an array", "Insufficient credit", { message: "nope", code: 400 }, "Request blocked by content policy", "Something odd happened"]) {
    assert.equal(serverReportedError(e).permanent, true, JSON.stringify(e));
  }
  assert.match(serverReportedError({ message: INTERRUPTED }).message, /interrupted/);
});

test("a reasoning-only stream past the deadline is asked to act instead of ending the turn", async () => {
  const thinking = () => new Response(new ReadableStream({ start(c) { const t = setInterval(() => { try { c.enqueue(delta({ reasoning_content: "hmm " })); } catch { clearInterval(t); } }, 5); } }), { headers: { "content-type": "text/event-stream" } });
  await withFetch([thinking, text("Acting now.")], async (requests) => {
    const r = await run([{ role: "user", content: "fix it" }], { reasoningTimeoutMs: 60 });
    assert.equal(r.end, "done");
    assert.match(r.streamed, /Acting now/);
    assert.match(requests[1].messages.at(-1).content, /Skip further deliberation/);
  });
});

test("glitches that may repeat (malformed chunks) are retried a bounded number of times", async () => {
  const torn = () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("data: {not json\n\n")); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
  await withFetch([torn, text("clean")], async () => {
    const r = await run([{ role: "user", content: "q" }]);
    assert.equal(r.streamed, "clean");
  });
  await withFetch([torn, torn, torn, torn, torn], async (requests) => {
    await assert.rejects(run([{ role: "user", content: "q" }]), /malformed/);
    assert.equal(requests.length, 4, "1 try + 3 retries");
  });
});

test("a 4xx whose message asks for a retry is retried; ordinary 4xx are not", async () => {
  const bad = (message) => () => Response.json({ error: { message } }, { status: 400 });
  await withFetch([bad(INTERRUPTED), text("ok")], async () => {
    const r = await run([{ role: "user", content: "q" }]);
    assert.equal(r.streamed, "ok");
  });
  await withFetch([bad("messages: field required")], async (requests) => {
    await assert.rejects(run([{ role: "user", content: "q" }]), /field required/);
    assert.equal(requests.length, 1);
  });
});

test("a message sent mid-batch is delivered after the running tool; the rest of the batch is skipped", async () => {
  const ran = [];
  const pending = [];
  const tools = [{ type: "function", function: { name: "edit_file", description: "", parameters: {} } }];
  const skipped = [];
  await withFetch([toolCall([{ id: "e1", name: "edit_file", args: "{}" }, { id: "e2", name: "edit_file", args: "{}" }, { id: "e3", name: "edit_file", args: "{}" }]), text("re-planned")], async (requests) => {
    await run([{ role: "user", content: "fix it" }], {
      tools,
      execute: async (_n, _a, id) => { ran.push(id); if (id === "e1") pending.push("stop, use tabs instead"); return { ok: true, output: "edited" }; },
      interject: () => pending.splice(0),
    }, { onToolResult: (_n, ok, out, id) => { if (!ok) skipped.push(id); } });
    assert.deepEqual(ran, ["e1"], "only the running tool finished");
    assert.deepEqual(skipped, ["e2", "e3"]);
    const msgs = requests[1].messages;
    assert.deepEqual(msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id), ["e1", "e2", "e3"], "every call still gets a result");
    assert.match(msgs.find((m) => m.tool_call_id === "e2").content, /Not run: the user sent a new message/);
    assert.match(msgs.at(-1).content, /stop, use tabs instead/);
  });
});
