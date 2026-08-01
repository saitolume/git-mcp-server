import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CommitHookKind } from "../domain/result.js";
import { isWellFormedGitText } from "../domain/git-text.js";

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
const NATIVE_COMMIT_MAX_BYTES = 66;

export interface HookWrapperSet {
  readonly directory: string;
  readonly failureConsumer: (chunk: Buffer) => void;
  readonly nativeCommitConsumer?: (chunk: Buffer) => void;
  rejectedHook(): CommitHookKind | undefined;
  nativeCommit(): string | undefined;
  cleanup(): Promise<void>;
}

export interface PushHookAdapter {
  readonly directory: string;
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

function wrapperScript(original: string, hook: string, nativeCommitGitExecutable?: string): string {
  const report = CLASSIFIED_HOOKS.has(hook as CommitHookKind)
    ? `if [ "$status" -ne 0 ]; then printf '%s\\n' ${shellQuote(hook)} >&3 || :; fi\n`
    : "";
  const capture = nativeCommitGitExecutable !== undefined && hook === "post-commit"
    ? [
      `if [ "$status" -eq 0 ]; then ${shellQuote(nativeCommitGitExecutable)} --no-replace-objects rev-parse --verify HEAD >&4 || status=$?; fi`,
      'if [ "$status" -eq 0 ]; then printf \'\\0\' >&4 || status=$?; fi',
    ]
    : [];
  return [
    "#!/bin/sh",
    "unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 GIT_CONFIG_KEY_1 GIT_CONFIG_VALUE_1 GIT_MCP_PREPARED_PUSH_ENDPOINT",
    "status=0",
    ...capture,
    `if [ "$status" -eq 0 ] && [ -x ${shellQuote(original)} ]; then ${shellQuote(original)} "$@" 3>&- 4>&- || status=$?; fi`,
    report.trimEnd(),
    'exit "$status"',
    "",
  ].filter((line, index, lines) => line !== "" || index === lines.length - 1).join("\n");
}

function pushAdapterScript(original: string): string {
  return [
    "#!/bin/sh",
    'if [ "${GIT_MCP_PREPARED_PUSH_ENDPOINT+x}" != "x" ]; then exit 1; fi',
    "endpoint=$GIT_MCP_PREPARED_PUSH_ENDPOINT",
    "unset GIT_CONFIG_COUNT GIT_CONFIG_KEY_0 GIT_CONFIG_VALUE_0 GIT_CONFIG_KEY_1 GIT_CONFIG_VALUE_1 GIT_MCP_PREPARED_PUSH_ENDPOINT",
    `if [ ! -x ${shellQuote(original)} ]; then exit 0; fi`,
    `exec ${shellQuote(original)} origin "$endpoint" 3>&-`,
    "",
  ].join("\n");
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

class NativeCommitChannel {
  private readonly chunks: Buffer[] = [];
  private bytes = 0;
  private usable = true;

  consume(chunk: Buffer): void {
    if (!this.usable) return;
    this.bytes += chunk.length;
    if (this.bytes > NATIVE_COMMIT_MAX_BYTES) {
      this.usable = false;
      this.chunks.length = 0;
      return;
    }
    this.chunks.push(Buffer.from(chunk));
  }

  value(): string | undefined {
    if (!this.usable || this.bytes === 0) return undefined;
    const framed = Buffer.concat(this.chunks, this.bytes);
    const terminator = framed.indexOf(0);
    if (terminator !== framed.length - 1) return undefined;
    const bytes = framed.subarray(0, terminator);
    const value = bytes.toString("ascii");
    const match = /^([0-9a-f]{40}|[0-9a-f]{64})\n$/.exec(value);
    return match?.[1];
  }
}

export async function createHookWrappers(
  originalHooksDirectory: string,
  options: { readonly captureNativeCommitWith?: string } = {},
): Promise<HookWrapperSet> {
  const directory = await mkdtemp(join(tmpdir(), "git-mcp-server-hooks-"));
  await chmod(directory, 0o700);
  const channel = new FailureChannel();
  if (options.captureNativeCommitWith !== undefined
    && (!isAbsolute(options.captureNativeCommitWith) || !isWellFormedGitText(options.captureNativeCommitWith))) {
    throw new Error("Native commit capture requires an absolute Git executable path");
  }
  const nativeCommit = options.captureNativeCommitWith === undefined ? undefined : new NativeCommitChannel();
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
      await writeFile(wrapper, wrapperScript(original, name, options.captureNativeCommitWith), { encoding: "utf8", mode: 0o700 });
    }));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    failureConsumer: (chunk) => channel.consume(chunk),
    ...(nativeCommit === undefined ? {} : {
      nativeCommitConsumer: (chunk: Buffer) => nativeCommit.consume(chunk),
    }),
    rejectedHook: () => channel.rejectedHook(),
    nativeCommit: () => nativeCommit?.value(),
    cleanup: async () => rm(directory, { recursive: true, force: true }),
  };
}

/** Creates the one Git-invoked adapter that preserves named-origin pre-push hook semantics. */
export async function createPushHookAdapter(originalHooksDirectory: string): Promise<PushHookAdapter> {
  const directory = await mkdtemp(join(tmpdir(), "git-mcp-server-push-hook-"));
  try {
    await chmod(directory, 0o700);
    await writeFile(join(directory, "pre-push"), pushAdapterScript(join(originalHooksDirectory, "pre-push")), {
      encoding: "utf8",
      mode: 0o700,
    });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return {
    directory,
    cleanup: async () => rm(directory, { recursive: true, force: true }),
  };
}
