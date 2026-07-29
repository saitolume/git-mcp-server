#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

function repositoryFromArguments(arguments_) {
  if (arguments_.length === 0) return process.cwd();
  if (arguments_.length === 2 && arguments_[0] === "--repository") {
    return resolve(arguments_[1]);
  }
  throw new Error("usage: check-release-request.mjs [--repository <path>]");
}

try {
  const repository = repositoryFromArguments(process.argv.slice(2));
  const manifest = JSON.parse(await readFile(resolve(repository, "package.json"), "utf8"));
  const ref = process.env.GITHUB_REF;
  const releaseVersion = process.env.RELEASE_VERSION;

  if (ref !== "refs/heads/main") {
    throw new Error(`release workflow must run from refs/heads/main; received ${JSON.stringify(ref)}`);
  }
  if (releaseVersion !== manifest.version) {
    throw new Error(
      `requested release version ${JSON.stringify(releaseVersion)} does not match package version ${manifest.version}`,
    );
  }

  process.stdout.write(
    `release request verified for ${manifest.name}@${manifest.version} from ${ref}\n`,
  );
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
