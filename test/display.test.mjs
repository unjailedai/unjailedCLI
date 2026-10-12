import { test } from "node:test";
import assert from "node:assert/strict";

process.env.NO_COLOR = "1";
const { sanitizeForDisplay } = await import("../dist/ui/sanitize.js");
const { toolTitle, toolSummary, formatToolBlock, clip } = await import("../dist/ui/tool-format.js");
const { statusLine, formatElapsed, formatTokens } = await import("../dist/ui/ActivityBar.js");
const { renderMarkdown } = await import("../dist/markdown.js");
const stringWidth = (await import("string-width")).default;

test("sanitizeForDisplay removes everything that moves the cursor behind Ink's back", () => {
  assert.equal(sanitizeForDisplay("\x1b[31mred\x1b[0m"), "red");
  assert.equal(sanitizeForDisplay("\x1b]8;;http://x\x07link\x1b]8;;\x07"), "link", "OSC hyperlinks");
  assert.equal(sanitizeForDisplay("10%\r50%\r100% done"), "100% done", "carriage-return progress keeps the final state");
  assert.equal(sanitizeForDisplay("a\r\nb"), "a\nb");
  assert.equal(sanitizeForDisplay("a\tb"), "a   b", "tabs expand to the next 4-column stop");
  assert.equal(sanitizeForDisplay("abcd\te"), "abcd    e");
  assert.equal(sanitizeForDisplay("bell\x07 back\x08 ‮evil"), "bell back evil");
  assert.equal(sanitizeForDisplay("\x1b[2J\x1b[Hclear"), "clear", "screen clears and cursor moves");
  assert.equal(sanitizeForDisplay("漢字 ok 😀"), "漢字 ok 😀", "wide characters are kept");
});

test("markdown output never contains raw escapes or tabs from the source text", () => {
  const out = renderMarkdown("Line with \x1b[31mcolor\x1b[0m and\ttab\n\n```\n\tindented\x1b[2J\n```", { width: 60 });
  assert.doesNotMatch(out, /\x1b|\t/);
  for (const line of out.split("\n")) assert.ok(stringWidth(line) <= 60, `fits: ${JSON.stringify(line)}`);
});

test("markdown lines never exceed the width they are rendered for", () => {
  const src = ["# Title " + "x".repeat(200), "- bullet " + "y ".repeat(150), "| a | b |\n|---|---|\n| 1 | 2 |", "```js\n" + "const z = '" + "q".repeat(300) + "';\n```", "> quote " + "w ".repeat(120)].join("\n\n");
  for (const width of [40, 80, 132]) {
    for (const line of renderMarkdown(src, { width }).split("\n")) assert.ok(stringWidth(line) <= width, `width ${width}: ${stringWidth(line)}`);
  }
});

test("tool titles read like Claude Code's and clip to the terminal", () => {
  assert.equal(toolTitle("read_file", { path: "src/a.ts" }), "Read(src/a.ts)");
  assert.equal(toolTitle("run_command", { command: "npm test" }), "Bash(npm test)");
  assert.equal(toolTitle("run_command", { command: "npm run dev", background: true }), "Bash(npm run dev &)");
  assert.equal(toolTitle("grep", { pattern: "TODO", path: "src" }), 'Search("TODO" in src)');
  assert.equal(toolTitle("edit_file", { path: "x.py" }), "Update(x.py)");
  assert.equal(toolTitle("agent", { description: "Find callers", prompt: "…" }), "Agent(Find callers)");
  assert.equal(toolTitle("workflow", { script: 'export const meta = { name: "review" }' }), "Workflow(review)");
  assert.equal(toolTitle("mystery_tool", {}), "mystery_tool");
  const long = toolTitle("run_command", { command: "echo " + "z".repeat(500) }, 60);
  assert.ok(stringWidth(long) <= 60, `clipped: ${stringWidth(long)}`);
  assert.match(toolTitle("run_command", { command: "a\nb" }), /a ⏎ b/, "multi-line commands stay on one line");
});

