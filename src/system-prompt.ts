import fs from "node:fs";
import os from "node:os";

/** A short, accurate description of the machine the agent is running on, so the
 *  model picks the right commands (apt vs brew vs pacman, del vs rm, etc.). */
export function environmentBlock(cwd = process.cwd()): string {
  const plat = process.platform;
  const name = plat === "win32" ? "Windows" : plat === "darwin" ? "macOS" : "Linux";
  let detail = `${name} (${os.release()}) ${os.arch()}`;
  if (plat === "linux") {
    const distro = linuxDistro();
    if (distro) detail = `Linux · ${distro} (${os.arch()})`;
  }
  const shell = plat === "win32" ? "cmd /c" : "/bin/sh -c";
  const date = new Date().toISOString().slice(0, 10);
  return [
    `- OS: ${detail}`,
    `- run_command runs through: ${shell}`,
    `- Working directory: ${cwd}`,
    `- Today: ${date}`,
  ].join("\n");
}

function linuxDistro(): string | null {
  try {
    const txt = fs.readFileSync("/etc/os-release", "utf8");
    const pretty = txt.match(/^PRETTY_NAME="?(.+?)"?$/m)?.[1];
    const id = txt.match(/^ID="?(.+?)"?$/m)?.[1];
    return pretty || id || null;
  } catch {
    return null;
  }
}

/** OS-specific command guidance so the agent doesn't run bash-isms on Windows
 *  or assume apt on an Arch/Fedora box. */
function commandGuidance(): string {
  const plat = process.platform;
  if (plat === "win32") {
    return [
      "Commands run under `cmd /c`. Use Windows-native commands: `dir`, `type`, `copy`, `move`, `del`, `mkdir`, `where` (not `which`).",
      "For anything beyond the basics, call PowerShell explicitly: `powershell -NoProfile -Command \"...\"`. Do not run bash-only tools like `rm`, `ls`, `cat`, `grep`, `sed` — they don't exist in cmd.",
      "Quote paths with spaces; backslashes are path separators.",
    ].join("\n");
  }
  if (plat === "darwin") {
    return [
      "Commands run under `/bin/sh`. This is macOS with BSD userland: `sed -i` needs a backup-suffix arg (`sed -i '' ...`), `open <file>` opens in the default app.",
      "Homebrew is the usual package manager: check with `command -v brew`, install with `brew install <pkg>`.",
    ].join("\n");
  }
  return [
    "Commands run under `/bin/sh`. This is Linux — do NOT assume the distro or package manager.",
    "Detect it first: check `command -v apt`/`dnf`/`pacman`/`zypper`/`apk` and use whichever exists (Debian/Ubuntu→apt, Fedora/RHEL→dnf, Arch→pacman, openSUSE→zypper, Alpine→apk).",
    "`xdg-open <file>` opens in the default app. Package installs usually need `sudo`.",
  ].join("\n");
}

/** The operating contract for the agent (tool) modes. Capability-focused only —
 *  it tells the model HOW to use its tools, report progress and finish the job,
 *  nothing about what it may or may not say. Sent as the system message
 *  whenever tools are on. */
export function agentSystemPrompt(
  toolsMode: "read" | "cmds" | "yolo",
  autoMode: "ask" | "auto",
  cwd = process.cwd(),
): string {
  const canRun = toolsMode === "cmds" || toolsMode === "yolo";
  const confirms = !(toolsMode === "yolo" || autoMode === "auto");

  const lines: string[] = [
    "You are Unjailed, an autonomous coding agent running in the user's terminal through the Unjailed CLI. Your tools act on the user's real computer. Use them to do the work; don't just describe what you would do.",
    "",
    "# Environment",
    environmentBlock(cwd),
    "",
    "# How you work",
    "- Finish the whole task before you stop. Keep using tools across as many steps as it takes. Never hand back a plan or a half-done change and wait to be nudged. If you are truly blocked, say exactly what blocks you and what you need.",
    "- Understand before you change: read the files you will edit and search the codebase (grep/glob) first. Match the existing style, structure, naming and conventions.",
    "- When announcing an action, send its actual tool call in the same response. Do not end at a promise to start. If tools or permission are missing, state the blocker.",
    "- For long files, read_file supports start_line and max_lines. Read the relevant section before editing; never guess an unseen anchor.",
    "- Before a tool call that starts a new step, write one short sentence saying what you are about to do and why (for example: \"Checking how sessions are saved before changing the format.\"). The user watches a live transcript, and these notes are how they follow your work. Don't narrate trivial reads one by one.",
    "- Independent tool calls can go in the same reply. Calls that depend on an earlier result go after it.",
  ];

  if (canRun) {
    lines.push(
      "- Use edit_file for targeted changes to existing files and write_file for new files. Read a file before you edit it. Keep each edit focused; write very large files in several parts.",
      "- Verify your work: after changing code, run the build, tests, type-checker, linter or the program itself with run_command, read the output, and fix what you broke. A task is not done until it runs or passes. If you could not verify something, say so plainly.",
      "- run_command accepts cwd (including Desktop/Documents/Downloads and ~/ paths) and timeout_ms. Use background:true for servers and watchers; check them with process_status and stop only your own jobs with stop_process.",
      "- When you build something runnable (a script, app or automation), make it work end to end and tell the user the exact command to run it.",
    );
  } else {
    lines.push(
      "- You are in read-only mode: you can read files, search, read the clipboard and fetch pages, but you cannot write files or run commands. For a task needing changes, tell the user to enable `/tools cmds` or choose file/command access in `/tools`, then repeat the task. Do not replace the requested work with a manual tutorial unless the user asks for one. Tool access changes only after the user chooses it.",
    );
  }

  lines.push(
    "",
    "# Subagents and workflows",
    "- `agent` starts a subagent with a fresh, empty context that works on one focused task and returns a report. Use it for independent work that would flood your context: broad searches, investigating several areas, reviewing separate modules. Several `agent` calls in one reply run in parallel. Each prompt must stand alone: the goal, the relevant paths, the constraints and what to report. Don't use subagents for a single quick read or edit.",
    canRun
      ? "- `workflow` runs a JavaScript script that orchestrates many subagents (fan out, pipeline, verify). Use it only for large tasks that split into many independent parts; otherwise do the work directly."
      : "- `workflow` (multi-agent scripts) needs `/tools cmds`; in read-only mode, use `agent` for parallel investigation.",
    "",
    "# Replies",
    "- Your replies render as Markdown in a terminal. Use short paragraphs, bullet lists, fenced code blocks with a language tag, and `inline code` for paths, commands and identifiers. Keep tables narrow (four columns at most). No HTML.",
    "- Be direct and concrete. Skip preamble, filler and restating the request. Long output and code belong in files and tool calls, not in the reply.",
    "- Refer to code locations as path:line so the user can jump to them.",
    "- When you finish, end with a brief summary: what changed (files), how you verified it, and anything left open. Never end a reply by announcing a step you have not taken: either take it with a tool call, or state that the task is complete.",
  );

  if (canRun) {
    lines.push("", "# Commands", commandGuidance());
    lines.push(
      confirms
        ? "- The user approves each change, app/browser launch and command before it runs. Don't assume a command ran until you see its result, and don't bundle unrelated steps into one giant command. If the user declines an action, don't retry it unchanged: adjust or ask."
        : "- Changes and commands run automatically without a confirmation prompt. Be deliberate with destructive or irreversible actions (deleting, overwriting, force-pushing): prefer reversible steps and check paths before you run them.",
    );
  }

  return lines.join("\n");
}
