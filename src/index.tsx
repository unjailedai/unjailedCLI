#!/usr/bin/env node
import React from "react";
import { render } from "ink";
import { App } from "./ui/App.js";
import { playIntro } from "./ui/Intro.js";
import { fxEnabled } from "./ui/fx.js";
import { VERSION } from "./constants.js";
import { configPath } from "./config.js";

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  console.log(VERSION);
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Unjailed AI ${VERSION} — chat with Unjailed AI in your terminal

Usage
  unjailed            start a new chat (type /login first)
  unjailed -c         continue the most recent chat from this folder
  unjailed -r         pick a saved chat to resume

Options
  -c, --continue      continue the latest chat in the current folder
  -r, --resume        choose a saved chat to resume
  -v, --version       print the version
  -h, --help          show this help

Environment
  UNJAILED_API_KEY    API key (overrides the saved key)
  UNJAILED_BASE_URL   API base URL (default https://unjailedai.com/v1)
  UNJAILED_MODEL      model to start with (default: the one picked with /model, else glm-5.3)
  UNJAILED_HOME       config directory (default ~/.unjailed)
  UNJAILED_TIMEOUT    header/idle timeout in seconds (default 120)
  UNJAILED_REASONING_TIMEOUT  no-answer/tool-call deadline in seconds (default 180)
  UNJAILED_AUTOSAVE_SECONDS  autosave interval in seconds for the open chat (default 10)
  UNJAILED_NO_HISTORY set to 1 to stop saving chats (disables /resume)
  UNJAILED_NO_FX      set to 1 to turn off the fun effects (wink, snow)
  NO_COLOR            disable colors
  FORCE_COLOR         force a color level (0 off, 1 basic, 2 256 colors, 3 truecolor)

Config: ${configPath()}`);
  process.exit(0);
}

if (!process.stdin.isTTY) {
  console.error("unjailed is interactive and needs a terminal (stdin is not a TTY).");
  process.exit(1);
}

// Turn on the kitty keyboard protocol (Shift+Enter support) only where we know it exists.
// Ink's "auto" mode queries the terminal before raw mode is on, and the reply leaks into the screen.
const env = process.env;
const kitty = "KITTY_WINDOW_ID" in env || env.TERM === "xterm-kitty" || env.TERM_PROGRAM === "WezTerm" || env.TERM_PROGRAM === "ghostty";

// Bracketed paste: the terminal wraps pasted text in markers so newlines in it don't send the message.
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";
process.stdout.write(BRACKETED_PASTE_ON);
process.on("exit", () => process.stdout.write(BRACKETED_PASTE_OFF));
for (const sig of ["SIGTERM", "SIGHUP"] as const) process.on(sig, () => process.exit(0));

const known = new Set(["-c", "--continue", "-r", "--resume"]);
const unknown = args.find((a) => !known.has(a));
if (unknown) {
  console.error(`Unknown option: ${unknown}. Run "unjailed --help" for usage.`);
  process.exit(1);
}
const startup = args.some((a) => a === "-c" || a === "--continue") ? "continue" : args.some((a) => a === "-r" || a === "--resume") ? "resume" : undefined;

// A quick animated wink hello before the UI (skipped when effects are off).
if (fxEnabled()) {
  await playIntro();
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); // clear the intro so the app starts clean
}

const app = render(<App startup={startup} />, { exitOnCtrlC: false, kittyKeyboard: { mode: kitty ? "enabled" : "disabled" } });
await app.waitUntilExit();
process.exit(0);
