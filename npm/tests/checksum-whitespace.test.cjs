#!/usr/bin/env node
// Whitespace-delimiter coverage for the sidecar parser in scripts/postinstall.js.
//
// The production script exits on non-Linux platforms at load time, so it is
// evaluated here as-is inside a vm context with a linux-shaped `process` and a
// narrow `require` boundary. No production logic is reimplemented: every
// assertion runs the real parseSha256Sidecar / verifyChecksum.
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const POSTINSTALL = path.join(__dirname, "..", "scripts", "postinstall.js");
const SOURCE = fs.readFileSync(POSTINSTALL, "utf8");
const ASSET = "agent-workspace-linux-x86_64-unknown-linux-gnu";
const ALLOWED_REQUIRES = new Set(["crypto", "https", "fs", "path"]);

function loadPostinstall() {
  const sandbox = {
    module: { exports: {} },
    console: { log() {}, error() {} },
    process: {
      platform: "linux",
      arch: "x64",
      exit(code) {
        throw new Error(`unexpected process.exit(${code})`);
      },
    },
    __dirname: path.dirname(POSTINSTALL),
    __filename: POSTINSTALL,
    Buffer,
    URL,
    setTimeout,
    clearTimeout,
    require(id) {
      if (id === "../package.json") return { version: "0.0.0-test" };
      if (ALLOWED_REQUIRES.has(id)) return require(`node:${id}`);
      throw new Error(`unexpected require(${id}) from postinstall.js`);
    },
  };
  sandbox.exports = sandbox.module.exports;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox, { filename: POSTINSTALL });
  return sandbox.module.exports;
}

const { parseSha256Sidecar, verifyChecksum } = loadPostinstall();

function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-ws-checksum-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const HASH = sha256("binary");

test("parseSha256Sidecar accepts the sha256sum two-space form", () => {
  assert.equal(parseSha256Sidecar(`${HASH}  ${ASSET}\n`, ASSET), HASH);
});

test("parseSha256Sidecar accepts a tab-delimited entry", () => {
  assert.equal(parseSha256Sidecar(`${HASH}\t${ASSET}\n`, ASSET), HASH);
});

test("parseSha256Sidecar accepts mixed whitespace before the binary marker", () => {
  assert.equal(parseSha256Sidecar(`${HASH} \t *${ASSET}\n`, ASSET), HASH);
});

test("parseSha256Sidecar accepts the one-space binary-mode marker", () => {
  assert.equal(parseSha256Sidecar(`${HASH} *${ASSET}\n`, ASSET), HASH);
});

test("parseSha256Sidecar accepts CRLF lines with a tab delimiter", () => {
  assert.equal(
    parseSha256Sidecar(`${HASH}\t${ASSET}\r\n`, ASSET),
    HASH
  );
});

test("parseSha256Sidecar lowercases an uppercase tab-delimited hash", () => {
  assert.equal(
    parseSha256Sidecar(`${HASH.toUpperCase()}\t${ASSET}\r\n`, ASSET),
    HASH
  );
});

test("parseSha256Sidecar rejects a tab-delimited entry for another asset", () => {
  assert.throws(
    () => parseSha256Sidecar(`${HASH}\tother-asset\n`, ASSET),
    /does not contain an entry/
  );
});

test("parseSha256Sidecar rejects a hash-only line with no filename", () => {
  assert.throws(
    () => parseSha256Sidecar(`${HASH}\n`, ASSET),
    /does not contain an entry/
  );
});

test("parseSha256Sidecar rejects a short (63-hex) checksum", () => {
  assert.throws(
    () => parseSha256Sidecar(`${HASH.slice(0, 63)}\t${ASSET}\n`, ASSET),
    /invalid checksum sidecar line/
  );
});

test("parseSha256Sidecar rejects a non-hex checksum", () => {
  assert.throws(
    () => parseSha256Sidecar(`${"z".repeat(64)}\t${ASSET}\n`, ASSET),
    /invalid checksum sidecar line/
  );
});

test("parseSha256Sidecar rejects an empty sidecar", () => {
  assert.throws(() => parseSha256Sidecar("\n \n", ASSET), /sidecar is empty/);
});

test("verifyChecksum accepts a matching binary with a tab-delimited sidecar", async () => {
  await withTempDir(async (dir) => {
    const binaryPath = path.join(dir, ASSET);
    const sidecarPath = `${binaryPath}.sha256`;
    const contents = Buffer.from("downloaded binary");

    fs.writeFileSync(binaryPath, contents);
    fs.writeFileSync(sidecarPath, `${sha256(contents)}\t${ASSET}\n`);

    await verifyChecksum(binaryPath, sidecarPath, ASSET);
  });
});

test("verifyChecksum rejects a mismatched binary with a tab-delimited sidecar", async () => {
  await withTempDir(async (dir) => {
    const binaryPath = path.join(dir, ASSET);
    const sidecarPath = `${binaryPath}.sha256`;

    fs.writeFileSync(binaryPath, "downloaded binary");
    fs.writeFileSync(sidecarPath, `${sha256("different binary")}\t${ASSET}\n`);

    await assert.rejects(
      () => verifyChecksum(binaryPath, sidecarPath, ASSET),
      /checksum mismatch/
    );
  });
});
