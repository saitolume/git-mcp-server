import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { deadlineSignal, isOperationDeadlineExceeded, remainingDeadlineTimeoutMs } from "../deadline.js";
import { OPERATION_TIMEOUT_MS } from "../product.js";
import { assertWellFormedGitText } from "../domain/git-text.js";
import { createGitEnvironment } from "./environment.js";

export interface GitCommand {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly stdin?: string;
  /** Internal streaming hook. When present, stdout is drained here instead of retained. */
  readonly stdoutConsumer?: (chunk: Buffer) => void;
}

export interface GitStreamingCommand extends Omit<GitCommand, "maxOutputBytes" | "stdoutConsumer"> {
  /** stderr remains diagnostic-only and is retained only up to this byte count. */
  readonly maxStderrBytes: number;
}

export interface GitCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly stdoutTruncated: boolean;
  readonly stderrTruncated: boolean;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly durationMs: number;
}

interface GitRunnerOptions {
  readonly terminateGraceMs?: number;
  readonly signalProcessGroup?: (pid: number, signal: NodeJS.Signals) => boolean | void;
  readonly processGroupExists?: (pid: number) => boolean;
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  return process.platform === "win32" ? process.kill(pid, signal) : process.kill(-pid, signal);
}

function processGroupExists(pid: number): boolean {
  if (process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
    throw error;
  }
}

class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private length = 0;
  private didTruncate = false;

  constructor(private readonly limit: number) {}

  append(chunk: Buffer): void {
    const remaining = this.limit - this.length;
    const accepted = Math.max(0, Math.min(remaining, chunk.length));
    if (accepted > 0) {
      this.chunks.push(chunk.subarray(0, accepted));
      this.length += accepted;
    }
    if (accepted < chunk.length) this.didTruncate = true;
  }

  get value(): string {
    const decoder = new StringDecoder("utf8");
    return decoder.write(Buffer.concat(this.chunks, this.length)) + decoder.end();
  }

  get truncated(): boolean {
    return this.didTruncate;
  }
}

export class GitRunner {
  private readonly executablePath: string;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly terminateGraceMs: number;
  private readonly signalProcessGroup: (pid: number, signal: NodeJS.Signals) => boolean | void;
  private readonly processGroupExists: (pid: number) => boolean;

  constructor(
    executablePath: string,
    sourceEnvironment: NodeJS.ProcessEnv,
    options: GitRunnerOptions = {},
  ) {
    this.executablePath = assertWellFormedGitText(executablePath, "Git executable path");
    this.environment = createGitEnvironment(sourceEnvironment);
    this.terminateGraceMs = options.terminateGraceMs ?? OPERATION_TIMEOUT_MS.terminateGrace;
    this.signalProcessGroup = options.signalProcessGroup ?? signalProcessGroup;
    this.processGroupExists = options.processGroupExists ?? processGroupExists;
  }

