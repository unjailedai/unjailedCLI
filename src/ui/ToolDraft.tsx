import React from "react";
import { Box, Text } from "ink";
import { theme } from "../theme.js";
import type { ToolDraft as Draft } from "./tool-draft.js";

export function ToolDraft({ draft, rows = 6 }: { draft: Draft; rows?: number }) {
  const lines = draft.preview.split("\n").slice(-Math.max(1, rows));
  return <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
    <Text wrap="truncate-end">{theme.brand("LIVE DRAFT")}{theme.dim(` · ${draft.target || draft.name || "tool arguments"}`)}</Text>
    {draft.preview ? lines.map((line, i) => <Text key={i} wrap="truncate-end">{line || " "}</Text>) : <Text dimColor>Receiving tool arguments…</Text>}
    <Text dimColor wrap="truncate-end">{draft.characters.toLocaleString()} chars received · not executed yet</Text>
  </Box>;
}
