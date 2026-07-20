import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { BridgeRejection } from "../src/domain/result.js";
import { resolveGitExecutable } from "../src/git/environment.js";
import {
  assertMutationReady,
  inspectRepository,
  resolveRepositoryIdentity,
  type RepositorySnapshot,
} from "../src/git/repository.js";
import { GitRunner, type GitCommand, type GitCommandResult } from "../src/git/runner.js";

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "git-mcp-server-repository-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function gitRunner(): Promise<GitRunner> {
  return new GitRunner(await resolveGitExecutable(), process.env);
}

async function runGit(runner: GitRunner, cwd: string, args: readonly string[]): Promise<string> {
  const result = await runner.run({ cwd, args, timeoutMs: 10_000, maxOutputBytes: 32_768 });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.equal(result.stdoutTruncated, false);
  assert.equal(result.stderrTruncated, false);
  return result.stdout;
}

async function createRepository(t: test.TestContext): Promise<{ directory: string; runner: GitRunner }> {
  const directory = await temporaryDirectory(t);
  const runner = await gitRunner();
  await runGit(runner, directory, ["init", "--initial-branch=main"]);
  await runGit(runner, directory, ["config", "user.name", "git-mcp-server Test"]);
  await runGit(runner, directory, ["config", "user.email", "git-mcp-server@example.test"]);
  await writeFile(join(directory, "README.md"), "initial\n");
  await runGit(runner, directory, ["add", "README.md"]);
  await runGit(runner, directory, ["-c", "commit.gpgSign=false", "commit", "-m", "initial"]);
  return { directory, runner };
}

async function repositoryWriteState(directory: string): Promise<unknown> {
  const indexPath = join(directory, ".git", "index");
  const index = await lstat(indexPath);
  const objects = (await readdir(join(directory, ".git", "objects"), { recursive: true }))
    .filter((entry) => /^[0-9a-f]{2}\/[0-9a-f]{38,62}$/.test(entry))
    .sort();
  return {
    index: await readFile(indexPath),
    metadata: { mode: index.mode, size: index.size, ino: index.ino, mtimeMs: index.mtimeMs, ctimeMs: index.ctimeMs },
    objects,
  };
}

class RetargetingGitRunner extends GitRunner {
  readonly commandCwds: string[] = [];
  private retargeting: Promise<void> | undefined;

  constructor(
    private readonly delegate: GitRunner,
    private readonly repositoryLink: string,
    private readonly replacement: string,
  ) {
    super(process.execPath, process.env);
  }

  override async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    this.commandCwds.push(command.cwd);
    this.retargeting ??= this.retarget();
    await this.retargeting;
    return this.delegate.run(command, signal);
  }

  private async retarget(): Promise<void> {
    await unlink(this.repositoryLink);
    await symlink(this.replacement, this.repositoryLink);
  }
}

test("repository inspection captures a canonical normal repository snapshot", async (t) => {
  const { directory, runner } = await createRepository(t);

  const snapshot = await inspectRepository(runner, directory);

  assert.equal(snapshot.root, await realpath(directory));
  assert.equal(snapshot.branch, "main");
  assert.equal(snapshot.branchRef, "refs/heads/main");
  assert.match(snapshot.head, /^[0-9a-f]{40,64}$/);
  assert.match(snapshot.headTree, /^[0-9a-f]{40,64}$/);
  assert.match(snapshot.indexTree, /^[0-9a-f]{64}$/);
  assert.equal((snapshot as RepositorySnapshot & { indexMatchesHead: boolean }).indexMatchesHead, true);
  assert.match(snapshot.repositoryId, /^[0-9a-f]{64}$/);
  assert.equal(snapshot.operationState, "none");
  assert.notEqual(snapshot.indexTree, snapshot.headTree);
});

test("repository identity rejects a lone-surrogate alias before Git can observe the replacement path", async (t) => {
  const parent = await temporaryDirectory(t);
  const replacementRepository = join(parent, "repo-\uFFFD");
  const surrogateAlias = join(parent, "repo-\uD800");
  await mkdir(join(replacementRepository, ".git"), { recursive: true });
  assert.equal(await realpath(surrogateAlias), await realpath(replacementRepository));
  const commands: GitCommand[] = [];
  const runner = new class extends GitRunner {
    constructor() { super(process.execPath, process.env); }
    override async run(command: GitCommand): Promise<GitCommandResult> {
      commands.push(command);
      const argument = command.args.at(-1);
      const stdout = argument === "--show-toplevel" ? `${replacementRepository}\n`
        : argument === "--git-dir" || argument === "--git-common-dir" ? `${join(replacementRepository, ".git")}\n` : "";
      return { exitCode: 0, signal: null, stdout, stderr: "", stdoutTruncated: false,
        stderrTruncated: false, timedOut: false, aborted: false, durationMs: 0 };
    }
  }();

  await assert.rejects(resolveRepositoryIdentity(runner, surrogateAlias), /Unicode|well-formed/i);
  assert.deepEqual(commands, []);
});

