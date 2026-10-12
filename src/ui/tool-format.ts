import stringWidth from "string-width";
import { theme, tone } from "../theme.js";
import { sanitizeForDisplay } from "./sanitize.js";

/** How a tool call reads in the transcript:
 *
 *    ● Update(src/calc.py)
 *      ⎿  Updated src/calc.py · 1 line removed, 1 added
 *         2 -     return a-b
 *         2 +     return a+b
 */

type Args = Record<string, unknown>;

const LABELS: Record<string, string> = {
  read_file: "Read",
  list_dir: "List",
  glob: "Glob",
  grep: "Search",
  write_file: "Write",
  edit_file: "Update",
  move_file: "Move",
  delete_file: "Delete",
  run_command: "Bash",
  process_status: "Job",
  stop_process: "Stop",
  web_fetch: "Fetch",
  open_url: "Open",
  launch_app: "Launch",
  clipboard: "Clipboard",
  search_history: "History",
  agent: "Agent",
  workflow: "Workflow",
  schedule_next: "Schedule",
};

export function parseArgs(raw: string): Args {
  try {
    const v = JSON.parse(raw || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Args) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown) => sanitizeForDisplay(typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

/** Shorten to `max` visible columns with a trailing ellipsis; never splits a surrogate pair. */
export function clip(text: string, max: number): string {
  const one = text.replace(/\s*\n\s*/g, " ⏎ ");
  if (stringWidth(one) <= max) return one;
  let out = "";
  for (const ch of one) {
    if (stringWidth(out + ch) > max - 1) break;
    out += ch;
  }
  return out + "…";
}

/** The argument shown in parentheses after the tool's label. */
function subject(name: string, a: Args): string {
  switch (name) {
    case "run_command":
      return str(a.command) + (a.background ? " &" : "");
    case "grep":
      return `"${str(a.pattern)}"${a.path ? ` in ${str(a.path)}` : ""}${a.glob ? ` (${str(a.glob)})` : ""}`;
    case "glob":
      return str(a.pattern) + (a.path ? ` in ${str(a.path)}` : "");
    case "move_file":
      return `${str(a.from ?? a.source)} → ${str(a.to ?? a.destination)}`;
    case "web_fetch":
    case "open_url":
      return str(a.url);
    case "launch_app":
      return str(a.app ?? a.name) + (a.target ? ` ${str(a.target)}` : "");
    case "clipboard":
      return str(a.action ?? "read");
    case "process_status":
    case "stop_process":
      return str(a.job_id);
    case "search_history":
      return str(a.query ?? a.entry);
    case "agent":
      return str(a.description ?? a.prompt);
    case "workflow":
      return str(a.name) || workflowName(str(a.script)) || "script";
    case "schedule_next":
      return a.stop ? "stop" : `${str(a.delay_seconds)}s`;
    case "list_dir":
      return str(a.path ?? ".") || ".";
    default:
      return str(a.path ?? a.file ?? "");
  }
}

function workflowName(script: string): string {
  return script.match(/name\s*:\s*["'`]([^"'`]+)["'`]/)?.[1] ?? "";
}

/** clip() for text that already carries color codes: escapes take no columns. */
export function clipAnsi(text: string, max: number): string {
  if (stringWidth(text) <= max) return text;
  let out = "";
  let width = 0;
  for (const tok of text.match(/\x1b\[[0-9;]*m|./gsu) ?? []) {
    if (tok.startsWith("\x1b")) { out += tok; continue; }
    const w = stringWidth(tok);
    if (width + w > max - 1) break;
    out += tok;
    width += w;
  }
  return out + "…\x1b[0m";
}

/** "Update(src/calc.py)" — the bold label plus a clipped subject. */
export type ToolKind = "read" | "edit" | "shell" | "web" | "agent" | "other";

/** What kind of work a tool does (stats and colors). */
export function toolKind(name: string): ToolKind {
  if (["read_file", "list_dir", "glob", "grep", "search_history", "process_status", "clipboard"].includes(name)) return "read";
  if (["write_file", "edit_file", "move_file", "delete_file"].includes(name)) return "edit";
  if (["run_command", "stop_process", "launch_app"].includes(name)) return "shell";
  if (["web_fetch", "open_url"].includes(name)) return "web";
  if (["agent", "workflow", "schedule_next"].includes(name)) return "agent";
  return "other";
}

/** The color family of a tool: reading, editing, shell, web or agents. */
export function toolTone(name: string): (s: string) => string {
  if (["read_file", "list_dir", "glob", "grep", "search_history", "process_status", "clipboard"].includes(name)) return tone.read;
  if (["write_file", "edit_file", "move_file", "delete_file"].includes(name)) return tone.edit;
  if (["run_command", "stop_process", "launch_app"].includes(name)) return tone.shell;
  if (["web_fetch", "open_url"].includes(name)) return tone.web;
  if (["agent", "workflow", "schedule_next"].includes(name)) return tone.agent;
  return tone.tool;
}

export function toolTitle(name: string, args: Args, width = 100): string {
  const label = LABELS[name] ?? name;
  const sub = subject(name, args);
  const room = Math.max(12, width - stringWidth(label) - 6);
  const head = theme.bold(toolTone(name)(label));
  return sub ? `${head}${theme.dim("(")}${clip(sub, room)}${theme.dim(")")}` : head;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Show at most `max` lines of output, then a dim "… +N lines" tail. */
function headLines(text: string, max: number, width: number): string[] {
  const lines = text.replace(/^\s*\n/, "").replace(/\s+$/, "").split("\n");
  const shown = lines.slice(0, max).map((l) => clip(l.replace(/\t/g, "  "), width));
  if (lines.length > max) shown.push(theme.dim(`… +${lines.length - max} lines`));
  return shown;
}

/** A compact colored diff for edit_file. Lines the edit leaves unchanged at
 *  the start and end are shown once as dim context, not as removed + added. */
function editDiff(a: Args, width: number): string[] {
  let before = str(a.old_text ?? a.old_string).split("\n");
  let after = str(a.new_text ?? a.new_string).split("\n");
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  const lead = before.slice(0, head);
  const trail = before.slice(before.length - tail);
  before = before.slice(head, before.length - tail);
  after = after.slice(head, after.length - tail);
  const rows: string[] = [];
  const max = 8;
  const line = (sign: " " | "-" | "+", text: string) => {
    const body = clip(`${sign} ${text}`, width);
    rows.push(sign === "-" ? theme.err(body) : sign === "+" ? theme.ok(body) : theme.dim(body));
  };
  lead.slice(-1).forEach((l) => line(" ", l));
  before.slice(0, max).forEach((l) => line("-", l));
  if (before.length > max) rows.push(theme.dim(`  … ${before.length - max} more removed`));
  after.slice(0, max).forEach((l) => line("+", l));
  if (after.length > max) rows.push(theme.dim(`  … ${after.length - max} more added`));
  trail.slice(0, 1).forEach((l) => line(" ", l));
  return rows;
}

/** Lines removed and added by an edit, ignoring unchanged lines at either end. */
function editCounts(a: Args): { removed: number; added: number } {
  const before = str(a.old_text ?? a.old_string).split("\n");
  const after = str(a.new_text ?? a.new_string).split("\n");
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head++;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++;
  return { removed: before.length - head - tail, added: after.length - head - tail };
}

/** The lines under "⎿" that summarise a finished call. */
export function toolSummary(name: string, args: Args, ok: boolean, output: string, width = 100, verbose = false): string[] {
  const w = Math.max(20, width - 8);
  // Verbose (/verbose) shows up to 40 lines of output instead of a short preview.
  const n = (lines: number) => (verbose ? Math.max(lines, 40) : lines);
  const out = sanitizeForDisplay(output).replace(/\s+$/, "");
  if (!ok) {
    const exit = name === "run_command" ? out.match(/\n(Exit code: \S+|Stopped[^\n]*|Timed out[^\n]*)$/)?.[1] : undefined;
    if (exit) {
      const body = out.slice(0, out.length - exit.length).trimEnd();
      return [theme.err(exit), ...(body && body !== "(no output)" ? headLines(body, n(4), w).map((l) => theme.dim(l)) : [])];
    }
    const lines = headLines(out || "Failed", n(3), w);
    return [theme.err(lines[0]!), ...lines.slice(1).map((l) => theme.dim(l))];
  }
  const count = out ? out.split("\n").length : 0;
  const detail = () => (verbose && out && !/^\((empty|no matches)\)$/.test(out) ? headLines(out, 40, w).map((l) => theme.dim(l)) : []);
  switch (name) {
    case "read_file":
      return [`Read ${theme.bold(plural(count, "line"))}`, ...detail()];
    case "list_dir":
      return [out === "(empty)" ? "Empty directory" : `Listed ${theme.bold(plural(count, "entry").replace("entrys", "entries"))}`, ...detail()];
    case "glob":
      return [out === "(no matches)" ? "No files found" : `Found ${theme.bold(plural(count, "file"))}`, ...detail()];
    case "grep":
      return [out === "(no matches)" ? "No matches" : `Found ${theme.bold(plural(count, "match").replace("matchs", "matches"))}`, ...detail()];
    case "write_file": {
      const lines = str(args.content).split("\n").length;
      return [`Wrote ${theme.bold(plural(lines, "line"))} to ${str(args.path)}`];
    }
    case "edit_file": {
      const { removed, added } = editCounts(args);
      return [`Updated ${str(args.path)} · ${plural(removed, "line")} removed, ${added} added`, ...editDiff(args, w)];
    }
    case "agent":
      return headLines(out, n(3), w).map((l) => theme.dim(l));
    case "workflow": {
      const result = out.split("\n\nResult:\n")[1]?.split("\n\nLog:\n")[0];
      const head = out.split("\n")[0]!;
      if (!result) return /^Workflow ".*" finished/.test(head) ? [] : headLines(out, n(3), w);
      let compact = result;
      try { compact = JSON.stringify(JSON.parse(result)); } catch { /* plain text result */ }
      return [head, ...headLines(compact, n(2), w).map((l) => theme.dim(l))];
    }
    case "run_command": {
      // The model gets "…output\nExit code: N"; people only need the code when it isn't 0.
      const body = out.replace(/\n*Exit code: 0$/, "").replace(/^\(no output\)$/, "").trimEnd();
      return body ? headLines(body, n(4), w).map((l) => theme.dim(l)) : [theme.dim("(no output)")];
    }
    case "web_fetch":
    case "process_status":
      return out ? headLines(out, n(4), w).map((l) => theme.dim(l)) : [theme.dim("(no output)")];
    default:
      return out ? headLines(out, n(2), w).map((l) => theme.dim(l)) : [theme.dim("Done")];
  }
}

/** The complete transcript block for a finished tool call. */
export function formatToolBlock(name: string, rawArgs: string, ok: boolean, output: string, width: number, note?: string, verbose = false): string {
  const args = parseArgs(rawArgs);
  const dot = ok ? theme.ok("●") : theme.err("●");
  let summary = toolSummary(name, args, ok, output, width, verbose);
  // Subagent stats lead the block: "Done (4 tool uses · 2.1k tokens · 18s)".
  if (note) {
    if (name === "workflow") summary = summary.slice(1); // the note already says agents and time
    summary = [`${ok ? "Done" : theme.err("Failed")} ${theme.dim(`(${note})`)}`, ...(ok ? summary : summary.slice(0, 2))];
  }
  const lines = [`${dot} ${toolTitle(name, args, width)}`];
  summary.forEach((l, i) => lines.push(`${i === 0 ? theme.dim("  ⎿  ") : "     "}${clipAnsi(l, Math.max(10, width - 6))}`));
  return lines.join("\n");
}

/** One-line human description used by approval prompts. */
export function describeAction(name: string, args: Args, width = 100): string {
  return toolTitle(name, args, width);
}
