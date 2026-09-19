#!/usr/bin/env node
"use strict";

// Drives the real postinstall `main()` inside a vm context holding the WHOLE
// unchanged script, against a real temp filesystem, with a fake https module
// and a narrow fs.chmodSync fault injection. Asserts the published binary is
// already executable at the moment of the rename, that checksum verification
// completes before any chmod/publication, and that a chmod failure preserves
// the previously installed binary.

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const vm = require("node:vm");
const { Readable } = require("node:stream");

const SCRIPT_PATH = path.join(__dirname, "..", "scripts", "postinstall.js");
const SCRIPT_SOURCE = fs.readFileSync(SCRIPT_PATH, "utf8");
const ASSET = "agent-workspace-linux-x86_64-unknown-linux-gnu";
const BINARY = Buffer.from("#!/bin/sh\nexit 0\n");

function makeSandbox(root, { chmodFails = false } = {}) {
  const events = [];
  const exits = [];
  const streams = [];
  const scriptsDir = path.join(root, "scripts");
  const destPath = path.join(root, "bin", "agent-workspace-linux");
  const tmpPath = `${destPath}.tmp`;
  const sidecar = `${crypto.createHash("sha256").update(BINARY).digest("hex")}  ${ASSET}\n`;

  const writtenPaths = [];
  const fakeFs = Object.create(fs);
  fakeFs.createWriteStream = (file, ...rest) => {
    writtenPaths.push(file);
    const stream = fs.createWriteStream(file, ...rest);
    streams.push(stream);
    return stream;
  };
  fakeFs.createReadStream = (file, ...rest) => {
    const stream = fs.createReadStream(file, ...rest);
    streams.push(stream);
    if (file === writtenPaths[0]) {
      stream.on("end", () => events.push("checksum-read-complete"));
    }
    return stream;
  };
  fakeFs.chmodSync = (file, mode) => {
    events.push(`chmod:${path.basename(file)}:${mode.toString(8)}`);
    if (chmodFails) {
      const err = new Error("operation not permitted");
      err.code = "EPERM";
      throw err;
    }
    return fs.chmodSync(file, mode);
  };
  fakeFs.renameSync = (from, to) => {
    // Observe the staging file exactly as a concurrent reader would see the
    // file that is about to become the published binary.
    events.push(
      `rename:${(fs.statSync(from).mode & 0o777).toString(8)}`
    );
    return fs.renameSync(from, to);
  };

  const fakeHttps = {
    get(url, _opts, cb) {
      const body = url.endsWith(".sha256") ? Buffer.from(sidecar) : BINARY;
      const res = new Readable({
        read() {
          this.push(body);
          this.push(null);
        },
      });
      res.statusCode = 200;
      res.headers = {};
      streams.push(res);
      setImmediate(() => cb(res));
      const req = new EventEmitter();
      req.destroy = () => { req.destroyed = true; req.emit("close"); return req; };
      return req;
    },
  };

  let settle;
  const finished = new Promise((resolve) => {
    settle = resolve;
  });

  const fakeRequire = (id) => {
    if (id === "fs") return fakeFs;
    if (id === "https") return fakeHttps;
    if (id === "../package.json") return { version: "0.3.2" };
    return require(id);
  };
  const module_ = { exports: {} };
  fakeRequire.main = module_;

  const context = vm.createContext({
    require: fakeRequire,
    module: module_,
    exports: module_.exports,
    __dirname: scriptsDir,
    __filename: path.join(scriptsDir, "postinstall.js"),
    Promise,
    Buffer,
    setImmediate,
    setTimeout,
    clearTimeout,
    console: {
      log: (msg) => {
        if (String(msg).includes("binary installed at")) settle();
      },
      error: () => {},
    },
    process: {
      platform: "linux",
      arch: "x64",
      exit: (code) => {
        exits.push(code);
        settle();
        // Abort like a real exit would — but only once, so the script's own
        // top-level catch can finish instead of rejecting unobserved.
        if (exits.length === 1) {
          throw new Error(`process.exit(${code})`);
        }
      },
    },
  });

  return {
    context,
    events,
    exits,
    finished,
    destPath,
    get tmpPath() { return writtenPaths[0] ?? tmpPath; },
    get tmpChecksumPath() { return writtenPaths[1] ?? `${tmpPath}.sha256`; },
    cleanupStreams: () => streams.forEach((s) => s.destroy()),
  };
}

async function runInstaller(root, opts) {
  const sandbox = makeSandbox(root, opts);
  vm.runInContext(SCRIPT_SOURCE, sandbox.context, { filename: SCRIPT_PATH });
  await Promise.race([
    sandbox.finished,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("installer did not settle")), 5000).unref()
    ),
  ]);
  // Let any trailing error handling in the script drain before asserting.
  await new Promise((resolve) => setImmediate(resolve));
  sandbox.cleanupStreams();
  return sandbox;
}

function withTempRoot(fn) {
  return async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ws-exec-pub-"));
    try {
      await fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

test(
  "should publish an already-executable binary after checksum verification",
  withTempRoot(async (root) => {
    const run = await runInstaller(root);

    assert.deepEqual(run.exits, []);
    assert.equal(fs.readFileSync(run.destPath).equals(BINARY), true);
    assert.equal(fs.statSync(run.destPath).mode & 0o111, 0o111);

    const renameEvent = run.events.find((e) => e.startsWith("rename:"));
    assert.ok(renameEvent, "installer never renamed the staging file");
    const modeAtRename = parseInt(renameEvent.split(":")[1], 8);
    assert.equal(
      modeAtRename & 0o111,
      0o111,
      `staging file was not executable at rename (mode ${renameEvent})`
    );

    const checksumIdx = run.events.indexOf("checksum-read-complete");
    const chmodIdx = run.events.findIndex((e) => e.startsWith("chmod:"));
    const renameIdx = run.events.indexOf(renameEvent);
    assert.ok(checksumIdx >= 0, "checksum was never computed over the staging file");
    assert.ok(chmodIdx > checksumIdx, "chmod ran before checksum verification finished");
    assert.ok(renameIdx > checksumIdx, "publication ran before checksum verification finished");

    assert.equal(fs.existsSync(run.tmpPath), false);
    assert.equal(fs.existsSync(run.tmpChecksumPath), false);
  })
);

test(
  "should keep the previously installed binary when chmod fails",
  withTempRoot(async (root) => {
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    const destPath = path.join(root, "bin", "agent-workspace-linux");
    const previous = Buffer.from("#!/bin/sh\necho previous\n");
    fs.writeFileSync(destPath, previous, { mode: 0o755 });

    const run = await runInstaller(root, { chmodFails: true });

    // Only the first exit is meaningful: the sentinel thrown by the fake
    // process.exit unwinds into the script's own top-level catch, which exits
    // again.
    assert.equal(run.exits[0], 1);
    assert.equal(
      fs.readFileSync(destPath).equals(previous),
      true,
      "chmod failure clobbered the previously installed binary"
    );
    assert.equal(fs.statSync(destPath).mode & 0o111, 0o111);
    assert.equal(fs.existsSync(run.tmpPath), false, "staging file was left behind");
    assert.equal(fs.existsSync(run.tmpChecksumPath), false, "sidecar was left behind");
  })
);