test("tool summaries: counts, diffs, command output and failures", () => {
  assert.deepEqual(toolSummary("read_file", {}, true, "a\nb\nc"), ["Read 3 lines"]);
  assert.deepEqual(toolSummary("list_dir", {}, true, "a\nb/"), ["Listed 2 entries"]);
  assert.deepEqual(toolSummary("grep", {}, true, "x:1: a"), ["Found 1 match"]);
  assert.deepEqual(toolSummary("grep", {}, true, "(no matches)"), ["No matches"]);
  const diff = toolSummary("edit_file", { path: "f", old_text: "a\nb", new_text: "c" }, true, "ok");
  assert.equal(diff[0], "Updated f · 2 lines removed, 1 added");
  assert.deepEqual(diff.slice(1), ["- a", "- b", "+ c"]);
  assert.deepEqual(toolSummary("run_command", {}, true, "5\n\nExit code: 0"), ["5"], "exit code 0 is noise");
  assert.deepEqual(toolSummary("run_command", {}, true, "(no output)\nExit code: 0"), ["(no output)"]);
  const failed = toolSummary("run_command", {}, false, "Error: boom\nat x\nExit code: 1");
  assert.equal(failed[0], "Exit code: 1");
  assert.deepEqual(failed.slice(1), ["Error: boom", "at x"]);
  const many = toolSummary("run_command", {}, true, Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n"));
  assert.equal(many.length, 5);
  assert.equal(many.at(-1), "… +26 lines");
  assert.match(toolSummary("write_file", { path: "a.txt", content: "1\n2" }, true, "ok")[0], /Wrote 2 lines to a.txt/);
});

test("tool blocks: bullet, ⎿ connector, subagent notes, and safe output", () => {
  const block = formatToolBlock("run_command", JSON.stringify({ command: "ls" }), true, "\x1b[32ma\tb\x1b[0m\nExit code: 0", 80);
  assert.equal(block, "● Bash(ls)\n  ⎿  a   b");
  const agent = formatToolBlock("agent", JSON.stringify({ description: "Scan" }), true, "Found 3 issues.\nDetails…", 80, "4 tool uses · 1.2k tokens · 9s");
  assert.equal(agent.split("\n")[1], "  ⎿  Done (4 tool uses · 1.2k tokens · 9s)");
  const wf = formatToolBlock("workflow", JSON.stringify({ name: "review" }), true, 'Workflow "review" finished in 3s with 2 agents.\n\nResult:\n{\n  "a": 1\n}', 80, "2 agents · 3s");
  assert.deepEqual(wf.split("\n"), ["● Workflow(review)", "  ⎿  Done (2 agents · 3s)", '     {"a":1}']);
  for (const width of [30, 60, 100]) {
    const b = formatToolBlock("grep", JSON.stringify({ pattern: "p".repeat(300) }), true, "(no matches)", width);
    for (const line of b.split("\n")) assert.ok(stringWidth(line) <= width, `${width}: ${line}`);
  }
});

test("the activity line shows phase, time, tokens and detail, and degrades to fit", () => {
  const a = { phase: "tool", detail: "Bash(npm test)", startedAt: 0, tokens: 3400 };
  const wide = statusLine(a, 72_000, "✻", 120, "esc esc to stop");
  assert.equal(wide, "✻ Running… (1m 12s · ↓ 3.4k tokens · Bash(npm test) · esc esc to stop)");
  for (const width of [20, 40, 60]) {
    const line = statusLine({ ...a, detail: "Bash(" + "x".repeat(300) + ")" }, 5000, "✻", width, "esc esc to stop");
    assert.ok(stringWidth(line) <= width, `${width}: ${line}`);
  }
  assert.equal(formatElapsed(59_999), "59s");
  assert.equal(formatElapsed(3_723_000), "1h 02m");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(12_400), "12.4k");
  assert.equal(formatTokens(2_500_000), "2.5M");
  assert.equal(clip("abcdef", 4), "abc…");
});

test("the agents table shows status, time, tools and in/out/reasoning tokens, and narrows gracefully", async () => {
  const { agentsTable, taskLine } = await import("../dist/ui/ActivityBar.js");
  const rows = [
    { id: "main", label: "main agent", main: true, status: "running", state: "subagents", startedAt: 0, toolUses: 3, tokensIn: 12_400, tokens: 3_100, reasoning: 820 },
    { id: "a", label: "Review api", status: "running", state: "tool", detail: "Read(src/api.ts)", startedAt: 40_000, toolUses: 6, tokensIn: 8_200, tokens: 1_200, reasoning: 400 },
    { id: "b", label: "Review tests", status: "done", startedAt: 10_000, endedAt: 28_000, toolUses: 4, tokensIn: 5_100, tokens: 900 },
    { id: "c", label: "Verify", status: "queued", startedAt: 0 },
    { id: "d", label: "Broken", status: "failed", detail: "HTTP 500", startedAt: 0, endedAt: 5_000 },
  ];
  const wide = agentsTable(rows, 110, 72_000, "◐");
  assert.match(wide[0], /Agent\s+Status\s+Time\s+Tools\s+↑ In\s+↓ Out\s+∴ Think/);
  assert.match(wide[1], /main agent\s+coordinating\s+1m 12s\s+3\s+12\.4k\s+3\.1k\s+820/);
  assert.match(wide[2], /Review api\s+Read\(src\/api\.ts\)\s+32s\s+6\s+8\.2k\s+1\.2k\s+400/);
  assert.match(wide[3], /✓ Review tests\s+done\s+18s/);
  assert.match(wide[4], /○ Verify\s+queued\s+–/);
  assert.match(wide[5], /✗ Broken\s+failed: HTTP 500/);
  assert.match(wide.at(-1), /Total\s+5 agents\s+13\s+25\.7k\s+5\.2k\s+1\.2k/);
  for (const width of [40, 60, 80, 110]) {
    for (const line of agentsTable(rows, width, 72_000, "◐")) assert.ok(stringWidth(line) <= width, `${width}: ${line}`);
  }
  assert.doesNotMatch(agentsTable(rows, 60, 72_000, "◐")[0], /Think|In/, "narrow tables drop reasoning and input columns");
  assert.match(taskLine(rows[1], 72_000, "◐", 100), /◐ Review api\s+Read\(src\/api\.ts\)\s+32s · ↑8\.2k ↓1\.2k/);
  assert.ok(stringWidth(taskLine(rows[1], 72_000, "◐", 40)) <= 40);
});