test("repository inspection uses a non-writing full index fingerprint", async (t) => {
  const { directory, runner } = await createRepository(t);
  await writeFile(join(directory, "README.md"), "staged change\n");
  await runGit(runner, directory, ["add", "--", "README.md"]);
  const before = await repositoryWriteState(directory);

  const first = await inspectRepository(runner, directory);
  const second = await inspectRepository(runner, directory);

  assert.match(first.indexTree, /^[0-9a-f]{64}$/);
  assert.equal((first as RepositorySnapshot & { indexMatchesHead: boolean }).indexMatchesHead, false);
  assert.equal(second.indexTree, first.indexTree);
  assert.deepEqual(await repositoryWriteState(directory), before);
});

test("repository inspection derives branch names only from canonical full symbolic refs", async (t) => {
  const { directory, runner } = await createRepository(t);
  await runGit(runner, directory, ["tag", "main"]);

  const main = await inspectRepository(runner, directory);
  assert.equal(main.branch, "main");
  assert.equal(main.branchRef, "refs/heads/main");

  await runGit(runner, directory, ["switch", "-c", "heads/main"]);
  const nested = await inspectRepository(runner, directory);
  assert.equal(nested.branch, "heads/main");
  assert.equal(nested.branchRef, "refs/heads/heads/main");
});

test("repository inspection represents a real unmerged index without masking its merge state", async (t) => {
  const { directory, runner } = await createRepository(t);
  await runGit(runner, directory, ["checkout", "-b", "topic"]);
  await writeFile(join(directory, "README.md"), "topic\\n");
  await runGit(runner, directory, ["add", "README.md"]);
  await runGit(runner, directory, ["-c", "commit.gpgSign=false", "commit", "-m", "topic"]);
  await runGit(runner, directory, ["checkout", "main"]);
  await writeFile(join(directory, "README.md"), "main\\n");
  await runGit(runner, directory, ["add", "README.md"]);
  await runGit(runner, directory, ["-c", "commit.gpgSign=false", "commit", "-m", "main"]);
  const beforeMerge = await inspectRepository(runner, directory);
  const merge = await runner.run({
    cwd: directory, args: ["merge", "topic"], timeoutMs: 10_000, maxOutputBytes: 32_768,
  });
  assert.notEqual(merge.exitCode, 0);

  const snapshot = await inspectRepository(runner, directory);

  assert.equal(snapshot.operationState, "merge");
  assert.match(snapshot.indexTree, /^[0-9a-f]{64}$/);
  assert.notEqual(snapshot.indexTree, beforeMerge.indexTree);
});

test("repository inspection fingerprints the complete stage map without write-tree", async (t) => {
  const { directory } = await createRepository(t);
  const object = "a".repeat(40);
  const commands: string[] = [];
  const runner = new class extends GitRunner {
    constructor() { super(process.execPath, process.env); }
    override async run(command: GitCommand): Promise<GitCommandResult> {
      commands.push(command.args.join(" "));
      const stdout = (() => {
        if (command.args.join(" ") === "rev-parse --show-toplevel") return `${directory}\n`;
        if (command.args.join(" ") === "rev-parse --path-format=absolute --git-dir") return `${join(directory, ".git")}\n`;
        if (command.args.join(" ") === "rev-parse --path-format=absolute --git-common-dir") return `${join(directory, ".git")}\n`;
        if (command.args.join(" ") === "symbolic-ref --quiet HEAD") return "refs/heads/main\n";
        if (command.args.join(" ") === "rev-parse --verify HEAD" || command.args.join(" ") === "rev-parse --verify HEAD^{tree}") return `${object}\n`;
        if (command.args.join(" ") === "ls-files --stage -z") return `100644 ${object} 0\tREADME.md\0`;
        return "";
      })();
      if (command.args.join(" ") === "diff-index --cached --quiet --no-ext-diff HEAD --") {
        return { exitCode: 0, signal: null, stdout: "", stderr: "", stdoutTruncated: false,
          stderrTruncated: false, timedOut: false, aborted: false, durationMs: 0 };
      }
      return {
        exitCode: 0, signal: null, stdout, stderr: "", stdoutTruncated: false,
        stderrTruncated: false, timedOut: false, aborted: false, durationMs: 0,
      };
    }
  }();

  const snapshot = await inspectRepository(runner, directory);
  assert.match(snapshot.indexTree, /^[0-9a-f]{64}$/);
  assert.equal((snapshot as RepositorySnapshot & { indexMatchesHead: boolean }).indexMatchesHead, true);
  assert.equal(commands.includes("ls-files --stage -z"), true);
  assert.equal(commands.some((command) => command.includes("write-tree")), false);
});

