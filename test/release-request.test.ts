import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { repositoryRoot } from "./package-test-utils.js";

const checker = join(repositoryRoot, "scripts/check-release-request.mjs");

async function fixture(): Promise<string> {
  const repository = await mkdtemp(join(tmpdir(), "git-mcp-release-request-"));
  await writeFile(join(repository, "package.json"), JSON.stringify({
    name: "@saitolume/git-mcp-server",
    version: "0.1.0-beta.3",
    publishConfig: { access: "public", tag: "beta" },
  }));
  return repository;
}

function runCheck(repository: string, ref: string, releaseVersion: string) {
  return spawnSync(process.execPath, [checker, "--repository", repository], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      GITHUB_REF: ref,
      RELEASE_VERSION: releaseVersion,
    },
  });
}

test("release request accepts only the exact package version from main", async (t) => {
  const repository = await fixture();
  t.after(async () => rm(repository, { recursive: true, force: true }));

  await t.test("accepts the exact version from main", () => {
    const result = runCheck(repository, "refs/heads/main", "0.1.0-beta.3");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      "release request verified for @saitolume/git-mcp-server@0.1.0-beta.3 from refs/heads/main\n",
    );
  });

  await t.test("rejects another branch", () => {
    const result = runCheck(repository, "refs/heads/codex/trusted-publishing", "0.1.0-beta.3");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must run from refs\/heads\/main/);
  });

  await t.test("rejects a mismatched requested version", () => {
    const result = runCheck(repository, "refs/heads/main", "0.1.0-beta.2");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match package version 0\.1\.0-beta\.3/);
  });
});
