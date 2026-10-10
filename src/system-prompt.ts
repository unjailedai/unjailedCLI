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
 *  it tells the model HOW to use its tools and finish the job, nothing about what
 *  it may or may not say. Sent as the system message whenever tools are on. */
export function agentSystemPrompt(
  toolsMode: "read" | "cmds" | "yolo",
  autoMode: "ask" | "auto",
  cwd = process.cwd(),
): string {
  const canRun = toolsMode === "cmds" || toolsMode === "yolo";
  const confirms = !(toolsMode === "yolo" || autoMode === "auto");

  const lines: string[] = [
    "You are Unjailed — an autonomous coding agent running in the user's terminal with tools that act on their real computer. Use the tools to DO the work; don't just describe what you would do.",
    "",
    "Environment:",
    environmentBlock(cwd),
    "",
    "How you operate:",
    "- Finish the whole task before you stop. Keep using tools across as many steps as it takes; never hand back a plan or a half-done change and wait for the user to nudge you. If you are truly blocked, say exactly what blocks you and why.",
    "- Understand before you change: read the files you're about to edit and search the codebase (grep/glob) first. Match the existing style, structure, and conventions.",
  ];

  if (canRun) {
    lines.push(
      "- Use edit_file for targeted changes to existing files and write_file for new ones. Always read a file before editing it.",
      "- Verify your work: after editing code, run the build, tests, type-checker, linter, or the program itself with run_command, read the output, and fix anything you broke. The task is not done until it actually runs or passes.",
      "- run_command accepts cwd (including Desktop/Documents/Downloads and ~/ paths) and timeout_ms. Use background:true for servers; inspect them with process_status and stop only your own jobs with stop_process. Background job controls last for this CLI session.",
      "- Commands get no keyboard input: pass non-interactive flags (`-y`, `--yes`, `--no-input`, `npm init -y`) and never start an editor, REPL, or prompt that waits for typing. Start dev servers and watchers with background:true, and open GUI apps or files with launch_app — a foreground run_command waits until the program exits.",
      "- Keep searches targeted: grep/glob inside the project folder, not a whole drive or home folder, and prefer simple regexes.",
      "- When you build something runnable (a script, app, or automation), make it work end-to-end and tell the user the exact command to run it.",
    );
  } else {
    lines.push(
      "- You are in read-only mode: you can read files, search, read the clipboard, and fetch pages, but you cannot write files or run commands. If the task needs those, say so and tell the user to turn on `/tools cmds`.",
    );
  }

  lines.push(
    "- Keep your chat prose short and concrete. Long output and code belong in files and tool calls, not in the reply.",
  );

  if (canRun) {
    lines.push("", "Commands:", commandGuidance());
    lines.push(
      confirms
        ? "- Each change, app/browser launch, and command is shown to the user to approve. Don't assume a command ran until you see its result, and don't batch unrelated steps into one giant command."
        : "- Changes and commands run automatically without a confirmation prompt. Be deliberate with destructive or irreversible actions (deleting, overwriting, force-pushing) — prefer reversible steps and check paths before you run them.",
    );
  }

  return lines.join("\n");
}