test("repository inspection rejects ambiguous replacement characters in unmerged stage text", async (t) => {
  const { directory } = await createRepository(t);
  const object = "a".repeat(40);
  const runner = new class extends GitRunner {
    constructor() { super(process.execPath, process.env); }
    override async run(command: GitCommand): Promise<GitCommandResult> {
      const args = command.args.join(" ");
      const stdout = args === "rev-parse --show-toplevel" ? `${directory}\n`
        : args === "rev-parse --path-format=absolute --git-dir" || args === "rev-parse --path-format=absolute --git-common-dir" ? `${join(directory, ".git")}\n`
          : args === "symbolic-ref --quiet HEAD" ? "refs/heads/main\n"
            : args === "rev-parse --verify HEAD" || args === "rev-parse --verify HEAD^{tree}" ? `${object}\n`
              : args === "ls-files --stage -z" ? `100644 ${object} 1\tbad�\0` : "";
      return {
        exitCode: 0, signal: null, stdout, stderr: "", stdoutTruncated: false,
        stderrTruncated: false, timedOut: false, aborted: false, durationMs: 0,
      };
    }
  }();

  await assert.rejects(inspectRepository(runner, directory), /malformed Git output: git ls-files --stage -z/);
});

test("repository inspection rejects noncanonical unmerged index modes", async (t) => {
  const { directory } = await createRepository(t);
  const object = "a".repeat(40);
  const runner = new class extends GitRunner {
    constructor() { super(process.execPath, process.env); }
    override async run(command: GitCommand): Promise<GitCommandResult> {
      const args = command.args.join(" ");
      const stdout = args === "rev-parse --show-toplevel" ? `${directory}\n`
        : args === "rev-parse --path-format=absolute --git-dir" || args === "rev-parse --path-format=absolute --git-common-dir" ? `${join(directory, ".git")}\n`
          : args === "symbolic-ref --quiet HEAD" ? "refs/heads/main\n"
            : args === "rev-parse --verify HEAD" || args === "rev-parse --verify HEAD^{tree}" ? `${object}\n`
              : args === "ls-files --stage -z" ? `777777 ${object} 1\tbad\0` : "";
      return { exitCode: 0, signal: null, stdout, stderr: "", stdoutTruncated: false, stderrTruncated: false, timedOut: false, aborted: false, durationMs: 0 };
    }
  }();

  await assert.rejects(inspectRepository(runner, directory), /malformed Git output: git ls-files --stage -z/);
});

test("repository inspection shares the canonical common git directory across linked worktrees", async (t) => {
  const { directory, runner } = await createRepository(t);
  const linkedParent = await temporaryDirectory(t);
  const linkedWorktree = join(linkedParent, "linked-worktree");
  await runGit(runner, directory, ["worktree", "add", "--detach", linkedWorktree, "HEAD"]);

  const primary = await inspectRepository(runner, directory);
  const linked = await inspectRepository(runner, linkedWorktree);

  assert.notEqual(primary.gitDir, linked.gitDir);
  assert.equal(primary.commonGitDir, linked.commonGitDir);
  assert.equal(primary.repositoryId, linked.repositoryId);
});

test("repository inspection reports detached HEAD", async (t) => {
  const { directory, runner } = await createRepository(t);
  await runGit(runner, directory, ["checkout", "--detach"]);

  const snapshot = await inspectRepository(runner, directory);

  assert.equal(snapshot.branch, null);
  assert.equal(snapshot.operationState, "none");
});

test("repository inspection reports a synthetic MERGE_HEAD in the worktree git directory", async (t) => {
  const { directory, runner } = await createRepository(t);
  const original = await inspectRepository(runner, directory);
  await writeFile(join(original.gitDir, "MERGE_HEAD"), `${original.head}\n`);

  const snapshot = await inspectRepository(runner, directory);

  assert.equal(snapshot.operationState, "merge");
});

