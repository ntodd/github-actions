#!/usr/bin/env node
// Prints the App's installation ID on an account, using the App's own JWT
// (gh's token isn't allowed to list installations). With a repo, exits 3
// if the installation doesn't cover it.
//
//   node agent-ready/app/installation.mjs <app dir> <account> [owner/repo]

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appJwt } from "../lib/app-token.mjs";

const [dir, account, repo] = process.argv.slice(2);
const app = JSON.parse(readFileSync(join(dir, "app.json"), "utf8"));
const jwt = appJwt({ appId: app.id, privateKey: readFileSync(join(dir, "private-key.pem"), "utf8") });
const api = async (path, token = jwt, init = {}) => {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "agent-ready" },
  });
  if (!res.ok) {
    console.error(`${path}: ${res.status} ${await res.text()}`);
    process.exit(1);
  }
  return res.json();
};

const found = (await api("/app/installations?per_page=100")).find((i) => i.account.login.toLowerCase() === account.toLowerCase());
if (!found) process.exit(0);
console.log(found.id);
if (!repo || found.repository_selection === "all") process.exit(0);

const { token } = await api(`/app/installations/${found.id}/access_tokens`, jwt, { method: "POST" });
let covered = false;
for (let page = 1; !covered; page++) {
  const { repositories } = await api(`/installation/repositories?per_page=100&page=${page}`, token);
  if (repositories.length === 0) break;
  covered = repositories.some((r) => r.full_name.toLowerCase() === repo.toLowerCase());
}
process.exit(covered ? 0 : 3);
