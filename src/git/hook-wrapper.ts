import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommitHookKind } from "../domain/result.js";

const CLASSIFIED_HOOKS = new Set<CommitHookKind>(["pre-commit", "commit-msg"]);
const KNOWN_GIT_HOOKS = [
  "applypatch-msg", "pre-applypatch", "post-applypatch",
  "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit",
  "pre-rebase", "post-checkout", "post-merge", "pre-push",
  "pre-receive", "update", "proc-receive", "post-receive", "post-update",
  "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite",
  "sendemail-validate", "fsmonitor-watchman",
  "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit",
  "post-index-change",
] as const;
const FAILURE_CHANNEL_MAX_BYTES = 32;

export interface HookWrapperSet {
  readonly directory: string;
  readonly failureConsumer: (chunk: Buffer) => void;
  rejectedHook(): CommitHookKind | undefined;
  cleanup(): Promise<void>;
}

/** Creates a private, permission-restricted commit message file for `git hook run`. */
export async function withNativeCommitMessageFile<T>(
  message: string,
  execute: (path: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "git-mcp-server-commit-msg-"));
  const path = join(directory, "message");
  try {
    await chmod(directory, 0o700);
    await writeFile(path, message, { encoding: "utf8", mode: 0o600 });
    return await execute(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function wrapperScript(original: string, hook: string): string {
  const report = CLASSIFIED_HOOKS.has(hook as CommitHookKind)
    ? `if [ "$status" -ne 0 ]; then printf '%s\\n' ${shellQuote(hook)} >&3 || :; fi\n`
    : "";
  return [
    "#!/bin/sh",
    "unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0",
    `if [ ! -x ${shellQuote(original)} ]; then exit 0; fi`,
    "status=0",
    `${shellQuote(original)} "$@" 3>&- || status=$?`,
    report.trimEnd(),
    'exit "$status"',
    "",
  ].filter((line, index, lines) => line !== "" || index === lines.length - 1).join("\n");
}

class FailureChannel {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private usable = true;

  consume(chunk: Buffer): void {
    if (!this.usable) return;
    this.bytes += chunk.length;
    if (this.bytes > FAILURE_CHANNEL_MAX_BYTES) {
      this.usable = false;
      this.chunks = [];
      return;
    }
    this.chunks.push(Buffer.from(chunk));
  }

  rejectedHook(): CommitHookKind | undefined {
    if (!this.usable) return undefined;
    const marker = Buffer.concat(this.chunks, this.bytes).toString("ascii");
    if (marker === "pre-commit\n") return "pre-commit";
    if (marker === "commit-msg\n") return "commit-msg";
    return undefined;
  }
}

export async function createHookWrappers(originalHooksDirectory: string): Promise<HookWrapperSet> {
  const directory = await mkdtemp(join(tmpdir(), "git-mcp-server-hooks-"));
  await chmod(directory, 0o700);
  const channel = new FailureChannel();
  try {
    let entries: string[];
    try {
      entries = await readdir(originalHooksDirectory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      entries = [];
    }
    const names = new Set<string>([...KNOWN_GIT_HOOKS, ...entries]);
    await Promise.all([...names].map(async (name) => {
      const original = join(originalHooksDirectory, name);
      const wrapper = join(directory, name);
      await writeFile(wrapper, wrapperScript(original, name), { encoding: "utf8", mode: 0o700 });
    }));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    failureConsumer: (chunk) => channel.consume(chunk),
    rejectedHook: () => channel.rejectedHook(),
    cleanup: async () => rm(directory, { recursive: true, force: true }),
  };
}
