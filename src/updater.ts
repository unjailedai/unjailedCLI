import { execSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { VERSION } from "./constants.js";

/** npm executable — npm.cmd on Windows (batch file needs shell:true). */
function npmCmd(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

export function currentVersion(): string {
  return VERSION;
}

export const RELEASE_FLOOR = "0.12.10";

function parseVersion(value: string): { core: bigint[]; pre: string[] } | null {
  if (value.length > 128) return null;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
  if (!match) return null;
  const pre = match[4]?.split(".") ?? [];
  if (pre.some((part) => /^0\d+$/.test(part))) return null;
  return { core: match.slice(1, 4).map((part) => BigInt(part!)), pre };
}

function compareVersions(a: string, b: string): number {
  const left = parseVersion(a)!;
  const right = parseVersion(b)!;
  for (let i = 0; i < 3; i++) {
    if (left.core[i]! !== right.core[i]!) return left.core[i]! > right.core[i]! ? 1 : -1;
  }
  if (!left.pre.length || !right.pre.length) return left.pre.length === right.pre.length ? 0 : left.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

/** An explicit, validated package pin: latest may lag, fail, or report garbage. */
export function selectUpdateVersion(current: string, floor: string, latest: string | null): string {
  if (!parseVersion(floor)) throw new Error("Invalid release floor");
  let selected = floor;
  for (const candidate of [current, latest]) {
    if (candidate && parseVersion(candidate) && compareVersions(candidate, selected) > 0) selected = candidate;
  }
  return selected;
}

/** `npm view unjailed version` — latest published. */
export function latestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(npmCmd(), ["view", "unjailed", "version"], { shell: true, stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    const t = setTimeout(() => { child.kill("SIGKILL"); resolve(null); }, 20_000);
    child.stdout?.on("data", (d) => { out += d.toString(); });
    child.on("error", () => { clearTimeout(t); resolve(null); });
    child.on("close", (code) => {
      clearTimeout(t);
      resolve(code === 0 ? out.trim().split("\n").pop() ?? null : null);
    });
  });
}

/** `npm install -g unjailed@max(current,floor,latest)`. Windows-safe:
 *  the running install's npm shims are locked while we execute, so we move
 *  the current package dir aside first (npm then writes a fresh one instead
 *  of half-updating in place — the "updated but old after restart" bug). */
export async function runSelfUpdate(onLine: (line: string) => void): Promise<boolean> {
  const target = selectUpdateVersion(currentVersion(), RELEASE_FLOOR, await latestVersion());
  onLine(`Installing unjailed@${target}`);
  return new Promise((resolve) => {
    const pre = preflightWindows();
    const args = `install -g unjailed@${target}` + (pre ? " --force" : "");
    const child = spawn(npmCmd() + " " + args, { shell: true });
    let ok = true;
    const t = setTimeout(() => { child.kill("SIGKILL"); ok = false; }, 300_000);
    child.stdout?.on("data", (d) => d.toString().split("\n").forEach(onLine));
    child.stderr?.on("data", (d) => d.toString().split("\n").forEach((l: string) => { ok = l.toLowerCase().includes("error") ? false : ok; onLine(l); }));
    child.on("error", () => { clearTimeout(t); resolve(false); });
    child.on("close", (code) => { clearTimeout(t); resolve(code === 0 && ok); });
  });
}

function preflightWindows(): boolean {
  if (process.platform !== "win32") return false;
  try {
    // locate the global node_modules like npm does
    const prefix = execSync(`${npmCmd()} config get prefix`, {
      encoding: "utf8", timeout: 20_000,
      shell: process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/sh",
    }).trim();
    const dir = path.join(prefix, "node_modules", "unjailed");
    if (fs.existsSync(dir)) {
      const stamp = Date.now();
      fs.renameSync(dir, dir + "-old-" + stamp);
      // old copies get cleaned by npm's next prune; the rename unblocks the install
    }
    return true;
  } catch {
    return false;
  }
}
