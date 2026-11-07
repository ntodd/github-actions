// The bits of @actions/core flake-hunt needs, so it has no dependencies.

import { appendFileSync } from "node:fs";

export function input(name, fallback = "") {
  const value = process.env[`INPUT_${name.replace(/ /g, "_").toUpperCase()}`];
  return value === undefined || value.trim() === "" ? fallback : value.trim();
}

export function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${name}=${value}\n`);
  else console.log(`${name}=${value}`);
}

export async function main(fn) {
  try {
    await fn();
  } catch (e) {
    console.log(`::error::${e.message}`);
    process.exitCode = 1;
  }
}
