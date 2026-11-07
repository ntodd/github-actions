#!/usr/bin/env node
// Prints the App's installation ID on an account, using the App's own JWT
// (gh's token isn't allowed to list installations).
//
//   node agent-ready/app/installation.mjs <app dir> <account>

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { appJwt } from "../lib/app-token.mjs";

const [dir, account] = process.argv.slice(2);
const app = JSON.parse(readFileSync(join(dir, "app.json"), "utf8"));
const jwt = appJwt({ appId: app.id, privateKey: readFileSync(join(dir, "private-key.pem"), "utf8") });
const res = await fetch("https://api.github.com/app/installations?per_page=100", {
  headers: { authorization: `Bearer ${jwt}`, accept: "application/vnd.github+json", "user-agent": "agent-ready" },
});
if (!res.ok) {
  console.error(`GET /app/installations: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const found = (await res.json()).find((i) => i.account.login.toLowerCase() === account.toLowerCase());
if (found) console.log(found.id);
