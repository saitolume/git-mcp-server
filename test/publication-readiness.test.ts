import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const projectRoot = process.cwd();
const auditorPath = join(projectRoot, "scripts", "check-publication-readiness.mjs");
const temporaryRepositories: string[] = [];

interface CandidateOptions {
  readonly author?: string;
  readonly extraFiles?: Readonly<Record<string, string | Uint8Array>>;
  readonly secondCommit?: boolean;
  readonly extraRef?: string;
  readonly branch?: string;
  readonly remote?: boolean;
  readonly manifest?: Readonly<Record<string, unknown>>;
  readonly omitFile?: string;
  readonly dirtyTrackedFile?: boolean;
  readonly symlinkFiles?: Readonly<Record<string, string>>;
  readonly gitlink?: boolean;
  readonly nonRegularAfterCommit?: string;
}

interface AuditCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly [key: string]: unknown;
}

interface AuditResult {
  readonly ok: boolean;
  readonly checks: readonly AuditCheck[];
}

function git(root: string, args: readonly string[]): void {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function gitOutput(root: string, args: readonly string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

async function writeMinimalAllowedTree(
  root: string,
  manifest?: Readonly<Record<string, unknown>>,
  omitFile?: string,
): Promise<void> {
  const files: Readonly<Record<string, string>> = {
    ".github/workflows/ci.yml": "name: CI\n",
    ".github/workflows/publish-npm.yml": "name: Publish npm beta\n",
    ".gitignore": "dist/\n",
    "LICENSE": "MIT License\n\nCopyright (c) 2026 saitolume\n",
    "README.md": "# git-mcp-server\n",
    "README.ja.md": "# git-mcp-server\n",
    "SECURITY.md": "Private Vulnerability Reporting\n",
    "docs/architecture.md": "# Architecture\n",
    "docs/acceptance/provider-checklist.md": "# Provider checklist\n",
    "package.json": JSON.stringify(manifest ?? {
      name: "@saitolume/git-mcp-server",
      version: "0.1.0-beta.3",
      license: "MIT",
      repository: {
        type: "git",
        url: "git+https://github.com/saitolume/git-mcp-server.git",
      },
      publishConfig: { access: "public", tag: "beta" },
      packageManager: "pnpm@11.15.1",
      engines: { node: ">=22" },
    }),
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "scripts/fixture.mjs": "export {};\n",
    "src/fixture.ts": "export {};\n",
    "test/fixture.test.ts": "export {};\n",
    "tsconfig.json": "{}\n",
    "tsconfig.build.json": "{}\n",
    "tsconfig.test.json": "{}\n",
  };
  for (const [path, contents] of Object.entries(files)) {
    if (path === omitFile) continue;
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
}

function parseAuthor(value: string): readonly [string, string] {
  const match = /^(.+) <([^<>]+)>$/.exec(value);
  if (!match) throw new Error(`invalid author: ${value}`);
  return [match[1] ?? "", match[2] ?? ""];
}

async function createCandidate(options: CandidateOptions = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "git-mcp-server-public-candidate-"));
  temporaryRepositories.push(root);
  git(root, ["init", "-b", options.branch ?? "main"]);
  await writeMinimalAllowedTree(root, options.manifest, options.omitFile);
  for (const [path, contents] of Object.entries(options.extraFiles ?? {})) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
  for (const [path, target] of Object.entries(options.symlinkFiles ?? {})) {
    const link = join(root, path);
    await unlink(link).catch(() => undefined);
    await symlink(target, link);
  }
  git(root, ["add", "--all"]);
  const [name, email] = parseAuthor(options.author ?? "Tadao Iseki <me@saitolume.com>");
  if (options.gitlink) {
    const tree = gitOutput(root, ["write-tree"]);
    const object = gitOutput(root, [
      "-c", `user.name=${name}`,
      "-c", `user.email=${email}`,
      "commit-tree", tree, "-m", "gitlink target",
    ]);
    git(root, ["update-index", "--add", "--cacheinfo", `160000,${object},src/vendor`]);
  }
  const commitArgs = [
    "-c", `user.name=${name}`,
    "-c", `user.email=${email}`,
    "commit", "--no-gpg-sign", "-m", "Initial public release",
  ];
  git(root, commitArgs);
  if (options.secondCommit) {
    await writeFile(join(root, "README.md"), "# git-mcp-server\n\nsecond commit\n");
    git(root, ["add", "README.md"]);
    git(root, [...commitArgs.slice(0, 4), "commit", "--no-gpg-sign", "-m", "second"]);
  }
  if (options.extraRef) git(root, ["update-ref", options.extraRef, "HEAD"]);
  if (options.remote) git(root, ["remote", "add", "origin", "https://example.test/repository.git"]);
  if (options.dirtyTrackedFile) await writeFile(join(root, "README.md"), "dirty\n");
  if (options.nonRegularAfterCommit) {
    const path = join(root, options.nonRegularAfterCommit);
    await unlink(path);
    const fifo = spawnSync("mkfifo", [path], { encoding: "utf8" });
    assert.equal(fifo.status, 0, fifo.stderr);
  }
  return root;
}

function runAudit(repository: string) {
  return spawnSync(process.execPath, [auditorPath, "--repository", repository], {
    cwd: projectRoot,
    encoding: "utf8",
  });
}

function parseAudit(stdout: string): AuditResult {
  return JSON.parse(stdout) as AuditResult;
}

function assertFailedCheck(result: ReturnType<typeof runAudit>, name: string): void {
  assert.equal(result.status, 1, result.stderr);
  const audit = parseAudit(result.stdout);
  assert.equal(audit.ok, false);
  assert.equal(audit.checks.find((item) => item.name === name)?.ok, false, result.stdout);
}

test.after(async () => {
  await Promise.all(temporaryRepositories.map((root) => rm(root, { recursive: true, force: true })));
});

test("accepts a one-root public candidate", async () => {
  const result = runAudit(await createCandidate());
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(parseAudit(result.stdout).ok, true);
});

test("rejects invalid history, refs, tree paths, privacy text, and author", async () => {
  const invalidCases: readonly [CandidateOptions, string][] = [
    [{ secondCommit: true }, "reachable_commit_count"],
    [{ extraRef: "refs/tags/private" }, "allowed_refs"],
    [{ extraFiles: { [["docs", "superpowers", "private.md"].join("/")]: "private" } }, "tracked_allowlist"],
    [{ extraFiles: { "leak.txt": ["", "Users", "example", "private"].join("/") } }, "privacy_strings"],
    [{ author: "Wrong <wrong@example.test>" }, "root_author"],
  ];
  for (const [options, failure] of invalidCases) assertFailedCheck(runAudit(await createCandidate(options)), failure);
});

test("rejects wrong branch, configured remotes, dirty tracked files, manifest drift, and missing public files", async () => {
  const invalidCases: readonly [CandidateOptions, string][] = [
    [{ branch: "trunk" }, "branch_main"],
    [{ remote: true }, "remote_absence"],
    [{ dirtyTrackedFile: true }, "tracked_clean"],
    [{ manifest: {
      name: "wrong",
      version: "0.1.0-beta.3",
      license: "MIT",
      repository: { type: "git", url: "git+https://github.com/saitolume/git-mcp-server.git" },
      publishConfig: { access: "public", tag: "beta" },
      packageManager: "pnpm@11.15.1",
      engines: { node: ">=22" },
    } }, "manifest_contract"],
    [{ omitFile: "SECURITY.md" }, "required_public_files"],
  ];
  for (const [options, failure] of invalidCases) assertFailedCheck(runAudit(await createCandidate(options)), failure);
});

test("finds every forbidden privacy token without embedding those tokens in this test", async () => {
  const forbidden = [
    [["", "Users", "someone", "workspace"].join("/")],
    [["", "home", "someone", "workspace"].join("/")],
    [["Agent", "Git", "Bridge"].join(" ")],
    [["agent", "git", "bridge"].join("-")],
    [["bridge", "operation", "get"].join("_")],
    [["docs", "superpowers"].join("/")],
    [["implementation", "notes"].join("-") + ".md"],
  ].flat();
  for (const [index, token] of forbidden.entries()) {
    const candidate = await createCandidate({ extraFiles: { [`src/privacy-${index}.txt`]: token } });
    assertFailedCheck(runAudit(candidate), "privacy_strings");
  }
});

test("rejects tracked symlinks without following an allowed package manifest symlink", async () => {
  const validManifest = JSON.stringify({
    name: "@saitolume/git-mcp-server",
    version: "0.1.0-beta.3",
    license: "MIT",
    repository: {
      type: "git",
      url: "git+https://github.com/saitolume/git-mcp-server.git",
    },
    publishConfig: { access: "public", tag: "beta" },
    packageManager: "pnpm@11.15.1",
    engines: { node: ">=22" },
  });
  const result = runAudit(await createCandidate({
    extraFiles: { "src/package-target.json": validManifest },
    symlinkFiles: {
      "package.json": "src/package-target.json",
      "scripts/link.mjs": "fixture.mjs",
    },
  }));
  assertFailedCheck(result, "privacy_strings");
  assert.equal(parseAudit(result.stdout).checks.find((item) => item.name === "manifest_contract")?.ok, false);
});

test("rejects NUL-containing and invalid UTF-8 tracked files in deterministic path order", async () => {
  const result = runAudit(await createCandidate({ extraFiles: {
    "src/z.bin": new Uint8Array([0x61, 0x00, 0x62]),
    "src/a.bin": new Uint8Array([0x00]),
    "src/invalid.txt": new Uint8Array([0xc3, 0x28]),
  } }));
  assertFailedCheck(result, "privacy_strings");
  const privacy = parseAudit(result.stdout).checks.find((item) => item.name === "privacy_strings");
  assert.deepEqual(privacy?.binaryPaths, ["src/a.bin", "src/z.bin"]);
  assert.deepEqual(privacy?.invalidUtf8Paths, ["src/invalid.txt"]);
});

test("rejects tracked gitlinks and non-regular worktree entries", async () => {
  const gitlinkResult = runAudit(await createCandidate({ gitlink: true }));
  assertFailedCheck(gitlinkResult, "privacy_strings");
  const specialResult = runAudit(await createCandidate({
    extraFiles: { "src/special": "regular before commit\n" },
    nonRegularAfterCommit: "src/special",
  }));
  assertFailedCheck(specialResult, "privacy_strings");
});

test("disables optional Git locks for every auditor subprocess", async () => {
  const source = await readFile(auditorPath, "utf8");
  assert.match(source, /GIT_OPTIONAL_LOCKS:\s*["']0["']/);
  assert.match(source, /env:\s*gitEnvironment\(\)/);
});

test("rejects shallow and grafted non-root HEAD objects", async () => {
  for (const metadata of ["shallow", "grafts"] as const) {
    const root = await createCandidate({ secondCommit: true });
    const head = gitOutput(root, ["rev-parse", "HEAD"]);
    const path = metadata === "shallow" ? join(root, ".git", "shallow") : join(root, ".git", "info", "grafts");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${head}\n`);
    const result = runAudit(root);
    assert.equal(parseAudit(result.stdout).checks.find((item) => item.name === "reachable_commit_count")?.ok, true, result.stdout);
    assertFailedCheck(result, "root_has_no_parent");
  }
});

test("requires the exact CLI argument pair and emits JSON usage failures", () => {
  for (const args of [[], ["--repository"], ["--repository", ""], ["--repository", ".", "extra"], ["--repo", "."]]) {
    const result = spawnSync(process.execPath, [auditorPath, ...args], { cwd: projectRoot, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(parseAudit(result.stdout).checks[0]?.name, "usage");
    assert.equal(result.stderr, "");
  }
});

test("can be imported without executing the CLI", () => {
  const source = `import ${JSON.stringify(resolve(auditorPath))};`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", source], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
});
