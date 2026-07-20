import { spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { TextDecoder } from "node:util";

export const EXPECTED_AUTHOR = "Tadao Iseki <me@saitolume.com>";
export const ALLOWED_ROOTS = Object.freeze(["src/", "test/", "scripts/"]);
export const ALLOWED_FILES = new Set([
  ".github/workflows/ci.yml",
  ".gitignore",
  "LICENSE",
  "README.md",
  "README.ja.md",
  "SECURITY.md",
  "docs/architecture.md",
  "docs/acceptance/provider-checklist.md",
  "package.json",
  "pnpm-lock.yaml",
  "tsconfig.json",
  "tsconfig.build.json",
  "tsconfig.test.json",
]);

const PRIVACY_RULES = Object.freeze([
  { name: "macos_home_path", value: ["", "Users", ""].join("/") },
  { name: "linux_home_path", value: ["", "home", ""].join("/") },
  { name: "retired_display_name", value: ["Agent", "Git", "Bridge"].join(" ") },
  { name: "retired_product_id", value: ["agent", "git", "bridge"].join("-") },
  { name: "retired_operation_lookup", value: ["bridge", "operation", "get"].join("_") },
  { name: "internal_design_directory", value: ["docs", "superpowers"].join("/") },
  { name: "implementation_notes", value: `${["implementation", "notes"].join("-")}.md` },
]);

export function isAllowedTrackedPath(path) {
  return ALLOWED_FILES.has(path) || ALLOWED_ROOTS.some((root) => path.startsWith(root));
}

function check(name, ok, details) {
  return { name, ok, ...details };
}

function gitEnvironment() {
  const env = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of ["PATH", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function runGit(repository, args) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    encoding: "utf8",
    env: gitEnvironment(),
    shell: false,
  });
  const error = result.error?.message || (result.status === 0 ? undefined : result.stderr.trim() || `git exited ${result.status ?? "without status"}`);
  return { ok: result.status === 0, stdout: result.stdout ?? "", ...(error ? { error } : {}) };
}

function runGitBytes(repository, args) {
  const result = spawnSync("git", ["-C", repository, ...args], {
    env: gitEnvironment(),
    shell: false,
  });
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString("utf8").trim() : "";
  const error = result.error?.message || (result.status === 0 ? undefined : stderr || `git exited ${result.status ?? "without status"}`);
  return { ok: result.status === 0, stdout: result.stdout ?? Buffer.alloc(0), ...(error ? { error } : {}) };
}

function lines(output) {
  const trimmed = output.trim();
  return trimmed === "" ? [] : trimmed.split("\n");
}

function parseTrackedEntries(output) {
  const entries = [];
  const indexErrors = [];
  for (const record of output.split("\0").filter((value) => value !== "")) {
    const separator = record.indexOf("\t");
    const metadata = separator === -1 ? [] : record.slice(0, separator).split(" ");
    const path = separator === -1 ? "" : record.slice(separator + 1);
    if (metadata.length !== 3 || !/^[0-7]{6}$/.test(metadata[0] ?? "") || !/^[0-9a-f]{40,64}$/.test(metadata[1] ?? "") || metadata[2] !== "0" || path === "") {
      indexErrors.push({ record });
      continue;
    }
    entries.push({ mode: metadata[0], object: metadata[1], path });
  }
  return { entries, indexErrors };
}

function isBinary(contents) {
  return contents.some((byte) => byte === 0 || byte < 0x09 || (byte > 0x0d && byte < 0x20) || byte === 0x7f);
}

function inspectWorktreePath(repository, path, mode) {
  let current = repository;
  const components = path.split("/");
  for (const [index, component] of components.entries()) {
    current = resolve(current, component);
    const stat = lstatSync(current);
    if (index < components.length - 1) {
      if (!stat.isDirectory()) return { path, mode, reason: "non_directory_worktree_ancestor" };
    } else if (!stat.isFile()) {
      return { path, mode, reason: "non_regular_worktree_entry" };
    }
  }
  return null;
}