test("repository inspection produces a stable repository identifier", async (t) => {
  const { directory, runner } = await createRepository(t);

  const first = await resolveRepositoryIdentity(runner, directory);
  const second = await resolveRepositoryIdentity(runner, directory);

  assert.deepEqual(second, first);
});

test("repository inspection pins the canonical repository path before Git commands can retarget a symlink", async (t) => {
  const first = await createRepository(t);
  const second = await createRepository(t);
  await writeFile(join(second.directory, "README.md"), "second repository\n");
  await runGit(second.runner, second.directory, ["add", "README.md"]);
  await runGit(second.runner, second.directory, ["-c", "commit.gpgSign=false", "commit", "-m", "second"]);
  const linkParent = await temporaryDirectory(t);
  const repositoryLink = join(linkParent, "repository-link");
  await symlink(first.directory, repositoryLink);
  const expected = await inspectRepository(first.runner, first.directory);
  const runner = new RetargetingGitRunner(first.runner, repositoryLink, second.directory);

  const snapshot = await inspectRepository(runner, repositoryLink);

  assert.notEqual(first.directory, second.directory);
  assert.equal(snapshot.root, expected.root);
  assert.equal(snapshot.head, expected.head);
  assert.notEqual(snapshot.head, (await inspectRepository(second.runner, second.directory)).head);
  assert.ok(runner.commandCwds.length > 3);
  assert.ok(runner.commandCwds.every((cwd) => cwd === expected.root));
});

test("repository inspection rejects non-repositories and malformed Git output", async (t) => {
  const directory = await temporaryDirectory(t);
  const runner = await gitRunner();
  await assert.rejects(inspectRepository(runner, directory), /Git command failed/);

  const malformedRunner = {
    run: async (_command: GitCommand): Promise<GitCommandResult> => ({
      exitCode: 0, signal: null, stdout: "unexpected\nextra\n", stderr: "",
      stdoutTruncated: false, stderrTruncated: false, timedOut: false, aborted: false, durationMs: 0,
    }),
  } as GitRunner;
  await assert.rejects(resolveRepositoryIdentity(malformedRunner, directory), /malformed Git output/);
});

test("repository inspection mutation guard rejects unsupported state before branch or head checks", async (t) => {
  const { directory, runner } = await createRepository(t);
  const snapshot = await inspectRepository(runner, directory);
  const unsupported = { ...snapshot, operationState: "merge" as const };

  assert.throws(
    () => assertMutationReady(unsupported, "other", "0".repeat(40)),
    (error: unknown) => error instanceof BridgeRejection
      && error.error.code === "UNSUPPORTED_REPOSITORY_STATE"
      && error.error.details?.operationState === "merge"
      && error.error.details?.branch === "main"
      && error.error.details?.head === snapshot.head,
  );
});

test("repository inspection mutation guard rejects detached HEAD", async (t) => {
  const { directory, runner } = await createRepository(t);
  await runGit(runner, directory, ["checkout", "--detach"]);
  const snapshot = await inspectRepository(runner, directory);

  assert.throws(
    () => assertMutationReady(snapshot, "main", snapshot.head),
    (error: unknown) => error instanceof BridgeRejection
      && error.error.code === "UNSUPPORTED_REPOSITORY_STATE"
      && error.error.details?.operationState === "none"
      && error.error.details?.branch === null
      && error.error.details?.head === snapshot.head,
  );
});

test("repository inspection mutation guard rejects branch mismatch with observations", async (t) => {
  const { directory, runner } = await createRepository(t);
  const snapshot = await inspectRepository(runner, directory);

  assert.throws(
    () => assertMutationReady(snapshot, "expected", snapshot.head),
    (error: unknown) => error instanceof BridgeRejection
      && error.error.code === "BRANCH_MISMATCH"
      && error.error.details?.expectedBranch === "expected"
      && error.error.details?.observedBranch === "main"
      && error.error.details?.operationState === "none",
  );
});

test("repository inspection mutation guard rejects HEAD mismatch with observations", async (t) => {
  const { directory, runner } = await createRepository(t);
  const snapshot = await inspectRepository(runner, directory);
  const expectedHead = "0".repeat(40);

  assert.throws(
    () => assertMutationReady(snapshot, "main", expectedHead),
    (error: unknown) => error instanceof BridgeRejection
      && error.error.code === "HEAD_MISMATCH"
      && error.error.details?.expectedHead === expectedHead
      && error.error.details?.observedHead === snapshot.head
      && error.error.details?.branch === "main"
      && error.error.details?.operationState === "none",
  );
});
