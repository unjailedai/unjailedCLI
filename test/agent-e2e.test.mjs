// Drives the real <App> through ink-testing-library against the mock server:
// a typed prompt must reach the model with tools, the model's tool call must
// run on disk, and the follow-up turn must still be accepted by the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React from "react";
import { render } from "ink-testing-library";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");

async function startMock(t) {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["mock/server.mjs"], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => child.kill());
  let log = "";
  child.stdout.on("data", (d) => { log += d; });
  await new Promise((resolve, reject) => {
    child.stdout.on("data", () => { if (log.includes("Mock Unjailed API")) resolve(); });
    child.once("exit", () => reject(new Error(`mock exited: ${log}`)));
  });
  return { url: `http://localhost:${port}/v1`, log: () => log };
}

/** Isolated HOME/config/cwd, then import the built App fresh. */
async function setup(t, config) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "uj-e2e-home-"));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "uj-e2e-work-"));
  const prevCwd = process.cwd();
  const prevEnv = { ...process.env };
  t.after(() => {
    process.chdir(prevCwd);
    for (const k of Object.keys(process.env)) if (!(k in prevEnv)) delete process.env[k];
    Object.assign(process.env, prevEnv);
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });
  const mock = await startMock(t);
  process.env.UNJAILED_HOME = home;
  process.env.UNJAILED_BASE_URL = mock.url;
  process.env.UNJAILED_API_KEY = "sk-mock-test-a1b2";
  process.env.UNJAILED_MODEL = "glm-5.3";
  process.env.UNJAILED_NO_HISTORY = "1";
  process.env.UNJAILED_NO_FX = "1";
  if (config) fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
  process.chdir(work);
  const { App } = await import("../dist/ui/App.js");
  const app = render(React.createElement(App));
  t.after(() => app.unmount());
  const screen = () => strip(app.frames.join("\n"));
  const waitFor = async (re, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (re.test(screen())) return; await sleep(25); }
    throw new Error(`timed out waiting for ${re}\n--- screen ---\n${screen().slice(-3000)}\n--- mock ---\n${mock.log()}`);
  };
  const type = async (text) => {
    for (const ch of text) { app.stdin.write(ch); await sleep(2); }
    await sleep(30);
    app.stdin.write("\r");
  };
  return { app, work, mock, screen, waitFor, type };
}

test("a fresh install can write files: tools are on by default and approval writes to disk", async (t) => {
  const s = await setup(t, null);
  await sleep(200);
  await s.type("please mkfile");
  await s.waitFor(/Allow this action\?/);
  await sleep(200); // past the Enter-echo guard
  s.app.stdin.write("y");
  await s.waitFor(/Tool said: Wrote/);
  assert.equal(fs.readFileSync(path.join(s.work, "mock-made.txt"), "utf8"), "made by the mock\n");

  // The next turn resends the conversation; it must still be valid for the server.
  await s.type("history");
  await s.waitFor(/You've sent \*{0,2}2/);
  assert.doesNotMatch(s.mock.log(), / 400 /);
});

test("plan mode accepts a markdown-numbered plan, then executes it", async (t) => {
  const s = await setup(t, { tools: "cmds", autoMode: "auto", plan: true });
  await sleep(200);
  await s.type("mkfile with a plan");
  await s.waitFor(/Start this plan|start plan/i);
  await sleep(200);
  s.app.stdin.write("\r");
  await s.waitFor(/Tool said: Wrote/);
  assert.ok(fs.existsSync(path.join(s.work, "mock-made.txt")));
});

test("switching tools off after an agent turn still sends a valid plain chat", async (t) => {
  const s = await setup(t, { tools: "cmds", autoMode: "auto" });
  await sleep(200);
  await s.type("mkfile");
  await s.waitFor(/Tool said: Wrote/);
  await s.type("/tools off");
  await s.waitFor(/plain chat/);
  await s.type("history");
  await s.waitFor(/You've sent \*{0,2}2/);
  assert.doesNotMatch(s.mock.log(), / 400 /);
});

test("auto mode writes without prompting", async (t) => {
  const s = await setup(t, { tools: "cmds", autoMode: "auto", plan: false });
  await sleep(200);
  await s.type("mkfile now");
  await s.waitFor(/Tool said: Wrote/);
  assert.ok(fs.existsSync(path.join(s.work, "mock-made.txt")));
  assert.doesNotMatch(s.screen(), /Allow this action\?/);
});

test("declining an approval writes nothing", async (t) => {
  const s = await setup(t, { tools: "cmds", plan: false });
  await sleep(200);
  await s.type("mkfile please");
  await s.waitFor(/Allow this action\?/);
  await sleep(200);
  s.app.stdin.write("n");
  await s.waitFor(/Tool said: The user declined/);
  assert.equal(fs.existsSync(path.join(s.work, "mock-made.txt")), false);
});

test("the status line always says what the agent is doing", async (t) => {
  const s = await setup(t, { tools: "cmds", plan: false });
  await sleep(200);
  await s.type("mkfile slowfile");
  // while the model is still writing the file's contents into the tool call
  await s.waitFor(/Preparing write_file · \d+ chars/);
  // while the action waits for the user
  await s.waitFor(/Waiting for your approval · \d+s · y = allow/);
  await sleep(200);
  s.app.stdin.write("y");
  await s.waitFor(/Tool said: Wrote/);
});

test("a silent server is called out instead of looking frozen", async (t) => {
  const s = await setup(t, { tools: "cmds", plan: false });
  await sleep(200);
  await s.type("hang");
  await s.waitFor(/no data from the model for \d+s/, 15000);
  s.app.stdin.write("\x03"); // Ctrl+C stops the request
  await s.waitFor(/Stopped\./);
});
