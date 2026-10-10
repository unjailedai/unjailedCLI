import { spawn } from "node:child_process";
import { processStatus, runLocalCommand, stopProcess } from "./processes.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type { SearchMessage, SearchRequest } from "./search.js";

/** The built-in agent tools — a coding-agent toolkit like opencode/claude-code.
 *  Mode ladder (least → most capable):
 *    read  : read-only filesystem, clipboard and web fetch
 *    cmds  : + writes, launches and commands (user confirms each mutation)
 *    yolo  : same capabilities with explicit automatic approval
 */
export interface ToolDef {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export type ToolsMode = "off" | "read" | "cmds" | "yolo";

export const MAX_READ_BYTES = 200_000;      // 200 KB per file read
export const MAX_WRITE_BYTES = 200_000;     // 200 KB per file write
export const MAX_RUN_OUTPUT = 30_000;       // chars of stdout/stderr kept
export const MAX_TOOL_OUTPUT = 28_000;      // HARD cap: upstream rejects strings > 32k — never send more
export const RUN_TIMEOUT_MS = 600_000;      // 10 min — downloads, builds, server setup
export const MAX_BG_LOG = 100_000;
export const MAX_LIST = 500;
export { MAX_GLOB_RESULTS, MAX_GREP_RESULTS } from "./search.js";
export const SEARCH_TIMEOUT_MS = 20_000;     // glob/grep give up (keeping partial results) after this
export const WEB_FETCH_MAX_BYTES = 200_000;
export const WEB_TIMEOUT_MS = 15_000;

export function toolDefinitions(mode: ToolsMode): ToolDef[] {
  if (mode === "off") return [];
  const defs: ToolDef[] = [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "Read a UTF-8 text file from the user's machine. Paths are relative to the current directory unless absolute.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "File path to read" } },
          required: ["path"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "list_dir",
        description: "List files and folders in a directory (one level). Defaults to the current directory.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "Directory to list (default .)" } },
        },
      },
    },
    {
      type: "function",
      function: {
        name: "glob",
        description: "Find files whose names match a glob pattern, e.g. \"**/*.ts\" or \"src/**/*.{js,ts}\". Recursive from the current directory unless the pattern starts with a path.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern to match" },
            path: { type: "string", description: "Directory to search in (default .)" },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "grep",
        description: "Search file CONTENTS for a regular expression. Returns matching lines with file:line. Skips node_modules, .git and binary-ish files.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Regular expression to search for" },
            path: { type: "string", description: "File or directory to search (default .)" },
            glob: { type: "string", description: "Only search files matching this glob, e.g. \"*.ts\"" },
          },
          required: ["pattern"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "clipboard",
          description: mode === "read" ? "Read the system clipboard. Only action: read is allowed in read mode." : "Read or write the system clipboard. action: read or write; text required for write. Cross-platform.",
          parameters: {
            type: "object",
            properties: {
              action: { type: "string", enum: mode === "read" ? ["read"] : ["read", "write"] },
              text: { type: "string", description: "Text to write (for write)" },
            },
            required: ["action"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "launch_app",
          description: "Open a file, folder or application with the OS default handler. Windows: 'start', macOS: 'open', Linux: 'xdg-open'. Examples: 'notepad.exe', 'calc', a folder path to open Explorer/Finder, 'code' for VS Code.",
          parameters: {
            type: "object",
            properties: {
              target: { type: "string", description: "App name or file/folder path" },
            },
            required: ["target"],
          },
        },
      },
    {
      type: "function",
      function: {
        name: "open_url",
        description: "Open an http/https URL in the user's default browser (requires cmds/yolo permission).",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "URL to open" } },
          required: ["url"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch a URL and return the response body as text (HTML stripped to text when possible). For reading docs and APIs.",
        parameters: {
          type: "object",
          properties: { url: { type: "string", description: "URL to fetch" } },
          required: ["url"],
        },
      },
    },
  ];

  if (mode === "cmds" || mode === "yolo") {
    defs.push(
      {
        type: "function",
        function: {
          name: "write_file",
          description: "Create or overwrite a text file with the given content. Parent folders are created automatically. On Windows 11 you can write to user folders directly: \"Desktop/file.txt\", \"Documents/notes.md\", \"Downloads/\", or create project folders like \"Desktop/Code/app.py\" or \"Desktop/Tools/script.ps1\". Also supports ~/ paths.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File path to write" },
              content: { type: "string", description: "Full file content to write" },
            },
            required: ["path", "content"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "edit_file",
          description: "Replace exact text inside an existing file. old_text must match the file exactly (including whitespace). Fails without writing if not found or found more than once unless replace_all is true.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File to edit" },
              old_text: { type: "string", description: "Exact text to replace" },
              new_text: { type: "string", description: "Replacement text" },
              replace_all: { type: "boolean", description: "Replace every occurrence (default false)" },
            },
            required: ["path", "old_text", "new_text"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "move_file",
          description: "Move or rename a file/folder. Accepts Desktop/Documents/Downloads shortcuts and ~ paths. Destination parent folders are created.",
          parameters: {
            type: "object",
            properties: {
              from: { type: "string", description: "Source path" },
              to: { type: "string", description: "Destination path" },
            },
            required: ["from", "to"],
          },
        },
      },
            {
        type: "function",
        function: {
          name: "delete_file",
          description: "Send a file or folder to the OS trash/recycle bin. If trash is unavailable, returns an error and preserves the file. Permanent deletion requires permanent:true and permission.",
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "File or folder to delete" },
              permanent: { type: "boolean", description: "Explicitly permanently delete instead of using Trash. Default false." },
            },
            required: ["path"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "run_command",
          description: "Run a shell command (/bin/sh on Unix, cmd.exe on Windows). Supports cwd for another project folder and timeout_ms (up to 600000). Use background:true for servers; returns a job_id for process_status/stop_process.",
          parameters: {
            type: "object",
            properties: {
              command: { type: "string", description: "The command line to run" },
              background: { type: "boolean", description: "Run in the background for this CLI session. Returns a job ID and bounded log." },
              cwd: { type: "string", description: "Working directory, including absolute, ~/ and Desktop/Documents shortcuts. Default current directory." },
              timeout_ms: { type: "integer", minimum: 1, maximum: RUN_TIMEOUT_MS, description: "Foreground timeout in milliseconds (default 600000)." },
            },
            required: ["command"],
          },
        },
      },
    );
  }
  defs.push({
    type: "function",
    function: {
      name: "process_status", description: "Read status and recent output for a background job started in this CLI session.",
      parameters: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
    },
  });
  if (mode === "cmds" || mode === "yolo") defs.push({
    type: "function",
    function: {
      name: "stop_process", description: "Stop a background job and its child processes. Only accepts a job_id created by this CLI session.",
      parameters: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"] },
    },
  });
  return mode === "read" ? defs.filter((def) => !["launch_app", "open_url"].includes(def.function.name)) : defs;
}

