import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ToolResult } from "./tools.js";

const OUTPUT_LIMIT = 100_000;
const jobs = new Map<string, Job>();
interface Job {
  id: string;
  child: ChildProcess;
  logFile: string;
  output: string;
  status: string;
}

/** Kill the process tree, not just the shell that launched the program. */
function killTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.resolve();
  if (process.platform !== "win32") {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch { try { child.kill("SIGKILL"); } catch { /* already exited */ } }
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    killer.once("error", () => { child.kill(); resolve(); });
    killer.once("close", () => resolve());
  });
}

export async function runLocalCommand(command: string, cwd: string, options: {
  background: boolean;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ToolResult> {
  if (options.signal?.aborted) return { ok: false, output: "Command cancelled before starting." };
  const isWin = process.platform === "win32";
  // A separate POSIX process group lets cancellation reach grandchildren too.
  const child = spawn(isWin ? (process.env.ComSpec || "cmd.exe") : "/bin/sh",
    isWin ? ["/d", "/s", "/c", `"${command}"`] : ["-c", command], {
      cwd, detached: !isWin, windowsHide: true, windowsVerbatimArguments: isWin,
      stdio: ["ignore", "pipe", "pipe"],
    });
  let job: Job | undefined;
  let logFd: number | undefined;
  let output = "";
  let stopped: string | undefined;
  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  const append = (data: Buffer) => {
    output = (output + data.toString()).slice(-OUTPUT_LIMIT);
    if (job) {
      job.output = output;
      // Bound disk usage too; servers can otherwise fill a drive overnight.
      if (logFd !== undefined) {
        try {
          const bytes = Buffer.from(output);
          const tail = bytes.subarray(Math.max(0, bytes.length - OUTPUT_LIMIT));
          fs.ftruncateSync(logFd, 0); fs.writeSync(logFd, tail, 0, tail.length, 0);
        }
        catch { /* status still retains output if the log was removed */ }
      }
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  return new Promise((resolve) => {
    const finish = (result: ToolResult) => {
      if (!settled) { settled = true; resolve(result); }
    };
    const cancel = () => {
      stopped = "cancelled";
      void killTree(child).then(() => finish({ ok: false, output: `${output.slice(-28_000)}\nCommand cancelled.` }));
    };
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", cancel);
      if (logFd !== undefined) { try { fs.closeSync(logFd); } catch { /* closed */ } logFd = undefined; }
    };
    child.once("error", (err) => {
      if (job) job.status = `failed: ${err.message}`;
      cleanup();
      finish({ ok: false, output: `Failed to start command: ${err.message}` });
    });
    let exitGrace: NodeJS.Timeout | undefined;
    child.once("close", (code, signal) => {
      clearTimeout(exitGrace);
      if (job) job.status = stopped ?? `exited ${code ?? signal}`;
      cleanup();
      finish({ ok: code === 0 && !stopped, output: `${output.slice(-28_000) || "(no output)"}\n${stopped ?? `Exit code: ${code ?? signal}`}` });
    });
    // A program the command launched ("start npm run dev", "app &") inherits the
    // output pipes and keeps them open, so "close" waits for THAT program — the
    // agent used to sit there until the 10-minute timeout. Once the command
    // itself has exited, stop waiting shortly after.
    child.once("exit", (code, signal) => {
      if (options.background) return;
      exitGrace = setTimeout(() => {
        cleanup();
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish({ ok: code === 0 && !stopped, output: `${output.slice(-28_000) || "(no output)"}\n${stopped ?? `Exit code: ${code ?? signal}`}\n(A program it started is still running and its output is no longer captured. Use background:true for servers and long-running programs.)` });
      }, 500);
    });
    options.signal?.addEventListener("abort", cancel, { once: true });
    if (options.signal?.aborted) cancel();
    child.once("spawn", () => {
      if (stopped) { void killTree(child); return; }
      if (options.background) {
        try {
          const id = randomUUID();
          const logDir = path.join(cwd, ".unjailed");
          fs.mkdirSync(logDir, { recursive: true });
          const logFile = path.join(logDir, `bg-${id}.log`);
          logFd = fs.openSync(logFile, "w", 0o600);
          job = { id, child, logFile, output, status: "running" };
          jobs.set(id, job);
          // Keep completed jobs bounded, retaining active processes for stop/status.
          for (const [oldId, oldJob] of jobs) {
            if (jobs.size <= 100) break;
            if (oldJob.status !== "running") jobs.delete(oldId);
          }
          // Background work is intentional: cancellation of a later turn does not stop it.
          options.signal?.removeEventListener("abort", cancel);
          child.unref();
          (child.stdout as unknown as { unref?: () => void })?.unref?.();
          (child.stderr as unknown as { unref?: () => void })?.unref?.();
          finish({ ok: true, output: `Started in background (pid ${child.pid}). Job ID: ${id}\nOutput: ${logFile}\nUse process_status with this job_id to read output, or stop_process to stop it. Job controls last for this CLI session.` });
        } catch (err) {
          void killTree(child);
          cleanup();
          finish({ ok: false, output: `Failed to start background logging: ${(err as Error).message}` });
        }
      } else {
        timer = setTimeout(() => {
          stopped = `Timed out after ${options.timeoutMs} ms (process tree killed). Use background:true for servers.`;
          void killTree(child).then(() => finish({ ok: false, output: `${output.slice(-28_000)}\n${stopped}` }));
        }, options.timeoutMs);
      }
    });
  });
}

export function processStatus(id: string): ToolResult {
  const job = jobs.get(id);
  if (!job) return { ok: false, output: "Unknown job_id. Only jobs started in this CLI session can be managed." };
  return { ok: true, output: `Job ${id}: ${job.status}\nOutput: ${job.logFile}\n${job.output.slice(-26_000) || "(no output yet)"}` };
}

export async function stopProcess(id: string): Promise<ToolResult> {
  const job = jobs.get(id);
  if (!job) return { ok: false, output: "Unknown job_id. Only jobs started in this CLI session can be stopped." };
  if (job.status !== "running") return { ok: true, output: `Job ${id} already ${job.status}.` };
  await killTree(job.child);
  job.status = "stopped";
  return { ok: true, output: `Stopped job ${id} and its child processes.` };
}
