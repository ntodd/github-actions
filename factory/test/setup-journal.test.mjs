import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupJournal, setupEffect } from "../lib/setup-journal.mjs";

test("an interrupted setup request survives a new journal instance and cannot be resubmitted on absence", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "factory-setup-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "setup.json"); let requests = 0;
  const attempt = (journal) => setupEffect({ journal, slot: "ruleset-create", definition: { kind: "ruleset-create", name: "factory-state-writers" },
    inspect: async () => null, submit: async () => { requests++; throw new Error("Outcome unknown"); } });
  await assert.rejects(attempt(setupJournal(path, "42")));
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(path, "utf8")).effects["ruleset-create"].status, "pending");
  await assert.rejects(attempt(setupJournal(path, "42")), /unknown outcome/);
  assert.equal(requests, 1);
  const recovered = await setupEffect({ journal: setupJournal(path, "42"), slot: "ruleset-create",
    definition: { kind: "ruleset-create", name: "factory-state-writers" }, inspect: async () => ({ applied: true, receipt: { id: 7 } }),
    submit: async () => { throw new Error("Recovery sent a duplicate"); } });
  assert.deepEqual(recovered, { id: 7 });
});

test("setup journals reject another repository, corruption and symlink substitution", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "factory-setup-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "setup.json"), journal = setupJournal(path, "42");
  journal.save("effect", { status: "prepared" });
  assert.throws(() => setupJournal(path, "43"));
  const link = join(dir, "link.json"); symlinkSync(path, link);
  assert.throws(() => setupJournal(link, "42"));
  writeFileSync(path, "broken JSON"); assert.throws(() => setupJournal(path, "42"));
});

test("repeatable setup projections have a durable three-request limit", async () => {
  const rows = new Map(), journal = { get: (key) => structuredClone(rows.get(key) ?? null), save: (key, value) => rows.set(key, structuredClone(value)) };
  let requests = 0;
  const attempt = () => setupEffect({ journal, slot: "label", definition: { name: "agent-ready" }, repeatable: true,
    inspect: async () => null, submit: async () => { requests++; throw new Error("Unknown projection response"); } });
  for (let i = 0; i < 3; i++) await assert.rejects(attempt());
  await assert.rejects(attempt(), /budget exhausted/); assert.equal(requests, 3);
});