export interface ToolResult {
  ok: boolean;
  output: string;
}

/** Resolve user shortcut folders — Windows 11 friendly.
 *  "Desktop", "Documents", "Downloads", "Pictures", "Videos", "Music" map to
 *  the real OS folders (%USERPROFILE%\Desktop on Win11, ~/Desktop elsewhere).
 *  Anything else returns null (not a shortcut). */
export function userFolder(name: string): string | null {
  const home = os.homedir();
  const map: Record<string, string> = {
    desktop: path.join(home, "Desktop"),
    documents: path.join(home, "Documents"),
    downloads: path.join(home, "Downloads"),
    pictures: path.join(home, "Pictures"),
    videos: path.join(home, "Videos"),
    music: path.join(home, "Music"),
  };
  return map[name.toLowerCase()] ?? null;
}

/** Resolve a tool path: supports "Desktop/foo.txt" style shortcuts + ~ expansion,
 *  then falls back to cwd-relative. Windows paths (C:\... or backslashes) resolve
 *  as absolute already. */
export function resolveToolPath(p: string, cwd: string, platform: NodeJS.Platform = process.platform, home = os.homedir()): string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  if (p === "~") return home;
  if (/^~[\\/]/.test(p)) return paths.resolve(home, p.slice(2));
  const parts = p.split(/[\\\\/]/);
  const firstSeg = parts[0] ?? "";
  const names: Record<string, string> = { desktop: "Desktop", documents: "Documents", downloads: "Downloads", pictures: "Pictures", videos: "Videos", music: "Music" };
  const folder = names[firstSeg.toLowerCase()];
  if (folder) return paths.resolve(home, folder, ...parts.slice(1));
  return paths.resolve(cwd, p);
}

