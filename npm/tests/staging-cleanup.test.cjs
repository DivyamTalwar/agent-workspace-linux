#!/usr/bin/env node
// staging-cleanup.test.cjs — leftover staging directories are bounded.
//
// Catchable signals (Ctrl-C, SIGTERM) remove the live staging directory before
// the process dies; SIGKILL/power-loss leftovers are swept on the next run once
// they are clearly abandoned. Fresh directories are never touched because they
// may belong to a concurrent installer.
"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const SCRIPTS_DIR = path.join(__dirname, "..", "scripts");
const SOURCE_PATH = path.join(SCRIPTS_DIR, "postinstall.js");

function makeBinDir(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ws-staging-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const binDir = path.join(root, "bin");
  fs.mkdirSync(binDir);
  return { root, binDir };
}

test("sweepStaleStagingDirs removes abandoned staging dirs and keeps fresh ones", (t) => {
  const { root, binDir } = makeBinDir(t);
  // Load the module with __dirname pointed at a fixture so binDir resolves under root.
  const scriptsDir = path.join(root, "scripts");
  fs.mkdirSync(scriptsDir);
  fs.copyFileSync(SOURCE_PATH, path.join(scriptsDir, "postinstall.js"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.0.0" }));
  const mod = require(path.join(scriptsDir, "postinstall.js"));

  const stale = fs.mkdtempSync(path.join(binDir, ".staging-"));
  const fresh = fs.mkdtempSync(path.join(binDir, ".staging-"));
  const unrelated = path.join(binDir, "keep-me");
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(stale, "partial"), "x");
  const old = new Date(Date.now() - mod.STALE_STAGING_MS - 60_000);
  fs.utimesSync(stale, old, old);

  mod.sweepStaleStagingDirs();

  assert.equal(fs.existsSync(stale), false, "stale staging dir survived the sweep");
  assert.equal(fs.existsSync(fresh), true, "fresh staging dir was removed");
  assert.equal(fs.existsSync(unrelated), true, "non-staging dir was removed");
});

test("SIGTERM during download removes the staging directory", async (t) => {
  const { root, binDir } = makeBinDir(t);
  const scriptsDir = path.join(root, "scripts");
  fs.mkdirSync(scriptsDir);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "0.0.0" }));
  fs.copyFileSync(SOURCE_PATH, path.join(scriptsDir, "postinstall.js"));

  // Replace https.get with a request that opens the response and then stalls
  // forever, so the installer is parked inside its staging directory when the
  // signal arrives. No network involved.
  const shim = `
    const https = require("https");
    const { PassThrough } = require("node:stream");
    const { EventEmitter } = require("node:events");
    https.get = (url, options, cb) => {
      if (typeof options === "function") cb = options;
      const res = new PassThrough();
      res.statusCode = 200;
      res.headers = { "content-type": "application/octet-stream" };
      res.write("partial");
      // Keep the response (and the event loop) alive: a real stalled socket
      // holds a handle; a PassThrough does not, so pin one explicitly.
      const keepAlive = setInterval(() => {}, 1000);
      res.on("close", () => clearInterval(keepAlive));
      setImmediate(() => cb(res));
      const req = new EventEmitter();
      req.destroy = () => {};
      req.setTimeout = () => req;
      return req;
    };
    require(${JSON.stringify(path.join(scriptsDir, "postinstall.js"))});
  `;
  // Preload the shim so postinstall.js is still the main module.
  const shimPath = path.join(scriptsDir, "shim.js");
  fs.writeFileSync(shimPath, shim.replace(/\n\s*require\([^)]*\);\s*$/, "\n"));

  const child = spawn(process.execPath, ["--require", shimPath, path.join(scriptsDir, "postinstall.js")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));
  child.stdout.on("data", (d) => (stderr += d));

  const deadline = Date.now() + 5000;
  let staging = [];
  while (Date.now() < deadline) {
    staging = fs.existsSync(binDir)
      ? fs.readdirSync(binDir).filter((n) => n.startsWith(".staging-"))
      : [];
    if (staging.length > 0) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(staging.length, 1, `staging dir never appeared; stderr: ${stderr}`);

  child.kill("SIGTERM");
  const [code, signal] = await new Promise((resolve) =>
    child.on("exit", (c, s) => resolve([c, s]))
  );
  assert.equal(signal, "SIGTERM", `expected death by SIGTERM, got code=${code} signal=${signal}; stderr: ${stderr}`);

  const leftovers = fs.readdirSync(binDir).filter((n) => n.startsWith(".staging-"));
  assert.deepEqual(leftovers, [], "staging dir leaked after SIGTERM");
});
