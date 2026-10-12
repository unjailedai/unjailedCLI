import { test } from "node:test";
import assert from "node:assert/strict";

// Real colors for this file: the bug only shows with ANSI styling on.
delete process.env.NO_COLOR;
process.env.FORCE_COLOR = "3";
const React = (await import("react")).default;
const { renderToString } = await import("ink");
const { Thinking, thinkingLines } = await import("../dist/ui/Thinking.js");
const stringWidth = (await import("string-width")).default;

const VIOLET = "\x1b[38;2;196;181;253m";
const ITALIC = "\x1b[3m";
const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("every wrapped row of verbose thinking keeps its color and italics", () => {
  const text = "The user wants me to look at src/stats.js and identify which function is most likely to have an edge-case bug. Let me read the file first, then compare mean, median and range.\n\nSecond paragraph that is also long enough to wrap across several rows of a narrow terminal window.";
  for (const width of [40, 60, 100]) {
    const out = renderToString(React.createElement(Thinking, { text, width }), { columns: width });
    const rows = out.split("\n").filter((r) => plain(r).trim() && plain(r).trim() !== "∴");
    assert.ok(rows.length >= 3, `wraps at ${width}`);
    for (const row of rows) {
      assert.ok(row.includes(VIOLET), `colored at ${width}: ${JSON.stringify(row)}`);
      assert.ok(row.includes(ITALIC), `italic at ${width}: ${JSON.stringify(row)}`);
      assert.ok(stringWidth(plain(row)) <= width, `fits ${width}`);
    }
    // Nothing lost: the rendered words are the source words.
    assert.equal(plain(out).replace(/[∴…\s]+/g, " ").trim(), text.replace(/\s+/g, " ").trim());
  }
});

test("the live preview keeps the latest rows, each fully styled", () => {
  const text = Array.from({ length: 30 }, (_, i) => `thought number ${i} with some extra words to wrap`).join(" ");
  const rows = thinkingLines(text, 40, 4);
  assert.equal(rows.length, 4);
  assert.equal(plain(rows[0]), "…");
  for (const row of rows.slice(1)) assert.ok(row.startsWith(VIOLET) || row.includes(VIOLET));
  assert.match(rows.map(plain).join(" "), /thought number 29 with some extra words to wrap$/);
});