function clip(s: string, max = MAX_RUN_OUTPUT): string {
  // every tool result funnels through here — enforce the global cap too
  const m = Math.min(max, MAX_TOOL_OUTPUT);
  return s.length > m ? s.slice(0, m) + `\n…(truncated at ${m} chars)` : s;
}

/** Drop wasted tokens from command output: trailing whitespace per line and
 *  long blank runs. Used only for run_command (NOT read_file — collapsing a
 *  source file's blank lines would break edit_file's exact-match). */
function squeeze(s: string): string {
  return s.replace(/[ \t]+$/gm, "").replace(/\n{4,}/g, "\n\n\n");
}

/* ───────────── glob / grep: worker thread with a time limit ───────────── */

/** Run a search off the UI thread. A folder like C:\ or a catastrophic regex
 *  used to block the event loop (frozen terminal, dead Ctrl+C); now the worker
 *  is simply terminated, and whatever it found so far is still returned. */
function searchInWorker(req: SearchRequest, signal?: AbortSignal): Promise<{ hits: string[]; scanned: number; stopped?: string; error?: string }> {
  return new Promise((resolve) => {
    const hits: string[] = [];
    let settled = false;
    const worker = new Worker(new URL("./search-worker.js", import.meta.url), { workerData: req });
    const finish = (r: { scanned: number; stopped?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      void worker.terminate();
      resolve({ hits, ...r });
    };
    const timer = setTimeout(() => finish({ scanned: -1, stopped: `timed out after ${SEARCH_TIMEOUT_MS / 1000}s — the folder is too large or the regex too slow; narrow the path, add a glob filter, or simplify the pattern` }), SEARCH_TIMEOUT_MS);
    const onAbort = () => finish({ scanned: -1, error: "Search cancelled." });
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (m: SearchMessage) => {
      if (m.type === "hit") hits.push(m.text);
      else if (m.type === "done") finish({ scanned: m.scanned, stopped: m.stopped });
      else finish({ scanned: -1, error: m.message });
    });
    worker.once("error", (e) => finish({ scanned: -1, error: e.message }));
    worker.once("exit", () => finish({ scanned: -1, error: "Search worker exited unexpectedly." }));
  });
}

function searchOutput(r: { hits: string[]; scanned: number; stopped?: string }): string {
  const body = r.hits.length ? r.hits.join("\n") : r.scanned >= 0 ? `(no matches in ${r.scanned} files)` : "(no matches)";
  return r.stopped ? `${body}\n…(search ${r.stopped.startsWith("timed out") ? "" : "stopped: "}${r.stopped})` : body;
}

/* ───────────── web ───────────── */

async function webFetch(url: string): Promise<ToolResult> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return { ok: false, output: `Invalid URL: ${url}` }; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, output: "Only http and https URLs are supported." };
  }
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), WEB_TIMEOUT_MS);
  try {
    const res = await fetch(parsed, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": "unjailed-cli/0.6 (terminal agent)" },
    });
    const type = res.headers.get("content-type") ?? "";
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > WEB_FETCH_MAX_BYTES * 2) return { ok: false, output: `Response too large (${buf.byteLength} bytes).` };
    let text = buf.toString("utf8");
    if (type.includes("html")) {
      // crude but effective html → text
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, "\n")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/[ \t]+/g, " ")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    }
    return { ok: res.ok, output: `HTTP ${res.status} ${res.statusText}\n${clip(text, WEB_FETCH_MAX_BYTES)}` };
  } catch (e) {
    const msg = (e as Error).name === "AbortError" ? `Timed out after ${WEB_TIMEOUT_MS / 1000}s` : (e as Error).message;
    return { ok: false, output: `Fetch failed: ${msg}` };
  } finally {
    clearTimeout(t);
  }
}

/** Run a helper program (clipboard, trash) without blocking the UI thread —
 *  spawnSync froze the terminal for as long as the helper took, with no limit. */
