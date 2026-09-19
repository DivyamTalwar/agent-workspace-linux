#!/usr/bin/env node
"use strict";

// Behavioural tests for npm/bin/agent-workspace-linux.js.
//
// Each test copies the real launcher into a disposable temp directory next to a
// synthetic "native binary" (a small script run through process.execPath), then
// spawns the copied launcher as a real subprocess and asserts on how the
// parent's own exit status reflects the child's.

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const LAUNCHER_SRC = path.join(__dirname, "..", "bin", "agent-workspace-linux.js");
const BINARY_NAME = "agent-workspace-linux";
const WATCHDOG_MS = 10000;

// Creates a temp dir holding a copy of the launcher; `binaryBody` (when given)
// becomes the synthetic native binary the launcher execs.
function makeFixture(t, binaryBody, { executable = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-launcher-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const launcher = path.join(dir, "agent-workspace-linux.js");
  fs.copyFileSync(LAUNCHER_SRC, launcher);

  if (binaryBody !== null) {
    const binary = path.join(dir, BINARY_NAME);
    fs.writeFileSync(binary, `#!${process.execPath}\n${binaryBody}\n`);
    fs.chmodSync(binary, executable ? 0o755 : 0o644);
  }
  return launcher;
}

// Runs the copied launcher and resolves with its own exit status. A watchdog
// kills only this test-owned subprocess if it never settles.
function runLauncher(launcher, args = [], onStdout) {
  const child = spawn(process.execPath, [launcher, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const settled = new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; if (onStdout) onStdout(stdout, child); });
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const watchdog = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`launcher did not exit within ${WATCHDOG_MS}ms`));
    }, WATCHDOG_MS);

    child.on("error", (err) => {
      clearTimeout(watchdog);
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(watchdog);
      resolve({ code, signal, stdout, stderr });
    });
  });
  settled.pid = child.pid;
  return settled;
}

test("child killed by SIGINT makes the launcher itself die of SIGINT", async (t) => {
  const launcher = makeFixture(t, 'process.kill(process.pid, "SIGINT");');
  const result = await runLauncher(launcher);
  assert.equal(
    result.signal,
    "SIGINT",
    `expected signalled death, got signal=${result.signal} code=${result.code}`
  );
  assert.equal(result.code, null);
});

test("launcher still ignores a SIGINT of its own while the child runs", async (t) => {
  const launcher = makeFixture(
    t,
    'process.stdout.write("ready:"); setTimeout(() => { process.stdout.write("done"); }, 600);'
  );
  let signalled = false;
  const result = await runLauncher(launcher, [], (stdout, child) => {
    if (!signalled && stdout.includes("ready:")) {
      signalled = true;
      // Readiness comes from the spawned child: the parent's handler is now
      // installed, regardless of Node bootstrap speed on a busy test host.
      child.kill("SIGINT");
    }
  });
  assert.equal(signalled, true);
  assert.equal(result.signal, null);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "ready:done");
});

test("child killed by SIGTERM makes the launcher itself die of SIGTERM", async (t) => {
  const launcher = makeFixture(t, 'process.kill(process.pid, "SIGTERM");');
  const result = await runLauncher(launcher);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.code, null);
});

test("child exiting 0 exits the launcher 0", async (t) => {
  const launcher = makeFixture(t, 'process.stdout.write("ok"); process.exit(0);');
  const result = await runLauncher(launcher);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "ok");
});

test("child exiting 7 exits the launcher 7", async (t) => {
  const launcher = makeFixture(t, "process.exit(7);");
  const result = await runLauncher(launcher);
  assert.equal(result.code, 7);
  assert.equal(result.signal, null);
});

test("launcher forwards argv to the native binary", async (t) => {
  const launcher = makeFixture(
    t,
    'process.stdout.write(JSON.stringify(process.argv.slice(2)));'
  );
  const result = await runLauncher(launcher, ["doctor", "--json", "a b"]);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.stdout), ["doctor", "--json", "a b"]);
});

test("missing native binary exits 1 with install guidance", async (t) => {
  const launcher = makeFixture(t, null);
  const result = await runLauncher(launcher);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /native binary not found/);
});

test("non-executable native binary exits 1 with a start failure", async (t) => {
  const launcher = makeFixture(t, "process.exit(0);", { executable: false });
  const result = await runLauncher(launcher);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /failed to start binary/);
});