test("emoji with disputed widths are normalized so table and box borders stay aligned", () => {
  assert.equal(sanitizeForDisplay("⚠️ warn ✔️ ok"), "⚠ warn ✔ ok", "presentation selectors removed");
  assert.equal(sanitizeForDisplay("👨‍👩‍👧 family"), "👨👩👧 family", "joined sequences split into measurable parts");
  assert.equal(sanitizeForDisplay("✅ ❌ 😀"), "✅ ❌ 😀", "default-emoji characters are untouched");
  const out = renderMarkdown("| A | B |\n|---|---|\n| ⚠️ x | ✔️ y |\n| ok | 👨‍👩‍👧 z |\n\n```\n⚠️ boxed\nplain\n```", { width: 60 });
  assert.doesNotMatch(out, /[️‍]/);
  const rows = out.split("\n");
  // Every row of the table puts its separator in the same column…
  const seps = rows.filter((l) => l.includes("│") && !l.includes("╭") && !/^\s*│ /.test(l)).map((l) => stringWidth(l.slice(0, l.indexOf("│"))));
  assert.equal(new Set(seps).size, 1, `table separators align: ${seps}`);
  // …and every box row has the same width.
  const box = rows.filter((l) => /^[╭│╰]/.test(l));
  assert.equal(new Set(box.map((l) => stringWidth(l))).size, 1, "box borders align");
});

test("verbose tool summaries show up to 40 lines of output", () => {
  const out = Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n");
  assert.equal(toolSummary("run_command", {}, true, out).length, 5, "compact: 4 lines + more marker");
  const v = toolSummary("run_command", {}, true, out, 100, true);
  assert.equal(v.length, 41);
  assert.equal(v.at(-1), "… +20 lines");
  assert.deepEqual(toolSummary("read_file", {}, true, "a\nb"), ["Read 2 lines"]);
  assert.deepEqual(toolSummary("read_file", {}, true, "a\nb", 100, true), ["Read 2 lines", "a", "b"]);
  assert.deepEqual(toolSummary("grep", {}, true, "(no matches)", 100, true), ["No matches"]);
});

test("verbose stats lines cover requests, latency, speed, tokens, tools, agents and the session", async () => {
  const { statsLines, addTurnToSession, emptySessionStats } = await import("../dist/ui/ActivityBar.js");
  const main = { id: "main", label: "main agent", main: true, status: "running", startedAt: 0, tokensIn: 12_000, tokens: 2_000, reasoning: 500 };
  const sub = { id: "a", label: "Review", status: "done", startedAt: 0, endedAt: 9_000, tokensIn: 6_000, tokens: 1_000, reasoning: 300, requests: 3, retries: 1 };
  const view = {
    activity: { phase: "tool", startedAt: 0, tokens: 3_000 },
    main, groups: [], all: [main, sub],
    stats: { requests: 5, retries: 2, recoveries: 1, ttftLastMs: 1_200, ttftTotalMs: 4_000, ttftCount: 2, firstOutputAt: 10_000, contextTokens: 12_400, tools: { read: 4, edit: 3, shell: 2, agent: 1 } },
  };
  const session = { ...emptySessionStats(), turns: 2, workMs: 60_000, tokensIn: 100_000, tokens: 9_000, tools: 20, requests: 15 };
  const lines = statsLines(view, session, 40_000, 200);
  assert.equal(lines[0], "Requests 8 (3 retried) · first token 1.2s (avg 2.0s) · speed 100 tok/s · context 12.4k");
  assert.equal(lines[1], "Tokens ↑ 18k in · ↓ 3k out · ∴ 800 thinking · Σ 21k");
  assert.equal(lines[2], "Tools 10 (read 4, edit 3, shell 2, agent 1) · Agents 1 · 1 done · recoveries 1");
  assert.equal(lines[3], "Session 3 turns · 1m 40s · ↑ 118k · ↓ 12k · ∴ 800 · 30 tools · 23 requests · 3 retried", "live: includes this turn");
  assert.match(statsLines(view, session, 40_000, 200, false)[3], /^Session 2 turns/);
  for (const w of [30, 60]) for (const l of statsLines(view, session, 40_000, w)) assert.ok(stringWidth(l) <= w, `${w}: ${l}`);
  const next = addTurnToSession(session, view, 30_000);
  assert.deepEqual([next.turns, next.requests, next.retries, next.tools, next.agents], [3, 23, 3, 30, 1]);
});
