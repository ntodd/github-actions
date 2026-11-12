// Screenshots are untrusted bytes. Only bounded, digest-bound raster files cross
// into the clean publisher; paths in Markdown never become upload destinations.
import { createHash } from "node:crypto";
import { openSync, closeSync, readFileSync, writeFileSync, fstatSync, lstatSync, constants } from "node:fs";
import { join } from "node:path";

export const MAX_ATTACHMENTS = 10, MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024, MAX_ATTACHMENT_TOTAL = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_PACK = Math.ceil(MAX_ATTACHMENT_TOTAL / 3) * 4 + 8192;
const types = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const source = /^\.\/screenshots\/[a-z0-9][a-z0-9_.-]{0,95}\.(?:png|jpe?g|gif|webp)$/i;
const digestOf = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fail = () => { throw new Error("Screenshot files or manifest failed validation"); };

export function screenshotRefs(text) {
  const refs = [...String(text ?? "").matchAll(/!\[[^\]]*\]\((\.\/screenshots\/[^)\s]+)\)/g)].map((m) => m[1]);
  if (refs.some((path) => !source.test(path))) fail();
  return [...new Set(refs)];
}

export function attachmentManifest(value = []) {
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) fail();
  const files = new Set(), paths = new Set(); let total = 0;
  for (const a of value) {
    if (!a || typeof a !== "object" || Object.keys(a).some((k) => !["file", "paths", "digest", "size", "contentType"].includes(k))
      || !/^sha256:[a-f0-9]{64}$/.test(a.digest) || !Number.isSafeInteger(a.size) || a.size < 1 || a.size > MAX_ATTACHMENT_BYTES
      || (total += a.size) > MAX_ATTACHMENT_TOTAL || !Array.isArray(a.paths) || !a.paths.length || a.paths.length > MAX_ATTACHMENTS) fail();
    const ext = Object.keys(types).find((ext) => a.contentType === types[ext]);
    if (!ext || a.file !== `screenshot-${a.digest.slice(7)}.${ext}` || files.has(a.file)) fail();
    files.add(a.file);
    for (const path of a.paths) {
      if (typeof path !== "string" || !source.test(path) || paths.has(path) || paths.size >= MAX_ATTACHMENTS) fail();
      paths.add(path);
    }
  }
  return value;
}

export const attachmentDescriptor = ({ file, paths, digest, size, contentType }) => ({ file, paths: [...paths], digest, size, contentType });
export const assetUrl = (value) => typeof value === "string" && /^https:\/\/github\.com\/user-attachments\/assets\/[a-f0-9-]{8,100}$/.test(value);
export function referencedAttachments(text, manifest) {
  attachmentManifest(manifest);
  const refs = screenshotRefs(text);
  if (refs.some((path) => !manifest.some((a) => a.paths.includes(path)))) fail();
  return manifest.filter((a) => a.paths.some((path) => refs.includes(path)));
}
export function renderAttachments(text, op) {
  const rendered = String(text).replace(/(!\[[^\]]*\]\()(\.\/screenshots\/[^)\s]+)(\))/g, (_whole, before, path, after) => {
    const effect = op.effects.find((e) => e.type === "attachment" && e.paths.includes(path));
    if (!source.test(path) || effect?.status !== "applied" || !assetUrl(effect.receipt?.url)) fail();
    return `${before}${effect.receipt.url}${after}`;
  });
  if (rendered.length > 60000) throw new Error("Screenshot references exceed the published text limit");
  return rendered;
}

function fileBytes(path, limit = MAX_ATTACHMENT_BYTES) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > limit) fail();
    const bytes = readFileSync(fd);
    if (bytes.length !== stat.size) fail();
    return bytes;
  } finally { closeSync(fd); }
}
function rasterType(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg";
  if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "gif";
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "webp";
  fail();
}
export function readAttachments(directory, manifest) {
  attachmentManifest(manifest);
  if (!manifest.length) return new Map();
  const entries = JSON.parse(fileBytes(join(directory, "screenshots.json"), MAX_ATTACHMENT_PACK).toString("utf8"));
  if (!Array.isArray(entries) || entries.length !== manifest.length) fail();
  const files = new Map();
  for (const entry of entries) {
    const attachment = manifest.find((a) => a.file === entry?.file);
    if (!attachment || files.has(entry.file) || Object.keys(entry).some((key) => !["file", "base64"].includes(key))
      || typeof entry.base64 !== "string" || entry.base64.length > Math.ceil(attachment.size / 3) * 4) fail();
    const bytes = Buffer.from(entry.base64, "base64");
    if (bytes.toString("base64") !== entry.base64 || bytes.length !== attachment.size || digestOf(bytes) !== attachment.digest
      || types[rasterType(bytes)] !== attachment.contentType) fail();
    files.set(entry.file, bytes);
  }
  return files;
}

