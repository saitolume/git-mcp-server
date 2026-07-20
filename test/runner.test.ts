import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withDeadline } from "../src/deadline.js";
import { createGitEnvironment, resolveGitExecutable } from "../src/git/environment.js";
import { GitRunner } from "../src/git/runner.js";

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "git-mcp-server-runner-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return directory;
}

function nodeRunner(): GitRunner {
  return new GitRunner(process.execPath, process.env);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`process ${pid} was still alive after one second`);
}

async function waitForFileText(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { return await readFile(path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`file ${path} was not ready after five seconds`);
}

test("Git environment keeps only the approved variables and fixed Git settings", () => {
  const environment = createGitEnvironment({
    HOME: join("/", "home", "agent"), PATH: "/usr/bin:/bin", USER: "agent", LOGNAME: "agent",
    TMPDIR: "/tmp/agent", LANG: "ja_JP.UTF-8", LC_CTYPE: "ja_JP.UTF-8",
    SSH_AUTH_SOCK: "/tmp/ssh.sock", XDG_CONFIG_HOME: "/tmp/config", XDG_RUNTIME_DIR: "/tmp/runtime",
    GIT_DIR: "/unsafe/git", GIT_INDEX_FILE: "/unsafe/index", GIT_CONFIG_GLOBAL: "/unsafe/config",
    LD_PRELOAD: "/unsafe/preload", DYLD_INSERT_LIBRARIES: "/unsafe/dylib", SSH_ASKPASS: "/unsafe/askpass",
    VISUAL: "unsafe-editor", LESS: "unsafe-pager", UNRELATED: "unsafe",
  });

  assert.deepEqual(environment, {
    HOME: join("/", "home", "agent"), PATH: "/usr/bin:/bin", USER: "agent", LOGNAME: "agent",
    TMPDIR: "/tmp/agent", LANG: "ja_JP.UTF-8", LC_CTYPE: "ja_JP.UTF-8",
    SSH_AUTH_SOCK: "/tmp/ssh.sock", XDG_CONFIG_HOME: "/tmp/config", XDG_RUNTIME_DIR: "/tmp/runtime",
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "Never", GIT_PAGER: "cat", PAGER: "cat", GIT_EDITOR: ":",
    GIT_OPTIONAL_LOCKS: "0",
  });
});

test("resolveGitExecutable returns the real path of the first executable Git candidate", async (t) => {
  const directory = await temporaryDirectory(t);
  const gitPath = join(directory, "git");
  await symlink(process.execPath, gitPath);

  assert.equal(await resolveGitExecutable(directory), await realpath(process.execPath));
});

test("resolveGitExecutable rejects empty, relative, and missing Git paths", async (t) => {
  const directory = await temporaryDirectory(t);
  await assert.rejects(resolveGitExecutable(""), /PATH must not be empty/);
  await assert.rejects(resolveGitExecutable("relative:/usr/bin"), /absolute/);
  await assert.rejects(resolveGitExecutable(directory), /Git executable not found/);
});

test("resolveGitExecutable skips a directory named git", async (t) => {
  const directory = await temporaryDirectory(t);
  const invalidDirectory = join(directory, "invalid");
  const validDirectory = join(directory, "valid");
  await mkdir(join(invalidDirectory, "git"), { recursive: true });
  await mkdir(validDirectory);
  await symlink(process.execPath, join(validDirectory, "git"));

  assert.equal(await resolveGitExecutable(`${invalidDirectory}:${validDirectory}`), await realpath(process.execPath));
});

test("GitRunner collects normal output and stdin", async (t) => {
  const cwd = await temporaryDirectory(t);
  const result = await nodeRunner().run({
    cwd,
    args: ["-e", "process.stdin.on('data', value => process.stdout.write(value)); process.stderr.write('problem');"],
    stdin: "input", timeoutMs: 1_000, maxOutputBytes: 100,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "input");
  assert.equal(result.stderr, "problem");
  assert.equal(result.stdoutTruncated, false);
  assert.equal(result.stderrTruncated, false);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  assert.ok(result.durationMs >= 0);
});

test("GitRunner caps each output stream by bytes while continuing to drain", async (t) => {
  const cwd = await temporaryDirectory(t);
  const result = await nodeRunner().run({
    cwd,
    args: ["-e", "process.stdout.write('abcdef'); process.stderr.write('uvwxyz')"],
    timeoutMs: 1_000, maxOutputBytes: 4,
  });

  assert.equal(result.stdout, "abcd");
  assert.equal(result.stderr, "uvwx");
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
});

test("GitRunner clamps a long child to the active absolute operation deadline", async (t) => {
  const cwd = await temporaryDirectory(t);
  const started = Date.now();
  const result = await withDeadline(40, undefined, (signal) => nodeRunner().run({
    cwd,
    args: ["-e", "setInterval(() => {}, 1000)"],
    timeoutMs: 10_000,
    maxOutputBytes: 100,
  }, signal));

  assert.equal(result.exitCode === null || result.exitCode !== 0, true);
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.ok(Date.now() - started < 2_000);
});

test("GitRunner reports an already-expired operation budget as timeout rather than caller abort", async (t) => {
  const cwd = await temporaryDirectory(t);
  const result = await withDeadline(0, undefined, (signal) => nodeRunner().run({
    cwd,
    args: ["-e", "process.exit(0)"],
    timeoutMs: 10_000,
    maxOutputBytes: 100,
  }, signal));

  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
});

test("GitRunner rechecks an absolute deadline after timeout clamping and never spawns across the boundary", async (t) => {
  const cwd = await temporaryDirectory(t);
  const marker = join(cwd, "spawned-after-deadline");
  const timeline = [0, 0, 0, 0, 1_001];
  let reads = 0;
  const result = await withDeadline(1_000, undefined, (signal) => nodeRunner().run({
    cwd,
    args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`],
    timeoutMs: 10_000,
    maxOutputBytes: 100,
  }, signal), { monotonicNow: () => timeline[Math.min(reads++, timeline.length - 1)]! });

  assert.equal(result.exitCode, null);
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  await assert.rejects(access(marker, constants.F_OK));
});

test("GitRunner handles an abort that becomes visible while its listener is registered", async (t) => {
  const cwd = await temporaryDirectory(t);
  let aborted = false;
  const reason = new Error("abort during listener registration");
  const signal = {
    get aborted() { return aborted; },
    get reason() { return aborted ? reason : undefined; },
    addEventListener() { aborted = true; },
    removeEventListener() { /* test signal has no retained listeners */ },
  } as unknown as AbortSignal;

  const result = await new GitRunner(process.execPath, process.env, { terminateGraceMs: 20 }).run({
    cwd,
    args: ["-e", "setInterval(() => {}, 1_000)"],
    timeoutMs: 100,
    maxOutputBytes: 100,
  }, signal);

  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
});

test("GitRunner streams large stdout without retaining it in the terminal result", async (t) => {
  const cwd = await temporaryDirectory(t);
  const recordBytes = 1_024;
  const recordCount = 32 * 1_024;
  const program = [
    `const record = Buffer.alloc(${recordBytes}, 120);`,
    "record[record.length - 1] = 0;",
    `let remaining = ${recordCount};`,
    "function write() {",
    "  while (remaining > 0) {",
    "    remaining -= 1;",
    "    if (!process.stdout.write(record)) { process.stdout.once('drain', write); return; }",
    "  }",
    "}",
    "write();",
  ].join(" ");
  let bytes = 0;
  let records = 0;

  const result = await nodeRunner().runStreaming({
    cwd, args: ["-e", program], timeoutMs: 10_000, maxStderrBytes: 1_024,
  }, (chunk) => {
    bytes += chunk.length;
    for (const byte of chunk) if (byte === 0) records += 1;
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "");
  assert.equal(result.stdoutTruncated, false);
  assert.equal(bytes, recordBytes * recordCount);
  assert.equal(records, recordCount);
});

test("GitRunner terminates and rejects when a streaming stdout consumer fails", async (t) => {
  const cwd = await temporaryDirectory(t);
  const runner = new GitRunner(process.execPath, process.env, { terminateGraceMs: 20 });

  await assert.rejects(runner.runStreaming({
    cwd,
    args: ["-e", "process.stdout.write('record\\0'); setInterval(() => {}, 1000)"],
    timeoutMs: 10_000,
    maxStderrBytes: 1_024,
  }, () => { throw new Error("stream consumer rejected record"); }), /stream consumer rejected record/);
});

test("GitRunner finalizes a UTF-8 decoder when the byte cap ends mid-character", async (t) => {
  const cwd = await temporaryDirectory(t);
  const result = await nodeRunner().run({
    cwd, args: ["-e", "process.stdout.write('€')"], timeoutMs: 1_000, maxOutputBytes: 2,
  });

  assert.equal(result.stdout, "�");
  assert.equal(result.stdoutTruncated, true);
});

test("GitRunner returns a timed out result after terminating the process group", async (t) => {
  const cwd = await temporaryDirectory(t);
  const result = await nodeRunner().run({
    cwd, args: ["-e", "setInterval(() => {}, 1_000)"], timeoutMs: 20, maxOutputBytes: 100,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.notEqual(result.signal, null);
});

test("GitRunner contains a group-signal failure with direct child termination", async (t) => {
  const cwd = await temporaryDirectory(t);
  let groupSignalCalls = 0;
  const runner = new GitRunner(process.execPath, process.env, {
    signalProcessGroup: () => {
      groupSignalCalls += 1;
      throw Object.assign(new Error("group signalling denied"), { code: "EPERM" });
    },
  });
  const result = await runner.run({
    cwd, args: ["-e", "setInterval(() => {}, 1_000)"], timeoutMs: 20, maxOutputBytes: 100,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(groupSignalCalls, 1);
});

test("GitRunner escalates to SIGKILL after the grace period when SIGTERM is ignored", { skip: process.platform === "win32" }, async (t) => {
  const cwd = await temporaryDirectory(t);
  const runner = new GitRunner(process.execPath, process.env, { terminateGraceMs: 20 });
  const result = await runner.run({
    cwd,
    args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"],
    timeoutMs: 200,
    maxOutputBytes: 100,
  });

  assert.equal(result.timedOut, true);
  assert.equal(result.signal, "SIGKILL");
  assert.ok(result.durationMs < 1_000);
});

test("GitRunner returns an aborted result without spawning for an already-aborted signal", async (t) => {
  const cwd = await temporaryDirectory(t);
  const marker = join(cwd, "spawned");
  const controller = new AbortController();
  controller.abort();
  const result = await nodeRunner().run({
    cwd, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`], timeoutMs: 1_000, maxOutputBytes: 100,
  }, controller.signal);

  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.exitCode, null);
  await assert.rejects(access(marker, constants.F_OK));
});

test("GitRunner rejects ambiguous Unicode arguments before child spawn and accepts astral arguments", async (t) => {
  const cwd = await temporaryDirectory(t);
  for (const [index, value] of ["bad\uFFFD", "bad\uD800", "bad\uDC00"].entries()) {
    const marker = join(cwd, `ambiguous-${index}`);
    await assert.rejects(nodeRunner().run({
      cwd,
      args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`, value],
      timeoutMs: 1_000,
      maxOutputBytes: 100,
    }), /Unicode|well-formed/i);
    await assert.rejects(access(marker, constants.F_OK));
  }

  const astral = await nodeRunner().run({
    cwd,
    args: ["-e", "process.stdout.write(process.argv[1])", "😀"],
    timeoutMs: 1_000,
    maxOutputBytes: 100,
  });
  assert.equal(astral.exitCode, 0);
  assert.equal(astral.stdout, "😀");
});

test("GitRunner cancels an in-flight process", async (t) => {
  const cwd = await temporaryDirectory(t);
  const controller = new AbortController();
  const running = nodeRunner().run({
    cwd, args: ["-e", "setInterval(() => {}, 1_000)"], timeoutMs: 1_000, maxOutputBytes: 100,
  }, controller.signal);
  setTimeout(() => controller.abort(), 20);

  const result = await running;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.notEqual(result.signal, null);
});

test("GitRunner termination also removes a child process in its process group", async (t) => {
  const cwd = await temporaryDirectory(t);
  const ready = join(cwd, "child-pid");
  const childProgram = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    `require('node:fs').writeFileSync(${JSON.stringify(ready)}, String(child.pid));`,
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const controller = new AbortController();
  const running = nodeRunner().run({
    cwd, args: ["-e", childProgram], timeoutMs: 10_000, maxOutputBytes: 100,
  }, controller.signal);
  const childPid = Number(await waitForFileText(ready));
  controller.abort();
  const result = await running;

  assert.equal(result.aborted, true);
  assert.ok(Number.isInteger(childPid) && childPid > 0);
  await waitForProcessExit(childPid);
});

test("GitRunner keeps descendant SIGKILL escalation after the direct child exits", { skip: process.platform === "win32" }, async (t) => {
  const cwd = await temporaryDirectory(t);
  const ready = join(cwd, "descendant-ready");
  const descendantProgram = [
    "process.on('SIGTERM', () => {});",
    `require('node:fs').writeFileSync(${JSON.stringify(ready)}, 'ready');`,
    "setInterval(() => {}, 1000);",
  ].join(" ");
  const leaderProgram = [
    "const { existsSync } = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantProgram)}], { stdio: 'ignore' });`,
    `const ready = ${JSON.stringify(ready)};`,
    "const announce = setInterval(() => {",
    "  if (existsSync(ready)) { clearInterval(announce); process.stdout.write(String(child.pid)); }",
    "}, 1);",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  let descendantPid: number | undefined;
  t.after(() => {
    if (descendantPid === undefined) return;
    try { process.kill(descendantPid, "SIGKILL"); } catch { /* already reclaimed */ }
  });

  const result = await new GitRunner(process.execPath, process.env, { terminateGraceMs: 40 }).run({
    cwd, args: ["-e", leaderProgram], timeoutMs: 150, maxOutputBytes: 100,
  });
  descendantPid = Number(result.stdout);

  assert.equal(result.timedOut, true);
  assert.ok(Number.isInteger(descendantPid) && descendantPid > 0);
  await waitForProcessExit(descendantPid);
});

test("GitRunner stops signalling after process group death to guard against group-ID reuse", { skip: process.platform === "win32" }, async (t) => {
  const cwd = await temporaryDirectory(t);
  const signals: NodeJS.Signals[] = [];
  let probes = 0;
  const runner = new GitRunner(process.execPath, process.env, {
    terminateGraceMs: 100,
    signalProcessGroup: (pid, signal) => {
      signals.push(signal);
      process.kill(pid, signal);
      return true;
    },
    processGroupExists: () => {
      probes += 1;
      if (probes === 1) return true;
      if (probes === 2) return false;
      return true; // Simulated later reuse must never be observed or signalled.
    },
  });

  const result = await runner.run({
    cwd, args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 20, maxOutputBytes: 100,
  });

  assert.equal(result.timedOut, true);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(probes, 2);
});

test("GitRunner never group-signals again when the first termination probe is absent", { skip: process.platform === "win32" }, async (t) => {
  const cwd = await temporaryDirectory(t);
  const signals: NodeJS.Signals[] = [];
  let probes = 0;
  const runner = new GitRunner(process.execPath, process.env, {
    terminateGraceMs: 20,
    signalProcessGroup: (pid, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") process.kill(pid, signal);
      return true;
    },
    processGroupExists: () => { probes += 1; return false; },
  });

  const result = await runner.run({
    cwd, args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 20, maxOutputBytes: 100,
  });

  assert.equal(result.timedOut, true);
  assert.deepEqual(signals, ["SIGTERM"]);
  assert.equal(probes, 1);
});

test("GitRunner rejects within a bounded interval when a group survives SIGKILL", { skip: process.platform === "win32" }, async (t) => {
  const cwd = await temporaryDirectory(t);
  const signals: NodeJS.Signals[] = [];
  const surviveUntil = Date.now() + 250;
  let fallbackPid: number | undefined;
  let fallbackTimer: NodeJS.Timeout | undefined;
  const runner = new GitRunner(process.execPath, process.env, {
    terminateGraceMs: 20,
    signalProcessGroup: (pid, signal) => {
      signals.push(signal);
      fallbackPid = pid;
      if (signal === "SIGKILL") {
        fallbackTimer = setTimeout(() => { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }, 250);
      }
      return true;
    },
    processGroupExists: () => Date.now() < surviveUntil,
  });
  t.after(() => {
    if (fallbackTimer !== undefined) clearTimeout(fallbackTimer);
    if (fallbackPid === undefined) return;
    try { process.kill(fallbackPid, "SIGKILL"); } catch { /* already gone */ }
  });

  const started = Date.now();
  await assert.rejects(runner.run({
    cwd, args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 20, maxOutputBytes: 100,
  }), /SIGKILL|process group/i);

  assert.ok(Date.now() - started < 200);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});
