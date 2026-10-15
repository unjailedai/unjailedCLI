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

export const RELEASE_FLOOR = "0.12.11";

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

export type UpdatePlan = { status: "available" | "current" | "ahead" | "unavailable"; message: string; target?: string };

/** A local version/floor is not evidence that a package exists on npm. */
export function planUpdate(current: string, floor: string, latest: string | null): UpdatePlan {
  if (!parseVersion(current) || !parseVersion(floor)) return { status: "unavailable", message: "Couldn't verify this build's version. Nothing installed." };
  if (!latest || !parseVersion(latest)) return { status: "unavailable", message: "Couldn't verify npm's published version. Nothing installed; check your connection and try again." };
  if (compareVersions(latest, current) < 0 || compareVersions(latest, floor) < 0) return {
    status: "ahead", message: `Running ${current}; npm currently lists ${latest}. No downgrade or reinstall attempted. If this terminal was open during an installation, exit and reopen it to load that build.`,
  };
  if (compareVersions(latest, current) === 0) return { status: "current", message: `You're on the latest npm version (${current}).` };
  return { status: "available", target: latest, message: `Updating ${current} → ${latest}…` };
}

// POSIX never needs a shell. Windows npm.cmd uses one fixed command string,
// with only a validated semver interpolated by the caller (no user arguments).
function spawnNpm(args: string[]) {
  return process.platform === "win32"
    ? spawn([npmCmd(), ...args].join(" "), { shell: true, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(npmCmd(), args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
}

/** `npm view unjailed version` — latest published. */
export function latestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawnNpm(["view", "unjailed", "version"]);
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

/** Install only a newer version verified from npm. Windows-safe:
 *  the running install's npm shims are locked while we execute, so we move
 *  the current package dir aside first (npm then writes a fresh one instead
 *  of half-updating in place — the "updated but old after restart" bug). */
export async function runSelfUpdate(onLine: (line: string) => void): Promise<{ status: "updated" | "unchanged" | "unavailable" | "failed"; message: string }> {
  const plan = planUpdate(currentVersion(), RELEASE_FLOOR, await latestVersion());
  if (plan.status !== "available") return { status: plan.status === "unavailable" ? "unavailable" : "unchanged", message: plan.message };
  const target = plan.target!;
  onLine(plan.message);
  onLine(`Installing unjailed@${target}`);
  return new Promise((resolve) => {
    const pre = preflightWindows();
    const child = spawnNpm(["install", "-g", `unjailed@${target}`, ...(pre ? ["--force"] : [])]);
    let timedOut = false;
    const t = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 300_000);
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      const restored = !ok && pre ? restoreWindows(pre) : true;
      resolve(ok
        ? { status: "updated", message: `Installed ${target}. Exit and reopen the CLI to load it.` }
        : { status: "failed", message: `The update to ${target} failed.${restored ? "" : ` Previous files are preserved at ${pre && pre.backup}.` } Restart the CLI to check your installed version. Retry /update when npm is available; do not downgrade with @latest.` });
    };
    child.stdout?.on("data", (d) => d.toString().split("\n").forEach(onLine));
    child.stderr?.on("data", (d) => d.toString().split("\n").forEach(onLine));
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0 && !timedOut));
  });
}

type WindowsBackup = { dir: string; backup: string };
function preflightWindows(): WindowsBackup | null {
  if (process.platform !== "win32") return null;
  try {
    // locate the global node_modules like npm does
    const prefix = execSync(`${npmCmd()} config get prefix`, {
      encoding: "utf8", timeout: 20_000,
      shell: process.platform === "win32" ? (process.env.ComSpec || "cmd.exe") : "/bin/sh",
    }).trim();
    const dir = path.join(prefix, "node_modules", "unjailed");
    if (fs.existsSync(dir)) {
      const stamp = Date.now();
      const backup = dir + "-old-" + stamp;
      fs.renameSync(dir, backup);
      // old copies get cleaned by npm's next prune; the rename unblocks the install
      return { dir, backup };
    }
    return null;
  } catch {
    return null;
  }
}

function restoreWindows({ dir, backup }: WindowsBackup): boolean {
  try {
    if (fs.existsSync(dir)) fs.renameSync(dir, dir + "-failed-" + Date.now());
    fs.renameSync(backup, dir);
    return true;
  } catch { return false; }
}