function runHelper(command: string, args: string[], opts: { input?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ status: number | null; stdout: string }> {
  return new Promise((resolve) => {
    let stdout = "";
    const child = spawn(command, args, {
      windowsHide: true, env: opts.env ?? process.env, stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "ignore"],
    });
    const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 15_000);
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.once("error", () => { clearTimeout(timer); resolve({ status: null, stdout }); });
    child.once("close", (code) => { clearTimeout(timer); resolve({ status: code, stdout }); });
    child.stdin?.on("error", () => { /* helper exited early */ });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

async function launchTarget(target: string, app = false): Promise<ToolResult> {
  const plat = process.platform;
  // Send Windows targets as data, never interpolate them into cmd/PowerShell code.
  const command = plat === "win32" ? "powershell.exe" : plat === "darwin" ? "open" : app ? target : "xdg-open";
  const args = plat === "win32"
    ? ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference='Stop'; Start-Process -FilePath $env:UNJAILED_OPEN_TARGET"]
    : plat === "darwin" ? (app ? ["-a", target] : [target]) : app ? [] : [target];
  return await new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true,
      env: { ...process.env, UNJAILED_OPEN_TARGET: target } });
    child.once("error", (err) => resolve({ ok: false, output: `Launch failed: ${err.message}` }));
    if (plat === "linux" && app) {
      child.once("spawn", () => { child.unref(); resolve({ ok: true, output: `Launched ${target}.` }); });
    } else {
      child.once("close", (code) => resolve({ ok: code === 0, output: code === 0 ? `Opened ${target}.` : `Launch failed (exit ${code}): ${target}` }));
    }
  });
}

/* ───────────── main dispatcher ───────────── */

