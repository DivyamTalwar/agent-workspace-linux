#!/usr/bin/env node
// Exercises the real postinstall download() over a controlled HTTPS transport.
// The whole unchanged script is evaluated in a VM context (linux process stub),
// so download() is the production implementation, not a reimplementation.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const { EventEmitter } = require("node:events");
const { Readable } = require("node:stream");

const SCRIPT = path.join(__dirname, "..", "scripts", "postinstall.js");
const SOURCE = fs.readFileSync(SCRIPT, "utf8");
const ORIGIN = "https://github.com/agent-sh/agent-workspace-linux/releases/download/v0.3.2/asset";

// Minimal https.get stand-in with node's own URL/protocol validation semantics:
// a relative or non-https target throws synchronously, as https.get really does.
function makeHttps(routes) {
  const stub = { requested: [], thrown: [] };
  stub.get = (url, options, cb) => {
    const target = new URL(url); // TypeError ERR_INVALID_URL on a relative Location
    if (target.protocol !== "https:") {
      const err = new TypeError(`Protocol "${target.protocol}" not supported. Expected "https:"`);
      err.code = "ERR_INVALID_PROTOCOL";
      throw err;
    }
    stub.requested.push(target.href);
    const req = new EventEmitter();
      req.destroy = () => { req.destroyed = true; req.emit("close"); return req; };
    const route = routes[target.href];
    setImmediate(() => {
      try {
        if (!route) {
          req.emit("error", Object.assign(new Error(`no route: ${target.href}`), { code: "ENOTFOUND" }));
          return;
        }
        const res = Readable.from([Buffer.from(route.body ?? "")]);
        res.statusCode = route.status;
        res.headers = route.headers ?? {};
        cb(res);
      } catch (err) {
        // Real node surfaces this as an uncaughtException that kills npm install.
        stub.thrown.push(err);
      }
    });
    return req;
  };
  return stub;
}

function loadDownload(httpsStub, dirname) {
  const sandbox = {
    console: { log() {}, error() {} },
    process: {
      platform: "linux",
      arch: "x64",
      exit(code) {
        throw new Error(`unexpected process.exit(${code})`);
      },
    },
    Buffer,
    URL,
    setImmediate,
    setTimeout,
    clearTimeout,
  };
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  sandbox.__dirname = dirname;
  sandbox.__filename = path.join(dirname, "postinstall.js");
  sandbox.require = (id) => {
    if (id === "https") return httpsStub;
    if (id === "../package.json") return { version: "0.3.2" };
    if (id === "crypto" || id === "fs" || id === "path") return require(`node:${id}`);
    throw new Error(`unexpected require(${id})`);
  };
  sandbox.require.main = { id: "harness" }; // never equals module → main() stays unrun
  const ctx = vm.createContext(sandbox);
  vm.runInContext(SOURCE, ctx, { filename: SCRIPT });
  assert.equal(typeof ctx.download, "function", "download() must be reachable in the VM context");
  return ctx.download;
}

// Bounded settle: rejects the assertion if the promise hangs (the pre-fix symptom).
function settled(promise, ms = 500) {
  let timer;
  const guard = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error("download() never settled")), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

