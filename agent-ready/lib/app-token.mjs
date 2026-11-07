// GitHub App tokens, with no dependencies: an RS256 JWT for the App, then
// an installation token limited to one repository and the permissions
// asked for. Installation tokens last an hour.

import { createSign } from "node:crypto";

const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");

export function appJwt({ appId, privateKey, now = Math.floor(Date.now() / 1000) }) {
  // Backdated a minute for clock drift. GitHub allows at most ten minutes.
  const body = `${b64({ alg: "RS256", typ: "JWT" })}.${b64({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
  const sig = createSign("RSA-SHA256").update(body).sign(privateKey).toString("base64url");
  return `${body}.${sig}`;
}

export async function installationToken({ appId, privateKey, repo, permissions, apiUrl = "https://api.github.com", fetch = globalThis.fetch }) {
  const headers = {
    authorization: `Bearer ${appJwt({ appId, privateKey })}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "agent-ready",
  };
  const inst = await fetch(`${apiUrl}/repos/${repo}/installation`, { headers });
  if (inst.status === 404) throw new Error(`The App isn't installed on ${repo}. Run agent-ready/enable.sh ${repo}.`);
  if (!inst.ok) throw new Error(`GET /repos/${repo}/installation: ${inst.status} ${await inst.text()}`);
  const { id } = await inst.json();

  const res = await fetch(`${apiUrl}/app/installations/${id}/access_tokens`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ repositories: [repo.split("/")[1]], permissions }),
  });
  if (!res.ok) throw new Error(`minting a token for ${repo}: ${res.status} ${await res.text()}`);
  const { token, expires_at } = await res.json();
  return { token, expiresAt: expires_at };
}

export async function appSlug({ appId, privateKey, apiUrl = "https://api.github.com", fetch = globalThis.fetch }) {
  const res = await fetch(`${apiUrl}/app`, {
    headers: { authorization: `Bearer ${appJwt({ appId, privateKey })}`, accept: "application/vnd.github+json", "user-agent": "agent-ready" },
  });
  if (!res.ok) throw new Error(`GET /app: ${res.status} ${await res.text()}`);
  return (await res.json()).slug;
}