export function exportAttachments({ stateDir, directory, text, secrets = [] }) {
  const refs = screenshotRefs(text);
  if (!refs.length) return [];
  if (refs.length > MAX_ATTACHMENTS || !stateDir) fail();
  const folder = join(stateDir, "screenshots"), stat = lstatSync(folder);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  const byFile = new Map();
  for (const path of refs) {
    const bytes = fileBytes(join(folder, path.slice("./screenshots/".length))), ext = rasterType(bytes);
    const expected = path.split(".").at(-1).toLowerCase().replace("jpeg", "jpg");
    if (ext !== expected || secrets.some((secret) => typeof secret === "string" && secret.length && bytes.includes(Buffer.from(secret)))) fail();
    const digest = digestOf(bytes), file = `screenshot-${digest.slice(7)}.${ext}`;
    if (byFile.has(file)) byFile.get(file).manifest.paths.push(path);
    else byFile.set(file, { manifest: { file, paths: [path], digest, size: bytes.length, contentType: types[ext] }, bytes });
  }
  const manifest = attachmentManifest([...byFile.values()].map((a) => a.manifest));
  writeFileSync(join(directory, "screenshots.json"), JSON.stringify([...byFile].map(([file, { bytes }]) => ({ file, base64: bytes.toString("base64") }))), { mode: 0o600, flag: "wx" });
  return manifest;
}

// GitHub CLI v2.103.3 uses this upload-only endpoint (internal/attachments/client.go).
// The attachment credential never edits a PR; the App publishes the saved URL.
export function attachmentUploader({ token, repositoryId, readBytes, fetchImpl = fetch, serverUrl = "https://github.com" }) {
  const bytesFor = async (effect) => {
    if (serverUrl !== "https://github.com") throw new Error("Screenshot upload is supported only on GitHub.com");
    if (!token || typeof token !== "string" || /[\r\n]/.test(token) || token.length > 48 * 1024) throw new Error("Screenshot publication requires AGENT_ATTACH_TOKEN in the clean controller job");
    attachmentManifest([attachmentDescriptor(effect)]);
    if (!/^[1-9]\d*$/.test(repositoryId) || effect.repositoryId !== repositoryId) fail();
    const bytes = await readBytes(effect);
    if (!Buffer.isBuffer(bytes) || bytes.length !== effect.size || digestOf(bytes) !== effect.digest || types[rasterType(bytes)] !== effect.contentType) fail();
    return bytes;
  };
  return {
    validate: async (effect) => { await bytesFor(effect); },
    // The upload API has no lookup by client request identity. A lost response
    // stays uncertain and escalates through the ordinary publish deadline.
    inspect: async () => ({ outcome: "unknown" }),
    async apply(effect) {
      const bytes = await bytesFor(effect);
      const url = new URL("https://uploads.github.com/user-attachments/assets");
      url.search = new URLSearchParams({ name: effect.file, content_type: effect.contentType, repository_id: repositoryId }).toString();
      const response = await fetchImpl(url.href, { method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
        headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/octet-stream", "content-length": String(bytes.length) }, body: bytes });
      if ([400, 401, 403, 404, 409, 410, 413, 415, 422].includes(response.status)) return { outcome: "rejected", evidence: { kind: "http-rejection", status: response.status } };
      if (response.status !== 201) return { outcome: "unknown" };
      const chunks = []; let size = 0;
      for await (const chunk of response.body) { if ((size += chunk.length) > 16384) return { outcome: "unknown" }; chunks.push(chunk); }
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return { outcome: "unknown" }; }
      return assetUrl(result.url) ? { outcome: "applied", evidence: { kind: "attachment", repositoryId, digest: effect.digest, size: effect.size, url: result.url } } : { outcome: "unknown" };
    },
  };
}