function withTemp(fn) {
  return async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aw-redirect-"));
    try {
      await fn({ dir, tmpFile: path.join(dir, "asset.tmp") }, t);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

const OK = { status: 200, body: "payload" };

test("follows an absolute https Location", withTemp(async ({ dir, tmpFile }) => {
  const https = makeHttps({
    [ORIGIN]: { status: 302, headers: { location: "https://cdn.example.com/a/asset" } },
    "https://cdn.example.com/a/asset": OK,
  });
  await settled(loadDownload(https, dir)(ORIGIN, tmpFile));
  assert.deepEqual(https.requested, [ORIGIN, "https://cdn.example.com/a/asset"]);
  assert.equal(fs.readFileSync(tmpFile, "utf8"), "payload");
}));

test("resolves a relative Location against the current response URL", withTemp(async ({ dir, tmpFile }) => {
  const https = makeHttps({
    [ORIGIN]: { status: 302, headers: { location: "/s3/asset?token=abc" } },
    "https://github.com/s3/asset?token=abc": OK,
  });
  try {
    await settled(loadDownload(https, dir)(ORIGIN, tmpFile));
  } finally {
    // Reported even when the promise hangs: names the crash the caller would see.
    assert.deepEqual(https.thrown.map((e) => e.code), [], "no synchronous https.get crash");
  }
  assert.deepEqual(https.requested, [ORIGIN, "https://github.com/s3/asset?token=abc"]);
  assert.equal(fs.readFileSync(tmpFile, "utf8"), "payload");
}));

test("resolves a query-only and a protocol-relative Location", withTemp(async ({ dir, tmpFile }) => {
  const https = makeHttps({
    [ORIGIN]: { status: 303, headers: { location: "?sig=1" } },
    [`${ORIGIN}?sig=1`]: { status: 307, headers: { location: "//cdn.example.com/x/asset" } },
    "https://cdn.example.com/x/asset": OK,
  });
  await settled(loadDownload(https, dir)(ORIGIN, tmpFile));
  assert.deepEqual(https.requested, [ORIGIN, `${ORIGIN}?sig=1`, "https://cdn.example.com/x/asset"]);
}));

test("accepts exactly five hops and rejects the sixth", withTemp(async ({ dir, tmpFile }) => {
  const chain = (hops) => {
    const routes = {};
    for (let i = 0; i < hops; i += 1) {
      routes[i === 0 ? ORIGIN : `https://cdn.example.com/hop${i}`] = {
        status: 302,
        headers: { location: `/hop${i + 1}` },
      };
    }
    routes[`https://cdn.example.com/hop${hops}`] = OK;
    return routes;
  };
  // hop1..hop5 live on cdn; rewrite the first Location so relative resolution lands there.
  const five = chain(5);
  five[ORIGIN] = { status: 302, headers: { location: "https://cdn.example.com/hop1" } };
  await settled(loadDownload(makeHttps(five), dir)(ORIGIN, tmpFile));
  assert.equal(fs.readFileSync(tmpFile, "utf8"), "payload");

  const six = chain(6);
  six[ORIGIN] = { status: 302, headers: { location: "https://cdn.example.com/hop1" } };
  await assert.rejects(
    () => settled(loadDownload(makeHttps(six), dir)(ORIGIN, `${tmpFile}.6`)),
    /Too many redirects/
  );
  assert.equal(fs.existsSync(`${tmpFile}.6`), false, "no partial file published");
}));

test("rejects a malformed Location instead of crashing", withTemp(async ({ dir, tmpFile }) => {
  // Unresolvable even against a base URL (invalid IPv6 host).
  const https = makeHttps({ [ORIGIN]: { status: 302, headers: { location: "https://[:::1]/asset" } } });
  await assert.rejects(
    () => settled(loadDownload(https, dir)(ORIGIN, tmpFile)),
    /Invalid redirect location/
  );
  assert.deepEqual(https.thrown, []);
  assert.deepEqual(https.requested, [ORIGIN]);
  assert.equal(fs.existsSync(tmpFile), false);
}));

test("rejects an http downgrade redirect without fetching it", withTemp(async ({ dir, tmpFile }) => {
  const https = makeHttps({
    [ORIGIN]: { status: 302, headers: { location: "http://cdn.example.com/plain/asset" } },
  });
  await assert.rejects(
    () => settled(loadDownload(https, dir)(ORIGIN, tmpFile)),
    /Refusing non-HTTPS redirect/
  );
  assert.deepEqual(https.requested, [ORIGIN], "plaintext hop must never be requested");
  assert.deepEqual(https.thrown, []);
  assert.equal(fs.existsSync(tmpFile), false);
}));

test("still rejects a non-200 terminal status", withTemp(async ({ dir, tmpFile }) => {
  const https = makeHttps({ [ORIGIN]: { status: 404, body: "nope" } });
  await assert.rejects(() => settled(loadDownload(https, dir)(ORIGIN, tmpFile)), /HTTP 404/);
  assert.equal(fs.existsSync(tmpFile), false);
}));
