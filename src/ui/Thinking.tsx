import React from "react";
import { Box, Text } from "ink";
import { wrapAnsiLine } from "../markdown.js";
import { c, colorLevel, tone } from "../theme.js";
import { sanitizeForDisplay } from "./sanitize.js";

/**
 * The model's thinking (/verbose): dim violet italics under a ∴ gutter.
 *
 * The text is wrapped here and every row is styled on its own. Letting Ink
 * wrap one long styled string re-applies only the innermost style on the
 * continuation rows, so only the first row kept its color.
 */
export function thinkingLines(text: string, columns: number, maxLines?: number): string[] {
  const width = Math.max(10, columns);
  let rows = sanitizeForDisplay(text)
    .trim()
    .split("\n")
    .flatMap((line) => (line.length ? wrapAnsiLine(line, width + 1).map((r) => r.replace(/\x1b\[0m$/, "").replace(/\s+$/, "")) : [""]));
  if (maxLines && rows.length > maxLines) rows = ["…", ...rows.slice(-(maxLines - 1))];
  return rows.map((row) => (row && colorLevel > 0 ? tone.thinking(c.italic(row)) : row));
}

export function Thinking({ text, width, maxLines }: { text: string; width: number; maxLines?: number }) {
  const cols = Math.max(10, width - 2);
  const rows = thinkingLines(text, cols, maxLines);
  return (
    <Box flexDirection="row">
      <Box width={2} flexShrink={0}>
        <Text>{tone.thinking("∴")}</Text>
      </Box>
      <Box width={cols} flexDirection="column">
        {rows.map((row, i) => (
          <Text key={i} wrap="truncate-end">
            {row || " "}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
