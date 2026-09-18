#!/usr/bin/env node
// install-isolation.test.cjs — concurrency behaviour of the real postinstall script.
//
// The whole, unmodified scripts/postinstall.js is evaluated with vm.runInContext
// so main() runs its production code path. Only the boundaries are faked: the
// https module, process.platform/arch/exit, and __dirname (pointed at a
// disposable fixture package). The filesystem is real.
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const test = require("node:test");
const vm = require("node:vm");

const SOURCE_PATH = path.join(__dirname, "..", "scripts", "postinstall.js");
const SOURCE = fs.readFileSync(SOURCE_PATH, "utf8");
const VERSION = require("../package.json").version;
const ASSET = "agent-workspace-linux-x86_64-unknown-linux-gnu";
const BINARY_URL =
  `https://github.com/agent-sh/agent-workspace-linux/releases/download/v${VERSION}/${ASSET}`;

class ExitError extends Error {
  constructor(code) {
    super(`process.exit(${code})`);
    this.code = code;
  }
}

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

// Compare digests rather than raw Buffers: keeps failure output readable.
function digestOf(file) {
  return sha256(fs.readFileSync(file));
}

function sidecar(contents) {
  return `${sha256(contents)}  ${ASSET}\n`;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Disposable fixture package: <tmp>/{package.json,scripts/,bin/}
function makeFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-install-isolation-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, "scripts"));
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "@agent-sh/agent-workspace-linux", version: VERSION })
  );
  return { dir, binDir: path.join(dir, "bin"), destPath: path.join(dir, "bin", "agent-workspace-linux") };
}

// Every bin/ entry except the published binary — staging residue must be empty.
function residue(binDir) {
  if (!fs.existsSync(binDir)) return [];
  return fs
    .readdirSync(binDir, { recursive: true })
    .filter((entry) => entry !== "agent-workspace-linux")
    .sort();
}

function stagedFiles(binDir) {
  return residue(binDir)
    .map((entry) => path.join(binDir, entry))
    .filter((p) => fs.statSync(p).isFile());
}

// `handler(url)` resolves to { statusCode, body }; may await to hold a response.
function createInstaller(fixture, handler) {
  const scriptsDir = path.join(fixture.dir, "scripts");
  const https = {
    get(url, _options, callback) {
      const req = new EventEmitter();
      req.destroy = () => { req.destroyed = true; req.emit("close"); return req; };
      Promise.resolve()
        .then(() => handler(url))
        .then(({ statusCode, body }) => {
          const res = new Readable({ read() {} });
          res.statusCode = statusCode;
          res.headers = {};
          callback(res);
          if (body !== undefined) res.push(Buffer.from(body));
          res.push(null);
        }, (err) => req.emit("error", err));
      return req;
    },
  };

  const requireShim = (id) => {
    if (id === "https") return https;
    return id.startsWith(".") ? require(path.resolve(scriptsDir, id)) : require(id);
  };
  requireShim.main = undefined; // keep the script from self-invoking main()

  const logs = [];
  const context = vm.createContext({
    require: requireShim,
    module: { exports: {} },
    exports: {},
    __dirname: scriptsDir,
    __filename: path.join(scriptsDir, "postinstall.js"),
    process: {
      platform: "linux",
      arch: "x64",
      exit(code) {
        throw new ExitError(code);
      },
    },
    console: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
    Buffer,
    setTimeout,
    clearTimeout,
  });
  vm.runInContext(SOURCE, context, { filename: SOURCE_PATH });
  return { run: () => context.main(), logs };
}

test("two interleaved installs each publish their own verified bytes", async (t) => {
  const fixture = makeFixture(t);
  const bodies = { a: Buffer.alloc(1024, 0x41), b: Buffer.alloc(2048, 0x42) };
  const reachedChecksum = { a: deferred(), b: deferred() };
  const releaseChecksum = { a: deferred(), b: deferred() };
  const urls = [];

  const handlerFor = (name) => async (url) => {
    urls.push(url);
    if (url.endsWith(".sha256")) {
      reachedChecksum[name].resolve();
      await releaseChecksum[name].promise;
      return { statusCode: 200, body: sidecar(bodies[name]) };
    }
    return { statusCode: 200, body: bodies[name] };
  };

  const runA = createInstaller(fixture, handlerFor("a")).run();
  await reachedChecksum.a.promise;
  const stagedA = stagedFiles(fixture.binDir);
  assert.equal(stagedA.length, 1, "install A should have exactly one staged file");

  const runB = createInstaller(fixture, handlerFor("b")).run();
  await reachedChecksum.b.promise;
  assert.ok(fs.existsSync(stagedA[0]), "install B removed install A's staged binary");
  assert.equal(
    digestOf(stagedA[0]),
    sha256(bodies.a),
    "install B overwrote install A's staged binary"
  );

  releaseChecksum.b.resolve();
  await runB;
  assert.equal(digestOf(fixture.destPath), sha256(bodies.b));

  releaseChecksum.a.resolve();
  await runA; // must verify A's own bytes, not B's
  assert.equal(digestOf(fixture.destPath), sha256(bodies.a));

  assert.equal(fs.statSync(fixture.destPath).mode & 0o777, 0o755);
  assert.deepEqual(residue(fixture.binDir), [], "staging residue left behind");
  assert.deepEqual(urls.sort(), [
    `${BINARY_URL}.sha256`,
    `${BINARY_URL}.sha256`,
    BINARY_URL,
    BINARY_URL,
  ].sort());
});

test("single install publishes the downloaded binary from the pinned release URL", async (t) => {
  const fixture = makeFixture(t);
  const body = Buffer.from("native binary");
  const urls = [];
  const installer = createInstaller(fixture, async (url) => {
    urls.push(url);
    return url.endsWith(".sha256")
      ? { statusCode: 200, body: sidecar(body) }
      : { statusCode: 200, body };
  });

  await installer.run();

  assert.deepEqual(urls, [BINARY_URL, `${BINARY_URL}.sha256`]);
  assert.equal(digestOf(fixture.destPath), sha256(body));
  assert.equal(fs.statSync(fixture.destPath).mode & 0o777, 0o755);
  assert.deepEqual(residue(fixture.binDir), []);
});

test("failed download exits 1, cleans staging and keeps the existing binary", async (t) => {
  const fixture = makeFixture(t);
  fs.mkdirSync(fixture.binDir);
  fs.writeFileSync(fixture.destPath, "previously installed", { mode: 0o755 });

  const installer = createInstaller(fixture, async () => ({ statusCode: 404, body: "not found" }));

  await assert.rejects(installer.run(), (err) => err instanceof ExitError && err.code === 1);
  assert.equal(fs.readFileSync(fixture.destPath, "utf8"), "previously installed");
  assert.equal(fs.statSync(fixture.destPath).mode & 0o777, 0o755);
  assert.deepEqual(residue(fixture.binDir), []);
});

test("checksum mismatch exits 1, cleans staging and never publishes the bytes", async (t) => {
  const fixture = makeFixture(t);
  fs.mkdirSync(fixture.binDir);
  fs.writeFileSync(fixture.destPath, "previously installed", { mode: 0o755 });

  const installer = createInstaller(fixture, async (url) =>
    url.endsWith(".sha256")
      ? { statusCode: 200, body: sidecar("some other payload") }
      : { statusCode: 200, body: Buffer.from("tampered binary") }
  );

  await assert.rejects(installer.run(), (err) => err instanceof ExitError && err.code === 1);
  assert.equal(fs.readFileSync(fixture.destPath, "utf8"), "previously installed");
  assert.deepEqual(residue(fixture.binDir), []);
});
