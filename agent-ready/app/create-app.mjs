#!/usr/bin/env node
// Creates agent-ready's GitHub App with GitHub's manifest flow, so the
// permissions are exactly these and nobody types them in.
//
//   node agent-ready/app/create-app.mjs [--name ntodd-agent] [--org my-org] [--port 8765]
//
// It opens a local page that posts the manifest to GitHub. Click "Create
// GitHub App", and GitHub redirects back here with a code that this
// exchanges for the App's ID and private key. Those go in
// ~/.config/agent-ready/<slug>/ (0600), where enable.sh reads them.
// The page then links to the App's install screen.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, arg, i, all) => {
    if (arg.startsWith("--")) acc.push([arg.slice(2), all[i + 1]]);
    return acc;
  }, []),
);
const name = args.name ?? "ntodd-agent";
const port = Number(args.port ?? 8765);
const org = args.org;
const state = randomBytes(16).toString("hex");

export const manifest = {
  name,
  url: "https://github.com/ntodd/github-actions/tree/main/agent-ready",
  description: "Works agent-ready issues into pull requests.",
  hook_attributes: { url: "https://example.com/unused", active: false },
  redirect_url: `http://localhost:${port}/callback`,
  public: false,
  // No workflows permission: GitHub refuses any push from this App that
  // touches .github/workflows/.
  default_permissions: {
    metadata: "read",
    contents: "write",
    pull_requests: "write",
    issues: "write",
    checks: "read",
    statuses: "read",
    actions: "read",
  },
  default_events: [],
};

const action = org
  ? `https://github.com/organizations/${org}/settings/apps/new?state=${state}`
  : `https://github.com/settings/apps/new?state=${state}`;

const escape = (s) => s.replace(/&/g, "&amp;").replace(/'/g, "&#39;").replace(/</g, "&lt;");

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  if (url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>Create ${name}</title>
<form id="f" action="${action}" method="post">
<input type="hidden" name="manifest" value='${escape(JSON.stringify(manifest))}'>
<p>Sending the ${name} manifest to GitHub…</p><button>Continue</button></form>
<script>document.getElementById("f").submit()</script>`);
    return;
  }
  if (url.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  if (url.searchParams.get("state") !== state) {
    res.writeHead(400).end("State doesn't match. Start again.");
    return;
  }
  try {
    const conv = await fetch(`https://api.github.com/app-manifests/${url.searchParams.get("code")}/conversions`, {
      method: "POST",
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
    });
    if (!conv.ok) throw new Error(`conversion failed: ${conv.status} ${await conv.text()}`);
    const app = await conv.json();
    const dir = join(homedir(), ".config", "agent-ready", app.slug);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "private-key.pem"), app.pem, { mode: 0o600 });
    writeFileSync(
      join(dir, "app.json"),
      JSON.stringify({ id: app.id, slug: app.slug, client_id: app.client_id, owner: app.owner?.login, html_url: app.html_url }, null, 2) + "\n",
      { mode: 0o600 },
    );
    const install = `${app.html_url}/installations/new`;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>${app.slug} created</title>
<p>Created <b>${app.slug}</b> (App ID ${app.id}). Its key is in ${dir}.</p>
<p><a href="${install}">Install it</a>: pick <i>Only select repositories</i>; enable.sh adds repos later.</p>`);
    console.log(JSON.stringify({ id: app.id, slug: app.slug, dir, install }));
    setTimeout(() => process.exit(0), 200);
  } catch (err) {
    res.writeHead(500).end(String(err));
    console.error(err);
    setTimeout(() => process.exit(1), 200);
  }
});

server.listen(port, "127.0.0.1", () => {
  const page = `http://localhost:${port}/`;
  console.error(`Open ${page} if a browser didn't open.`);
  if (process.platform === "darwin") execFile("open", [page]);
});
