import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, rmSync, symlinkSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { attachmentManifest, exportAttachments, readAttachments, screenshotRefs, MAX_ATTACHMENT_BYTES } from "../lib/attachments.mjs";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jE9sAAAAASUVORK5CYII=", "base64");
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "factory-attachments-")); t.after(() => rmSync(root, { recursive: true, force: true }));
  const stateDir = join(root, "state"), directory = join(root, "result"), screenshots = join(stateDir, "screenshots");
  mkdirSync(screenshots, { recursive: true }); mkdirSync(directory);
  writeFileSync(join(screenshots, "one.png"), png);
  return { root, stateDir, directory, screenshots, export: (text, extra = {}) => exportAttachments({ stateDir, directory, text, ...extra }) };
}

test("screenshots export once by content with a bounded digest-bound manifest", (t) => {
  const f = fixture(t); writeFileSync(join(f.screenshots, "two.png"), png);
  const attachments = f.export("![one](./screenshots/one.png) ![again](./screenshots/one.png) ![two](./screenshots/two.png)");
  assert.equal(attachments.length, 1);
  assert.deepEqual(attachments[0].paths, ["./screenshots/one.png", "./screenshots/two.png"]);
  assert.equal(attachments[0].digest, `sha256:${createHash("sha256").update(png).digest("hex")}`);
  assert.equal(attachments[0].contentType, "image/png");
  assert.deepEqual(readAttachments(f.directory, attachments).get(attachments[0].file), png);
  assert.deepEqual(readdirSync(f.directory), ["screenshots.json"]);
  writeFileSync(join(f.directory, "screenshots.json"), JSON.stringify([{ file: attachments[0].file, base64: Buffer.concat([png, Buffer.from("substituted")]).toString("base64") }]));
  assert.throws(() => readAttachments(f.directory, attachments));
});

test("screenshot references cannot traverse, select arbitrary formats, or follow symlinks", (t) => {
  const f = fixture(t);
  for (const path of ["../one.png", "nested/one.png", "one.svg", "one.png?secret=1", "one.png#fragment"]) {
    assert.throws(() => f.export(`![one](./screenshots/${path})`));
  }
  assert.deepEqual(screenshotRefs("![external](https://example.com/one.png)"), []);
  symlinkSync(join(f.screenshots, "one.png"), join(f.screenshots, "linked.png"));
  assert.throws(() => f.export("![linked](./screenshots/linked.png)"));
  rmSync(join(f.screenshots, "linked.png"));
  rmSync(f.screenshots, { recursive: true }); symlinkSync(f.directory, f.screenshots);
  assert.throws(() => f.export("![one](./screenshots/one.png)"));
  assert.deepEqual(readdirSync(f.directory), []);
});

test("raster signature, secret-bearing bytes and oversized files fail before any copy", (t) => {
  for (const kind of ["signature", "secret", "size"]) {
    const f = fixture(t), file = join(f.screenshots, "bad.png");
    writeFileSync(file, kind === "signature" ? "<svg>not a raster</svg>" : Buffer.concat([png, Buffer.from("private-project-secret")]));
    if (kind === "size") truncateSync(file, MAX_ATTACHMENT_BYTES + 1);
    assert.throws(() => f.export("![good](./screenshots/one.png) ![bad](./screenshots/bad.png)", { secrets: ["private-project-secret"] }));
    assert.deepEqual(readdirSync(f.directory), []);
  }
});

test("screenshot manifests bound counts, total bytes and every content/path identity", (t) => {
  const f = fixture(t), manifest = f.export("![one](./screenshots/one.png)");
  for (const change of [
    (a) => { a[0].file = "../outside.png"; }, (a) => { a[0].digest = "unverified"; },
    (a) => { a[0].contentType = "image/svg+xml"; }, (a) => { a[0].size = MAX_ATTACHMENT_BYTES + 1; },
    (a) => { a[0].paths = ["./screenshots/../one.png"]; }, (a) => { a[0].paths.push(a[0].paths[0]); },
    (a) => { a.push(a[0]); }, (a) => { a[0].credential = "not allowed"; },
  ]) { const a = structuredClone(manifest); change(a); assert.throws(() => attachmentManifest(a)); }
  const large = ["1", "2", "3"].map((digit, i) => ({ ...manifest[0], paths: [`./screenshots/${i}.png`],
    digest: `sha256:${digit.repeat(64)}`, file: `screenshot-${digit.repeat(64)}.png`, size: MAX_ATTACHMENT_BYTES }));
  assert.throws(() => attachmentManifest(large));
  assert.throws(() => f.export(Array.from({ length: 11 }, (_, i) => `![${i}](./screenshots/${i}.png)`).join("\n")));
  assert.deepEqual(readAttachments(f.directory, manifest).get(manifest[0].file), png);
});
