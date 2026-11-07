// Screenshots in PR bodies. Claude references them as
// ![alt](./screenshots/<file>), relative to the state directory, and after
// each publish the workflow uploads them with `gh pr edit --attach`, which
// rewrites each reference to the uploaded asset. GitHub's upload endpoint
// takes a user's token but not an App's, so this runs with
// AGENT_ATTACH_TOKEN, outside Claude's environment.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const REF = /!\[([^\]]*)\]\((\.\/screenshots\/[^)\s]+)\)/g;

export function screenshotRefs(body) {
  const seen = new Map();
  for (const [, alt, path] of String(body ?? "").matchAll(REF)) if (!seen.has(path)) seen.set(path, { alt, path });
  return [...seen.values()];
}

export const unattached = (body) => String(body).replace(REF, (_, alt) => `_(Screenshot not attached: ${alt})_`);

// Attaches every screenshot a PR's body references. Without a token, or
// when a file is missing, the reference becomes plain text so the body
// doesn't show a broken image.
export function attacher({ token, stateDir, repo, read, writer, mint, log, run = spawnSync }) {
  return async (n) => {
    const { body } = await read.prBody(n);
    const refs = screenshotRefs(body);
    if (!refs.length) return;
    const present = refs.filter((r) => existsSync(join(stateDir, r.path)));
    if (token && present.length) {
      const args = ["pr", "edit", String(n), "-R", repo, ...present.flatMap((r) => ["--attach", `${r.path}#${r.alt}`])];
      const res = run("gh", args, { cwd: stateDir, env: { ...process.env, GH_TOKEN: token }, encoding: "utf8" });
      if (res.status === 0) {
        log(`#${n}: attached ${present.length} screenshot${present.length === 1 ? "" : "s"}`);
      } else {
        log(`#${n}: attaching failed: ${(res.stderr || res.stdout || "").trim()}`);
      }
    }
    const after = (await read.prBody(n)).body;
    if (screenshotRefs(after).length) {
      if (!token) log(`#${n}: no AGENT_ATTACH_TOKEN, so the screenshots aren't attached`);
      await writer(await mint()).setPrBody(n, unattached(after));
    }
  };
}
