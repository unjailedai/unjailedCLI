import fs from "node:fs";
import path from "node:path";

/** File search for the glob/grep tools. These functions are synchronous and run
 *  inside a worker thread (search-worker.ts), so a huge folder or a
 *  catastrophic model-written regex can never freeze the terminal UI. */

export const MAX_GLOB_RESULTS = 200;
export const MAX_GREP_RESULTS = 100;
export const MAX_GREP_FILE_BYTES = 200_000;
/** Files examined per search before giving up — keeps a search of C:\ or ~ bounded. */
export const MAX_SCAN_FILES = 100_000;

export type SearchRequest =
  | { kind: "glob"; base: string; cwd: string; pattern: string }
  | { kind: "grep"; root: string; cwd: string; pattern: string; glob?: string };

/** Streamed from the worker so a timed-out search still returns what it found. */
export type SearchMessage =
  | { type: "hit"; text: string }
  | { type: "done"; scanned: number; stopped?: string }
  | { type: "error"; message: string };

const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv"]);
/** Huge OS/app-data trees that are never what a coding search wants. Skipped
 *  while walking; searching inside one directly (path: "AppData/...") still works. */
const SKIP_SYSTEM_DIRS = new Set(["appdata", "application data", "$recycle.bin", "system volume information", "program files", "program files (x86)", "programdata"]);

export function globToRe(glob: string): RegExp {
  let re = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** — any chars including /
        re += ".*";
        i += 2;
        if (glob[i] === "/") i++; // '**/' also matches zero dirs
        continue;
      }
      re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      // simple {a,b} alternation
      let j = i + 1, depth = 1, body = "";
      while (j < glob.length && depth > 0) {
        if (glob[j] === "{") depth++;
        if (glob[j] === "}") { depth--; if (depth === 0) break; }
        body += glob[j]; j++;
      }
      re += `(?:${body.split(",").map(escapeRe).join("|")})`;
      i = j; i++;
      continue;
    } else re += escapeRe(c);
    i++;
  }
  return new RegExp(`^${re}$`);
}
function escapeRe(s: string): string {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

const posixRel = (from: string, to: string) => path.relative(from, to).split(path.sep).join("/");

function* walk(root: string, budget: { left: number }): Generator<string> {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (budget.left <= 0) return;
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".") || SKIP_SYSTEM_DIRS.has(e.name.toLowerCase())) continue;
      yield* walk(path.join(root, e.name), budget);
    } else if (e.isFile()) {
      budget.left--;
      yield path.join(root, e.name);
    }
  }
}

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

export function runSearch(req: SearchRequest, emit: (m: SearchMessage) => void): void {
  const budget = { left: MAX_SCAN_FILES };
  let hits = 0;
  let scanned = 0;
  let stopped: string | undefined;

  if (req.kind === "glob") {
    const re = globToRe(req.pattern);
    for (const file of walk(req.base, budget)) {
      scanned++;
      const rel = posixRel(req.base, file);
      if (!re.test(rel) && !re.test(rel.split("/").pop() ?? "")) continue;
      emit({ type: "hit", text: path.relative(req.cwd, file) });
      if (++hits >= MAX_GLOB_RESULTS) { stopped = `showing the first ${MAX_GLOB_RESULTS} matches`; break; }
    }
  } else {
    const re = new RegExp(req.pattern);
    const only = req.glob ? globToRe(req.glob) : null;
    const isFile = fs.statSync(req.root).isFile();
    const files = isFile ? [req.root] : walk(req.root, budget);
    outer: for (const file of files) {
      scanned++;
      if (only) {
        const rel = posixRel(req.cwd, file);
        if (!only.test(rel.split("/").pop() ?? "") && !only.test(rel)) continue;
      }
      let buf: Buffer;
      try { buf = fs.readFileSync(file); } catch { continue; }
      if (buf.byteLength > MAX_GREP_FILE_BYTES || looksBinary(buf)) continue;
      const lines = buf.toString("utf8").split("\n");
      for (let n = 0; n < lines.length; n++) {
        if (!re.test(lines[n]!)) continue;
        emit({ type: "hit", text: `${path.relative(req.cwd, file)}:${n + 1}: ${lines[n]!.trim().slice(0, 200)}` });
        if (++hits >= MAX_GREP_RESULTS) { stopped = `showing the first ${MAX_GREP_RESULTS} matches`; break outer; }
      }
    }
  }
  if (!stopped && budget.left <= 0) stopped = `gave up after scanning ${MAX_SCAN_FILES.toLocaleString("en-US")} files`;
  emit({ type: "done", scanned, stopped });
}
