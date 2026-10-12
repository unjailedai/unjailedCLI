import React from "react";
import { Box, Text } from "ink";
import { logoLines, LOGO_WIDTH } from "../logo.js";
import { VERSION } from "../constants.js";
import { prettyPath } from "../sessions.js";
import { theme } from "../theme.js";

/** The welcome card. Wide terminals get the logo beside the details; narrow
 *  ones get a compact card, so nothing ever wraps inside the border. */
export function Header({ model, loggedIn, keySource, width }: { model: string; loggedIn: boolean; keySource: string | null; width: number }) {
  const cardWidth = Math.max(30, width);
  const showLogo = cardWidth >= 64;
  const status = loggedIn
    ? theme.ok("● ") + "Logged in" + (keySource === "env" ? theme.dim(" (UNJAILED_API_KEY)") : "")
    : theme.warn("○ ") + "Not logged in" + theme.dim(" — type ") + theme.brand("/login");
  const info = [
    theme.brandBold("Unjailed AI") + theme.dim(`  v${VERSION}`),
    "",
    theme.dim("model  ") + model,
    theme.dim("status ") + status,
    theme.dim("cwd    ") + prettyPath(process.cwd()),
    "",
    theme.dim("/help for help · / for commands · Esc Esc to stop a turn"),
  ];
  return (
    <Box marginTop={1} width={cardWidth} borderStyle="round" borderColor="gray" paddingX={1} flexDirection="row">
      {showLogo && (
        <Box flexDirection="column" marginRight={3} flexShrink={0} width={LOGO_WIDTH}>
          {logoLines().map((l, i) => (
            <Text key={i}>{l}</Text>
          ))}
        </Box>
      )}
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {info.map((l, i) => (
          <Text key={i} wrap="truncate-end">
            {l || " "}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