function inspectTrackedContents(repository, trackedEntries) {
  const findings = [];
  const binaryPaths = [];
  const invalidUtf8Paths = [];
  const unsupportedTrackedEntries = [];
  const readErrors = [];
  const textFiles = new Map();
  for (const { mode, object, path } of [...trackedEntries].sort((left, right) => left.path.localeCompare(right.path))) {
    if (mode !== "100644" && mode !== "100755") {
      const reason = mode === "120000" ? "symlink" : mode === "160000" ? "gitlink" : "unsupported_index_mode";
      unsupportedTrackedEntries.push({ path, mode, reason });
      continue;
    }
    try {
      const unsupported = inspectWorktreePath(repository, path, mode);
      if (unsupported) {
        unsupportedTrackedEntries.push(unsupported);
        continue;
      }
      const blob = runGitBytes(repository, ["cat-file", "blob", object]);
      if (!blob.ok) {
        readErrors.push({ path, error: blob.error });
        continue;
      }
      const contents = blob.stdout;
      if (isBinary(contents)) {
        binaryPaths.push(path);
        continue;
      }
      let text;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
      } catch {
        invalidUtf8Paths.push(path);
        continue;
      }
      textFiles.set(path, text);
      for (const rule of PRIVACY_RULES) {
        if (path.includes(rule.value) || text.includes(rule.value)) findings.push({ path, rule: rule.name });
      }
    } catch (error) {
      readErrors.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { findings, binaryPaths, invalidUtf8Paths, unsupportedTrackedEntries, readErrors, textFiles };
}

function inspectManifest(trackedPaths, textFiles) {
  const expected = {
    name: "git-mcp-server",
    license: "MIT",
    packageManager: "pnpm@11.15.1",
    engines: { node: ">=22" },
  };
  if (!trackedPaths.includes("package.json")) return { matches: false, expected, actual: null, error: "package.json is not tracked" };
  try {
    const manifestText = textFiles.get("package.json");
    if (manifestText === undefined) throw new Error("package.json is not a regular UTF-8 text file");
    const manifest = JSON.parse(manifestText);
    const actual = {
      name: manifest.name,
      license: manifest.license,
      packageManager: manifest.packageManager,
      engines: manifest.engines,
    };
    const enginesMatch = manifest.engines !== null
      && typeof manifest.engines === "object"
      && !Array.isArray(manifest.engines)
      && Object.keys(manifest.engines).length === 1
      && manifest.engines.node === expected.engines.node;
    const matches = manifest.name === expected.name
      && manifest.license === expected.license
      && manifest.packageManager === expected.packageManager
      && enginesMatch;
    return { matches, expected, actual };
  } catch (error) {
    return { matches: false, expected, actual: null, error: error instanceof Error ? error.message : String(error) };
  }
}

export function checkPublicationReadiness(repository) {
  const target = resolve(repository);
  const branchResult = runGit(target, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const commitsResult = runGit(target, ["rev-list", "--all"]);
  const rawCommitResult = runGit(target, ["--no-replace-objects", "cat-file", "commit", "HEAD"]);
  const refsResult = runGit(target, ["for-each-ref", "--format=%(refname)"]);
  const authorResult = runGit(target, ["show", "-s", "--format=%an <%ae>", "HEAD"]);
  const statusResult = runGit(target, ["status", "--porcelain=v1", "--untracked-files=no"]);
  const pathsResult = runGit(target, ["ls-files", "--stage", "-z"]);
  const remotesResult = runGit(target, ["remote"]);

  const currentBranch = branchResult.stdout.trim();
  const commits = lines(commitsResult.stdout);
  const headerEnd = rawCommitResult.stdout.indexOf("\n\n");
  const commitHeaders = headerEnd === -1 ? [] : rawCommitResult.stdout.slice(0, headerEnd).split("\n");
  const parentHeaders = commitHeaders.filter((line) => line.startsWith("parent "));
  const refs = lines(refsResult.stdout);
  const unexpectedRefs = refs.filter((ref) => ref !== "refs/heads/main");
  const author = authorResult.stdout.trim();
  const porcelain = statusResult.stdout;
  const tracked = parseTrackedEntries(pathsResult.stdout);
  const trackedPaths = tracked.entries.map((entry) => entry.path);
  const unexpectedPaths = trackedPaths.filter((path) => !isAllowedTrackedPath(path)).sort();
  const remotes = lines(remotesResult.stdout).sort();
  const inspectedContents = inspectTrackedContents(target, tracked.entries);
  const { textFiles: _textFiles, ...privacy } = inspectedContents;
  const manifest = inspectManifest(trackedPaths, inspectedContents.textFiles);
  const missingFiles = [...ALLOWED_FILES].filter((path) => !trackedPaths.includes(path)).sort();

  const checks = [
    check("branch_main", branchResult.ok && currentBranch === "main", { currentBranch, ...(branchResult.error ? { error: branchResult.error } : {}) }),
    check("reachable_commit_count", commitsResult.ok && commits.length === 1, { actual: commits.length, ...(commitsResult.error ? { error: commitsResult.error } : {}) }),
    check("root_has_no_parent", rawCommitResult.ok && headerEnd !== -1 && parentHeaders.length === 0, { parentCount: parentHeaders.length, rawHeaderValid: headerEnd !== -1, ...(rawCommitResult.error ? { error: rawCommitResult.error } : {}) }),
    check("allowed_refs", refsResult.ok && refs.length === 1 && unexpectedRefs.length === 0, { unexpectedRefs, refs, ...(refsResult.error ? { error: refsResult.error } : {}) }),
    check("remote_absence", remotesResult.ok && remotes.length === 0, { remotes, ...(remotesResult.error ? { error: remotesResult.error } : {}) }),
    check("root_author", authorResult.ok && author === EXPECTED_AUTHOR, { author, ...(authorResult.error ? { error: authorResult.error } : {}) }),
    check("tracked_clean", statusResult.ok && porcelain.length === 0, { porcelain, ...(statusResult.error ? { error: statusResult.error } : {}) }),
    check("tracked_allowlist", pathsResult.ok && tracked.indexErrors.length === 0 && unexpectedPaths.length === 0, { unexpectedPaths, indexErrors: tracked.indexErrors, ...(pathsResult.error ? { error: pathsResult.error } : {}) }),
    check("privacy_strings", pathsResult.ok
      && tracked.indexErrors.length === 0
      && privacy.findings.length === 0
      && privacy.binaryPaths.length === 0
      && privacy.invalidUtf8Paths.length === 0
      && privacy.unsupportedTrackedEntries.length === 0
      && privacy.readErrors.length === 0, privacy),
    check("manifest_contract", manifest.matches, { expected: manifest.expected, actual: manifest.actual, ...(manifest.error ? { error: manifest.error } : {}) }),
    check("required_public_files", pathsResult.ok && missingFiles.length === 0, { missingFiles, ...(pathsResult.error ? { error: pathsResult.error } : {}) }),
  ];
  return { ok: checks.every((item) => item.ok), checks };
}

export function readRepositoryArgument(args) {
  if (args.length !== 2 || args[0] !== "--repository" || args[1].trim() === "") {
    throw new Error("usage: check-publication-readiness.mjs --repository <path>");
  }
  return args[1];
}

function usageResult(error) {
  return {
    ok: false,
    checks: [check("usage", false, { error: error instanceof Error ? error.message : String(error) })],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let result;
  try {
    result = checkPublicationReadiness(readRepositoryArgument(process.argv.slice(2)));
  } catch (error) {
    result = usageResult(error);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.ok ? 0 : 1;
}