export interface ToolExecutionOptions {
  mode?: ToolsMode;
  autoApprove?: boolean;
  signal?: AbortSignal;
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  approve?: (action: string) => Promise<boolean>,
  options: ToolExecutionOptions = {},
): Promise<ToolResult> {
  try {
    const mode = options.mode ?? "read";
    const known = toolDefinitions("yolo").some((tool) => tool.function.name === name);
    if (!known) return { ok: false, output: `Unknown tool: ${name}` };
    if (!toolDefinitions(mode).some((tool) => tool.function.name === name) ||
      (mode === "read" && name === "clipboard" && args.action !== undefined && args.action !== "read")) {
      return { ok: false, output: `${name} is unavailable in ${mode} mode. The user must select /tools cmds to allow changes.` };
    }
    if (options.signal?.aborted) return { ok: false, output: "Tool cancelled before execution." };
    const readOnly = ["read_file", "list_dir", "glob", "grep", "web_fetch", "process_status"].includes(name) ||
      (name === "clipboard" && (args.action === undefined || args.action === "read"));
    if (!readOnly && mode !== "yolo" && !options.autoApprove) {
      const action = `${name} ${JSON.stringify(args)}`;
      if (!approve || !(await approve(action))) return { ok: false, output: "The user declined or approval is unavailable. Nothing executed." };
    }
    // An approval can remain on screen while the user cancels the turn.
    if (options.signal?.aborted) return { ok: false, output: "Tool cancelled before execution." };

    if (name === "read_file") {
      const p = String(args.path ?? "");
      if (!p) return { ok: false, output: "path is required" };
      const file = resolveToolPath(p, cwd);
      const stat = fs.statSync(file);
      if (stat.isDirectory()) return { ok: false, output: `${p} is a directory (use list_dir)` };
      if (stat.size > MAX_READ_BYTES) return { ok: false, output: `${p} is ${stat.size} bytes — too large (limit ${MAX_READ_BYTES})` };
      const data = fs.readFileSync(file, "utf8");
      return { ok: true, output: clip(data) };
    }

    if (name === "list_dir") {
      const p = String(args.path ?? ".");
      const dir = resolveToolPath(p, cwd);
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      if (entries.length > MAX_LIST) return { ok: true, output: clip(entries.slice(0, MAX_LIST).map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n") + `\n…(${entries.length - MAX_LIST} more)`) };
      return { ok: true, output: entries.map((e) => (e.isDirectory() ? e.name + "/" : e.name)).join("\n") || "(empty)" };
    }

    if (name === "glob") {
      const pattern = String(args.pattern ?? "");
      if (!pattern) return { ok: false, output: "pattern is required" };
      const base = resolveToolPath(String(args.path ?? "."), cwd);
      if (!fs.statSync(base).isDirectory()) return { ok: false, output: "path must be a directory" };
      const r = await searchInWorker({ kind: "glob", base, cwd, pattern }, options.signal);
      if (r.error) return { ok: false, output: r.error };
      return { ok: true, output: clip(searchOutput(r)) };
    }

    if (name === "grep") {
      const pattern = String(args.pattern ?? "");
      if (!pattern) return { ok: false, output: "pattern is required" };
      const root = resolveToolPath(String(args.path ?? "."), cwd);
      try { new RegExp(pattern); } catch (e) { return { ok: false, output: `Invalid regex: ${(e as Error).message}` }; }
      fs.statSync(root); // a clear "no such file" error before starting the worker
      const r = await searchInWorker({ kind: "grep", root, cwd, pattern, glob: args.glob ? String(args.glob) : undefined }, options.signal);
      if (r.error) return { ok: false, output: r.error };
      return { ok: true, output: clip(searchOutput(r)) };
    }

    if (name === "clipboard") {
      const action = String(args.action ?? "read");
      const plat = process.platform;
      if (action !== "read" && action !== "write") return { ok: false, output: "Clipboard action must be read or write." };
      if (action === "write") {
        const text = String(args.text ?? "");
        if (typeof args.text !== "string") return { ok: false, output: "text is required for write" };
        const cmd = plat === "win32"
          ? "[Console]::InputEncoding = [System.Text.Encoding]::UTF8; Set-Clipboard -Value ([Console]::In.ReadToEnd())"
          : plat === "darwin" ? "pbcopy" : null;
        if (cmd === null) {
          // linux: try wl-copy then xclip
          for (const c of [["wl-copy"], ["xclip", "-selection", "clipboard"]]) {
            try {
              const r = await runHelper(c[0]!, c.slice(1), { input: text, timeoutMs: 10_000 });
              if (r.status === 0) return { ok: true, output: "Copied to clipboard." };
            } catch { /* try next */ }
          }
          return { ok: false, output: "No clipboard tool found (install xclip or wl-clipboard)." };
        }
        const r = plat === "win32"
          ? await runHelper("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { input: text, timeoutMs: 10_000 })
          : await runHelper("pbcopy", [], { input: text, timeoutMs: 10_000 });
        return r.status === 0 ? { ok: true, output: "Copied to clipboard." } : { ok: false, output: "Clipboard write failed." };
      }
      // read
      const r = plat === "win32"
        ? await runHelper("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Raw"])
        : plat === "darwin"
          ? await runHelper("pbpaste", [])
          : await runHelper("sh", ["-c", "wl-paste 2>/dev/null || xclip -selection clipboard -o 2>/dev/null"]);
      if (r.status !== 0) return { ok: false, output: "Clipboard read failed." };
      return { ok: true, output: clip(String(r.stdout ?? ""), 5_000) || "(clipboard empty)" };
    }

    if (name === "launch_app") {
      const target = String(args.target ?? "");
      if (!target) return { ok: false, output: "target is required" };
      const file = resolveToolPath(target, cwd);
      const exists = fs.existsSync(file);
      return await launchTarget(exists ? file : target, !exists);
    }

    if (name === "move_file") {
      const from = String(args.from ?? "");
      const to = String(args.to ?? "");
      if (!from || !to) return { ok: false, output: "from and to are required" };
      try {
        const src = resolveToolPath(from, cwd);
        const dst = resolveToolPath(to, cwd);
        if (!fs.existsSync(src)) return { ok: false, output: `${from} not found.` };
        if (fs.existsSync(dst)) return { ok: false, output: `${to} already exists; move refused to avoid overwriting it.` };
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
        return { ok: true, output: `Moved ${from} → ${to}.` };
      } catch (e) {
        return { ok: false, output: `Move failed: ${(e as Error).message}` };
      }
    }

    if (name === "delete_file") {
      const p2 = String(args.path ?? "");
      if (!p2) return { ok: false, output: "path is required" };
      const file = resolveToolPath(p2, cwd);
      if (!fs.existsSync(file)) return { ok: false, output: `${p2} not found.` };
      const plat = process.platform;
      if (args.permanent === true) {
        fs.rmSync(file, { recursive: true, force: false });
        return { ok: true, output: `Permanently deleted ${p2}.` };
      }
      // trash when the platform supports it
      if (plat === "win32") {
        // The path travels as data in an env var, never spliced into PowerShell code.
        const r = await runHelper("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
          `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${fs.statSync(file).isDirectory() ? "DeleteDirectory" : "DeleteFile"}($env:UNJAILED_TRASH_TARGET, 'OnlyErrorDialogs', 'SendToRecycleBin')`],
          { env: { ...process.env, UNJAILED_TRASH_TARGET: file }, timeoutMs: 30_000 });
        if (r.status === 0) return { ok: true, output: `Sent ${p2} to the Recycle Bin.` };
      } else if (plat === "darwin") {
        const r = await runHelper("osascript", ["-e", `tell application "Finder" to delete POSIX file ${JSON.stringify(file)}`], { timeoutMs: 30_000 });
        if (r.status === 0) return { ok: true, output: `Sent ${p2} to Trash.` };
      } else {
        const r = await runHelper("gio", ["trash", file], { timeoutMs: 30_000 });
        if (r.status === 0) return { ok: true, output: `Sent ${p2} to trash.` };
      }
      return { ok: false, output: `Trash unavailable for ${p2}; the file was preserved. Request permanent:true only if the user wants permanent deletion.` };
    }

    if (name === "open_url") {
      const url = String(args.url ?? "");
      if (!url) return { ok: false, output: "url is required" };
      const parsed = new URL(url);
      if (!["http:", "https:"].includes(parsed.protocol)) return { ok: false, output: "open_url accepts http/https only. Use launch_app for local files." };
      return await launchTarget(parsed.href);
    }

    if (name === "web_fetch") {
      const url = String(args.url ?? "");
      if (!url) return { ok: false, output: "url is required" };
      return await webFetch(url);
    }

    if (name === "write_file") {
      const p = String(args.path ?? "");
      const content = String(args.content ?? "");
      if (!p) return { ok: false, output: "path is required" };
      if (Buffer.byteLength(content) > MAX_WRITE_BYTES) return { ok: false, output: `Content too large (${content.length} chars, limit ${MAX_WRITE_BYTES})` };
      const file = resolveToolPath(p, cwd);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
      return { ok: true, output: `Wrote ${content.length} chars to ${p}` };
    }

    if (name === "edit_file") {
      const p = String(args.path ?? "");
      const oldText = String(args.old_text ?? "");
      const newText = String(args.new_text ?? "");
      const replaceAll = args.replace_all === true;
      if (!p || !oldText) return { ok: false, output: "path and old_text are required" };
      const file = resolveToolPath(p, cwd);
      const src = fs.readFileSync(file, "utf8");
      const count = src.split(oldText).length - 1;
      if (count === 0) return { ok: false, output: `old_text not found in ${p} — nothing written.` };
      if (count > 1 && !replaceAll) return { ok: false, output: `old_text found ${count} times in ${p} — pass replace_all or make it more specific.` };
      const next = replaceAll ? src.split(oldText).join(newText) : src.replace(oldText, newText);
      if (Buffer.byteLength(next) > MAX_WRITE_BYTES) return { ok: false, output: `Edited content exceeds ${MAX_WRITE_BYTES} bytes; nothing written.` };
      fs.writeFileSync(file, next);
      return { ok: true, output: count > 1 && !replaceAll ? `Replaced 1 of ${count} occurrences in ${p}` : `Replaced ${replaceAll ? count : 1} occurrence${replaceAll && count > 1 ? "s" : ""} in ${p}` };
    }

    if (name === "process_status") return processStatus(String(args.job_id ?? ""));
    if (name === "stop_process") return await stopProcess(String(args.job_id ?? ""));
    if (name === "run_command") {
      const command = String(args.command ?? "");
      if (!command.trim()) return { ok: false, output: "command is required" };
      const timeoutMs = args.timeout_ms === undefined ? RUN_TIMEOUT_MS : args.timeout_ms;
      if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > RUN_TIMEOUT_MS) {
        return { ok: false, output: `timeout_ms must be an integer between 1 and ${RUN_TIMEOUT_MS}.` };
      }
      const runCwd = resolveToolPath(String(args.cwd ?? cwd), cwd);
      if (!fs.statSync(runCwd).isDirectory()) return { ok: false, output: "cwd must be a directory." };
      return await runLocalCommand(command, runCwd, { background: args.background === true, timeoutMs, signal: options.signal });
    }

    return { ok: false, output: `Unknown tool: ${name}` };
  } catch (e) {
    return { ok: false, output: `Error: ${(e as Error).message}` };
  }
}