  async run(command: GitCommand, signal?: AbortSignal): Promise<GitCommandResult> {
    const startedAt = Date.now();
    let effectiveSignal = deadlineSignal(signal);
    if (effectiveSignal?.aborted) {
      return this.terminatedBeforeStart(startedAt, isOperationDeadlineExceeded(effectiveSignal.reason));
    }
    assertWellFormedGitText(command.cwd, "Git working directory");
    for (const argument of command.args) assertWellFormedGitText(argument, "Git argument");
    if (!Number.isSafeInteger(command.maxOutputBytes) || command.maxOutputBytes < 0) {
      throw new RangeError("maxOutputBytes must be a non-negative integer");
    }
    if (!Number.isFinite(command.timeoutMs) || command.timeoutMs < 0) {
      throw new RangeError("timeoutMs must be a non-negative number");
    }
    const timeoutMs = remainingDeadlineTimeoutMs(command.timeoutMs);

    const stdout = new BoundedOutput(command.maxOutputBytes);
    const stderr = new BoundedOutput(command.maxOutputBytes);
    effectiveSignal = deadlineSignal(signal);
    if (effectiveSignal?.aborted) {
      return this.terminatedBeforeStart(startedAt, isOperationDeadlineExceeded(effectiveSignal.reason));
    }
    const child = spawn(this.executablePath, command.args, {
      cwd: command.cwd,
      env: this.environment,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    let consumerError: Error | undefined;
    let failConsumer = (error: unknown): void => {
      consumerError = error instanceof Error ? error : new Error(String(error));
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (command.stdoutConsumer === undefined) {
        stdout.append(chunk);
        return;
      }
      try { command.stdoutConsumer(chunk); }
      catch (error) { failConsumer(error); }
    });
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.stdin.on("error", () => undefined);
    child.stdin.end(command.stdin);

    return new Promise<GitCommandResult>((resolve, reject) => {
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let completed = false;
      let childClosed = false;
      let timedOut = false;
      let aborted = false;
      let terminating = false;
      let groupReclaimed = true;
      let groupSignallingRetired = false;
      let terminationTimer: NodeJS.Timeout | undefined;
      let graceTimer: NodeJS.Timeout | undefined;
      let groupPollTimer: NodeJS.Timeout | undefined;
      let postKillTimer: NodeJS.Timeout | undefined;
      let processError: Error | undefined;
      let terminationError: Error | undefined;

      const clearResources = (): void => {
        if (terminationTimer) clearTimeout(terminationTimer);
        if (graceTimer) clearTimeout(graceTimer);
        if (groupPollTimer) clearInterval(groupPollTimer);
        if (postKillTimer) clearTimeout(postKillTimer);
        effectiveSignal?.removeEventListener("abort", onAbort);
      };
      const rememberTerminationError = (error: unknown): void => {
        if (terminationError) return;
        terminationError = error instanceof Error ? error : new Error(String(error));
      };
      const finish = (): void => {
        if (completed || !childClosed || !groupReclaimed) return;
        completed = true;
        clearResources();
        const result = {
          exitCode,
          signal: exitSignal,
          stdout: stdout.value,
          stderr: stderr.value,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          timedOut,
          aborted,
          durationMs: Date.now() - startedAt,
        };
        if (consumerError) reject(consumerError);
        else if (processError) reject(processError);
        else if (terminationError) reject(terminationError);
        else resolve(result);
      };
      const markGroupReclaimed = (): void => {
        groupReclaimed = true;
        groupSignallingRetired = true;
        if (groupPollTimer) clearInterval(groupPollTimer);
        finish();
      };
      const probeGroup = (): void => {
        if (groupReclaimed || child.pid === undefined) return;
        try {
          if (!this.processGroupExists(child.pid)) markGroupReclaimed();
        } catch (error) {
          rememberTerminationError(error);
          markGroupReclaimed();
        }
      };
      const terminateGroup = (terminationSignal: NodeJS.Signals): "group" | "direct" | "absent" => {
        if (child.pid === undefined || groupSignallingRetired) return "absent";
        try {
          if (this.signalProcessGroup(child.pid, terminationSignal) !== false) return "group";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return "absent";
        }
        try {
          if (!child.kill(terminationSignal)) {
            rememberTerminationError(new Error(`Unable to signal child process with ${terminationSignal}`));
          }
        } catch (error) {
          rememberTerminationError(error);
        }
        return "direct";
      };
      const terminateDirectChild = (terminationSignal: NodeJS.Signals): void => {
        try {
          if (!child.kill(terminationSignal)) {
            rememberTerminationError(new Error(`Unable to signal child process with ${terminationSignal}`));
          }
        } catch (error) {
          rememberTerminationError(error);
        }
      };
      const forceBoundedTerminationFailure = (): void => {
        if (completed) return;
        groupSignallingRetired = true;
        groupReclaimed = true;
        if (groupPollTimer) clearInterval(groupPollTimer);
        rememberTerminationError(new Error("Process group remained alive after SIGKILL"));
        if (!childClosed) {
          terminateDirectChild("SIGKILL");
          child.stdin.destroy();
          child.stdout.destroy();
          child.stderr.destroy();
          child.unref();
          childClosed = true;
        }
        finish();
      };
      const schedulePostKillDeadline = (): void => {
        if (completed) return;
        postKillTimer = setTimeout(() => {
          if (!groupReclaimed) probeGroup();
          if (!childClosed || !groupReclaimed) forceBoundedTerminationFailure();
        }, Math.max(1, this.terminateGraceMs));
      };
      const beginTermination = (reason: "timeout" | "abort" | "consumer"): void => {
        if (completed || terminating) return;
        terminating = true;
        timedOut = reason === "timeout";
        aborted = reason === "abort";
        const scope = terminateGroup("SIGTERM");
        if (scope === "group" && process.platform !== "win32") {
          groupReclaimed = false;
          probeGroup();
          if (!groupReclaimed) {
            const pollMs = Math.max(1, Math.min(10, Math.floor(this.terminateGraceMs / 4) || 1));
            groupPollTimer = setInterval(probeGroup, pollMs);
          }
        } else {
          groupSignallingRetired = true;
          groupReclaimed = true;
        }
        graceTimer = setTimeout(() => {
          if (groupReclaimed) {
            if (!childClosed) {
              terminateDirectChild("SIGKILL");
              schedulePostKillDeadline();
            }
            return;
          }
          probeGroup();
          if (groupReclaimed) {
            if (!childClosed) terminateDirectChild("SIGKILL");
            schedulePostKillDeadline();
            return;
          }
          if (terminateGroup("SIGKILL") !== "group") markGroupReclaimed();
          schedulePostKillDeadline();
        }, this.terminateGraceMs);
      };
      const onAbort = (): void => beginTermination(
        isOperationDeadlineExceeded(effectiveSignal?.reason) ? "timeout" : "abort",
      );
      failConsumer = (error: unknown): void => {
        if (consumerError !== undefined) return;
        consumerError = error instanceof Error ? error : new Error(String(error));
        beginTermination("consumer");
      };
      if (consumerError !== undefined) beginTermination("consumer");

      child.once("error", (error) => {
        processError = error;
      });
      child.once("close", (code, closeSignal) => {
        if (childClosed) return;
        childClosed = true;
        exitCode = code;
        exitSignal = closeSignal;
        finish();
      });

      terminationTimer = setTimeout(() => beginTermination("timeout"), timeoutMs);
      effectiveSignal?.addEventListener("abort", onAbort, { once: true });
      if (effectiveSignal?.aborted) onAbort();
    });
  }

  /**
   * Drains stdout incrementally without an aggregate stdout buffer. The small
   * fallback keeps existing test runners that override run() source-compatible.
   */
  async runStreaming(
    command: GitStreamingCommand,
    consumeStdout: (chunk: Buffer) => void,
    signal?: AbortSignal,
  ): Promise<GitCommandResult> {
    let streamed = false;
    const result = await this.run({
      cwd: command.cwd,
      args: command.args,
      timeoutMs: command.timeoutMs,
      maxOutputBytes: command.maxStderrBytes,
      ...(command.stdin === undefined ? {} : { stdin: command.stdin }),
      stdoutConsumer: (chunk) => {
        streamed = true;
        consumeStdout(chunk);
      },
    }, signal);
    if (!streamed && result.stdout !== "") consumeStdout(Buffer.from(result.stdout, "utf8"));
    return { ...result, stdout: "" };
  }

  private terminatedBeforeStart(startedAt: number, timedOut: boolean): GitCommandResult {
    return {
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      timedOut,
      aborted: !timedOut,
      durationMs: Date.now() - startedAt,
    };
  }
}
