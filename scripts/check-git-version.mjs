#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const result = spawnSync("git", ["--version"], { encoding: "utf8" });

try {
  if (result.error) throw new Error(`could not run Git: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`could not run Git: ${(result.stderr || `exit status ${result.status}`).trim()}`);
  }

  const output = result.stdout.trim();
  const match = output.match(
    /^git version ([0-9]+)\.([0-9]+)\.([0-9]+)(?:\.[0-9A-Za-z][0-9A-Za-z.-]*)?(?: [^\r\n]+)?$/,
  );
  if (!match) throw new Error(`could not parse Git version: ${JSON.stringify(output)}`);

  const [, majorText, minorText, patchText] = match;
  const major = Number(majorText);
  const minor = Number(minorText);
  const version = `${majorText}.${minorText}.${patchText}`;
  if (major < 2 || (major === 2 && minor < 39)) {
    throw new Error(`Git 2.39.0 or later is required; found Git ${version}`);
  }

  process.stdout.write(`Git ${version} satisfies Git 2.39.0 or later\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
