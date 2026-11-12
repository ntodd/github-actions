// Local administrator setup intent. This never contains a token, private key,
// secret value or project source. Unknown creates are inspected, never resent.
import { readFileSync, writeFileSync, mkdirSync, renameSync, lstatSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { canonical } from "./store.mjs";

export function setupJournal(path, repositoryId) {
  if (typeof path !== "string" || !path || !/^[1-9]\d*$/.test(repositoryId)) throw new Error("Invalid setup journal location/identity");
  let state = { schemaVersion: 1, repositoryId, effects: {} };
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("Invalid setup journal file");
    state = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (state.schemaVersion !== 1 || state.repositoryId !== repositoryId || !state.effects || typeof state.effects !== "object" || Array.isArray(state.effects)) throw new Error("Setup journal belongs to another repository or is corrupt");
  const save = (key, value) => {
    const next = structuredClone(state); next.effects[key] = structuredClone(value);
    const text = canonical(next);
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) throw new Error("Setup journal exceeds its limit");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path); state = next;
  };
  return { get: (key) => structuredClone(state.effects[key] ?? null), save };
}

export class PendingSetupEffect extends Error {
  constructor(slot) { super(`Setup request ${slot} has an unknown outcome; inspect its recorded request before retrying`); this.name = "PendingSetupEffect"; }
}

export async function setupEffect({ journal, slot, definition, inspect, submit, repeatable = false,
  now = () => new Date().toISOString() }) {
  let record = journal.get(slot);
  if (record && canonical(record.definition) !== canonical(definition)) throw new Error(`Setup intent changed for ${slot}`);
  record ??= { definition: structuredClone(definition), requests: [], status: "prepared", receipt: null };
  if (!Array.isArray(record.requests) || record.requests.length > 3 || !["prepared", "pending", "done", "rejected"].includes(record.status)) throw new Error(`Corrupt setup effect ${slot}`);
  const observed = await inspect(record);
  if (observed?.applied) {
    record.status = "done"; record.receipt = observed.receipt;
    journal.save(slot, record); return observed.receipt;
  }
  if (record.status === "pending" && !repeatable) throw new PendingSetupEffect(slot);
  if (record.status === "done" && !repeatable) throw new Error(`The successful setup effect ${slot} changed or disappeared; inspect its receipt before replacing it`);
  if (record.requests.length >= 3) throw new Error(`Setup request budget exhausted for ${slot}`);
  record.requests.push({ at: now() }); record.status = "pending";
  journal.save(slot, record);
  let receipt;
  try { receipt = await submit(); }
  catch (error) {
    if (Number.isInteger(error.status) && error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) {
      record.status = "rejected"; record.rejection = error.status; journal.save(slot, record);
    }
    throw error;
  }
  if (receipt == null) throw new PendingSetupEffect(slot);
  record.status = "done"; record.receipt = receipt; journal.save(slot, record);
  return receipt;
}
