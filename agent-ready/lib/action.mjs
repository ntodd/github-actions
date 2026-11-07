// Bits of the Actions runtime, without @actions/core.

import { appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

export function setOutput(name, value) {
  const v = String(value);
  if (!process.env.GITHUB_OUTPUT) return console.log(`${name}=${v}`);
  const eof = `EOF_${randomBytes(8).toString("hex")}`;
  appendFileSync(process.env.GITHUB_OUTPUT, `${name}<<${eof}\n${v}\n${eof}\n`);
}

export function summary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  else console.log(markdown);
}

export const mask = (secret) => secret && process.stdout.write(`::add-mask::${secret}\n`);

export function main(fn) {
  fn().catch((err) => {
    console.log(`::error::${String(err.message ?? err).replace(/\n/g, "%0A")}`);
    console.error(err.stack ?? err);
    process.exit(1);
  });
}
