import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { ProvenMutationOutcome } from "../app/mutation-coordinator.js";
import { remainingDeadlineTimeoutMs, throwIfDeadlineExceeded, withReconciliationDeadline } from "../deadline.js";
import { isWellFormedGitText } from "../domain/git-text.js";
import type { BridgeResult, FetchData, PushData } from "../domain/result.js";
import { BridgeRejection } from "../domain/result.js";
import { OPERATION_TIMEOUT_MS } from "../product.js";
import { validateOriginRemoteRef, type FetchRecord } from "../state/records.js";
import type { SessionStore } from "../state/session-store.js";
import { assertMutationReady, canonicalBranchRef, inspectRepository, validateFullRef, type RepositorySnapshot } from "./repository.js";
import { readPushTrackedWorktreeSnapshotId, readStatusWithWorktreeContentProof } from "./read.js";
import { readHooksPath } from "./commit.js";
import { createPushHookAdapter } from "./hook-wrapper.js";
import type { GitCommandResult, GitRunner } from "./runner.js";
import {
  COMPLETE_RECORD_MAX_BYTES,
  DelimitedRecordParser,
  RETURNED_REF_SET_MAX_BYTES,
  RETURNED_REF_SET_MAX_COUNT,
  STREAM_STDERR_MAX_BYTES,
  utf8Bytes,
} from "./streaming.js";

export interface RemoteIdentity {
  readonly scheme: "https" | "ssh";
  readonly host: string;
  readonly pathHash: string;
}

export interface FetchRequest {
  readonly expectedBranch: string;
  readonly expectedHead: string;
}

/** Opaque, one-shot authority returned after all rejection-capable fetch reads. */
export interface PreparedFetch {
  readonly fetchId: string;
  readonly remoteIdentity: string;
}

export interface FetchPreflightObservation extends Readonly<Record<string, unknown>> {
  readonly fetch_id: string;
  readonly branch: string;
  readonly head: string;
  readonly index_tree: string;
  readonly remote_identity: string;
  readonly fetch_policy_hash: string;
  readonly refs_before: Readonly<Record<string, string>>;
}

export interface FetchPreparationOptions {
  readonly generateId?: () => string;
  readonly now?: () => string;
}

export interface PushRequest {
  readonly expectedBranch: string;
  readonly expectedHead: string;
  readonly expectedRemoteHead: string | null;
}

/** Opaque, one-shot authority returned after all rejection-capable push reads. */
export interface PreparedPush {
  readonly remoteIdentity: string;
}

/** Opaque, one-shot authority for one exact non-fast-forward origin update. */
export interface PreparedForcePush {
  readonly remoteIdentity: string;
}

export interface PushPreflightObservation extends Readonly<Record<string, unknown>> {
  readonly branch: string;
  readonly local_head: string;
  readonly index_tree: string;
  readonly tracked_worktree_snapshot_id: string;
  readonly remote_identity: string;
  readonly remote_head: string | null;
  readonly push_policy_hash: string;
}

export interface ForcePushPreflightObservation extends Readonly<Record<string, unknown>> {
  readonly branch: string;
  readonly local_head: string;
  readonly index_tree: string;
  readonly worktree_snapshot_id: string;
  readonly remote_identity: string;
  readonly remote_head: string | null;
  readonly push_policy_hash: string;
}

export interface PushExecutionOutcome {
  readonly data: PushData;
  readonly warnings: readonly string[];
}

interface PreparedState {
  readonly snapshot: RepositorySnapshot;
  readonly fetchId: string;
  readonly rawOrigin: string;
  readonly remote: RemoteIdentity;
  readonly refsBefore: Readonly<Record<string, string>>;
  readonly allRefsFingerprint: string;
  readonly outsideOriginFingerprint: string;
  readonly fetchArgs: readonly string[];
  readonly fetchPolicyHash: string;
  readonly now: () => string;
}

interface PreparedPushState {
  readonly snapshot: RepositorySnapshot;
  readonly branchRef: string;
  readonly worktreeProof: "tracked" | "complete";
  readonly worktreeSnapshotId: string;
  readonly worktreePaths?: readonly string[];
  readonly worktreeContentSnapshotId?: string;
  readonly remoteIdentity: string;
  readonly rawEndpoint: string;
  readonly hooksPath: string;
  readonly remoteHead: string | null;
  readonly pushPolicyHash: string;
}

const READ_OUTPUT_LIMIT = 32_768;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const ORIGIN_REFS_PREFIX = "refs/remotes/origin/";
const CONSTRAINED_FETCH_ARGS = Object.freeze([
  "-c", "remote.origin.tagOpt=--no-tags",
  "-c", "remote.origin.prune=false",
  "-c", "remote.origin.pruneTags=false",
  "-c", "fetch.prune=false",
  "-c", "fetch.pruneTags=false",
  "-c", "fetch.recurseSubmodules=false",
  "-c", "submodule.recurse=false",
  "-c", "fetch.writeCommitGraph=false",
  "-c", "maintenance.auto=false",
  "-c", "gc.auto=0",
  "-c", "core.logAllRefUpdates=false",
  "fetch", "--no-tags", "--no-prune", "--no-recurse-submodules",
  "--no-write-fetch-head", "--refmap=", "--upload-pack=git-upload-pack", "origin",
  "+refs/heads/*:refs/remotes/origin/*",
]);
const FETCH_REQUIRED_ABSENT_CONFIG = Object.freeze([
  "extensions.partialClone",
  "fetch.bundleURI",
  "remote.origin.followRemoteHEAD",
  "remote.origin.partialCloneFilter",
  "remote.origin.promisor",
  "remote.origin.proxy",
  "remote.origin.proxyAuthMethod",
  "remote.origin.serverOption",
  "remote.origin.vcs",
]);
const AUDITED_ORIGIN_CONFIG_KEYS = Object.freeze([
  "remote.origin.url",
  "remote.origin.pushurl",
  "remote.origin.fetch",
  "remote.origin.push",
  "remote.origin.mirror",
  "remote.origin.receivepack",
  "remote.origin.uploadpack",
  "remote.origin.vcs",
  "remote.origin.proxy",
  "remote.origin.proxyauthmethod",
  "remote.origin.serveroption",
  "remote.origin.promisor",
  "remote.origin.partialclonefilter",
  "remote.origin.tagopt",
  "remote.origin.skipdefaultupdate",
  "remote.origin.skipfetchall",
  "remote.origin.prune",
  "remote.origin.prunetags",
  "remote.origin.followremotehead",
]);
const AUDITED_ORIGIN_CONFIG = new Set(AUDITED_ORIGIN_CONFIG_KEYS);
const FETCH_POLICY_HASH = createHash("sha256")
  .update("git-mcp-server:fetch-policy:v2\0")
  .update(JSON.stringify({
    args: CONSTRAINED_FETCH_ARGS,
    auditedOriginConfig: AUDITED_ORIGIN_CONFIG_KEYS,
    requiredAbsentConfig: FETCH_REQUIRED_ABSENT_CONFIG,
  }))
  .digest("hex");
const preparedStates = new WeakMap<PreparedFetch, PreparedState>();
const preparedPushStates = new WeakMap<PreparedPush, PreparedPushState>();
const preparedForcePushStates = new WeakMap<PreparedForcePush, PreparedPushState>();

function remoteRejected(): never {
  throw new BridgeRejection({ code: "REMOTE_URL_REJECTED", message: "Origin remote URL is not allowed" });
}

interface RemoteSemantics {
  readonly scheme: "https" | "ssh";
  readonly syntax: "https-url" | "ssh-url" | "scp-like";
  readonly host: string;
  readonly usernameDiscriminator: string;
  readonly pathMode: "absolute" | "relative";
  readonly commandPath: string;
  readonly port: string;
}

function normalizedCommandPath(rawPath: string): { commandPath: string; pathMode: "absolute" | "relative" } {
  if (rawPath.length === 0 || rawPath.length > 4096 || rawPath.includes("%") || rawPath.includes("\\")
    || rawPath.includes(":") || rawPath.includes("?") || rawPath.includes("#") || rawPath.includes("//")) {
    remoteRejected();
  }
  const pathMode = rawPath.startsWith("/") ? "absolute" : "relative";
  const path = pathMode === "absolute" ? rawPath.slice(1) : rawPath;
  const parts = path.split("/");
  if (path.length === 0 || parts.some((part) => part.length === 0 || part === "." || part === "..")) remoteRejected();
  return { commandPath: rawPath, pathMode };
}

function normalizedHost(hostname: string, port = ""): string {
  const host = hostname.toLowerCase();
  if (host.length === 0 || host.length > 253 || /[\s/@%]/u.test(host)) remoteRejected();
  if (host.startsWith("[") || host.endsWith("]")) {
    if (!(host.startsWith("[") && host.endsWith("]")) || isIP(host.slice(1, -1)) !== 6) remoteRejected();
  } else if (isIP(host) === 0) {
    const labels = host.split(".");
    if (labels.some((label) => label.length === 0 || label.length > 63
      || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) remoteRejected();
  }
  if (port !== "" && (!/^[0-9]+$/.test(port) || Number(port) < 1 || Number(port) > 65_535)) remoteRejected();
  return port === "" ? host : `${host}:${port}`;
}

function validStoredHost(host: string): boolean {
  try {
    const parsed = new URL(`ssh://${host}/repository`);
    return parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === ""
      && normalizedHost(parsed.hostname, parsed.port) === host;
  } catch {
    return false;
  }
}

function usernameDiscriminator(username: string): string {
  return createHash("sha256").update("remote-username-v1\0").update(username === "" ? "<none>" : username).digest("hex");
}

function identity(semantics: RemoteSemantics): RemoteIdentity {
  const tuple = [
    "remote-identity-v2", semantics.scheme, semantics.syntax, semantics.host,
    semantics.usernameDiscriminator, semantics.pathMode, semantics.commandPath, semantics.port,
  ].join("\0");
  return Object.freeze({
    scheme: semantics.scheme,
    host: semantics.host,
    pathHash: createHash("sha256").update(tuple).digest("hex"),
  });
}

function splitUrlRemote(raw: string, prefix: "https://" | "ssh://"): { authority: string; path: string } {
  const remainder = raw.slice(prefix.length);
  const slash = remainder.indexOf("/");
  if (slash <= 0) remoteRejected();
  return { authority: remainder.slice(0, slash), path: remainder.slice(slash) };
}

function urlHost(
  scheme: "https" | "ssh",
  authority: string,
  path: string,
  expectedUsername: string,
): { host: string; port: string } {
  if (authority.length === 0 || authority.endsWith(":")) remoteRejected();
  let url: URL;
  try { url = new URL(`${scheme}://${authority}${path}`); } catch { remoteRejected(); }
  if (url.protocol !== `${scheme}:` || url.username !== expectedUsername || url.password !== ""
    || url.search !== "" || url.hash !== "" || url.pathname !== path) remoteRejected();
  return { host: normalizedHost(url.hostname, url.port), port: url.port };
}

/**
 * Accepts HTTPS, ssh://, and user@host:path. Raw delimiters are rejected before
 * WHATWG parsing. SCP-like IPv6 remains intentionally unsupported.
 */
export function parseAllowedRemote(raw: string): RemoteIdentity {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 8192
    || !isWellFormedGitText(raw) || /[\x00-\x20\x7f\s]/u.test(raw) || /[?#\\%]/.test(raw)) remoteRejected();

  if (raw.startsWith("https://")) {
    if (raw.includes("@")) remoteRejected();
    const { authority, path } = splitUrlRemote(raw, "https://");
    const normalizedPath = normalizedCommandPath(path);
    if (normalizedPath.pathMode !== "absolute") remoteRejected();
    const parsedHost = urlHost("https", authority, path, "");
    return identity({
      scheme: "https", syntax: "https-url", host: parsedHost.host,
      usernameDiscriminator: usernameDiscriminator(""), ...normalizedPath, port: parsedHost.port,
    });
  }

  if (raw.startsWith("ssh://")) {
    const { authority, path } = splitUrlRemote(raw, "ssh://");
    const at = authority.indexOf("@");
    if (at !== authority.lastIndexOf("@")) remoteRejected();
    const username = at === -1 ? "" : authority.slice(0, at);
    const hostAuthority = at === -1 ? authority : authority.slice(at + 1);
    if (at !== -1 && (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(username) || username.startsWith("-"))) remoteRejected();
    if (hostAuthority.length === 0) remoteRejected();
    const normalizedPath = normalizedCommandPath(path);
    if (normalizedPath.pathMode !== "absolute") remoteRejected();
    const parsedHost = urlHost("ssh", authority, path, username);
    return identity({
      scheme: "ssh", syntax: "ssh-url", host: parsedHost.host,
      usernameDiscriminator: usernameDiscriminator(username), ...normalizedPath, port: parsedHost.port,
    });
  }

  const match = /^([A-Za-z0-9][A-Za-z0-9._-]{0,127})@([^@/:]+):([^:]+)$/.exec(raw);
  if (match === null) remoteRejected();
  const username = match[1];
  const host = match[2];
  const path = match[3];
  if (username === undefined || host === undefined || path === undefined || username.startsWith("-")) remoteRejected();
  const normalizedPath = normalizedCommandPath(path);
  return identity({
    scheme: "ssh", syntax: "scp-like", host: normalizedHost(host),
    usernameDiscriminator: usernameDiscriminator(username), ...normalizedPath, port: "",
  });
}

/** Deterministic wire identity containing only already-sanitized components. */
export function remoteIdentityString(remote: RemoteIdentity): string {
  if ((remote.scheme !== "https" && remote.scheme !== "ssh") || !validStoredHost(remote.host)
    || !/^[0-9a-f]{64}$/.test(remote.pathHash)) remoteRejected();
  return `${remote.scheme}://${remote.host}/${remote.pathHash}`;
}

function completeRead(result: GitCommandResult): boolean {
  return result.exitCode === 0 && result.signal === null && !result.timedOut && !result.aborted
    && !result.stdoutTruncated && !result.stderrTruncated && result.stderr === "" && !result.stdout.includes("�");
}

async function readOrigin(runner: GitRunner, root: string, signal?: AbortSignal): Promise<string> {
  const command = await runner.run({
    cwd: root, args: ["remote", "get-url", "origin"], timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read),
    maxOutputBytes: READ_OUTPUT_LIMIT,
  }, signal);
  if (!completeRead(command)) throw new BridgeRejection({
    code: "REMOTE_URL_REJECTED", message: "Origin remote URL could not be validated",
  });
  const raw = command.stdout.endsWith("\n") ? command.stdout.slice(0, -1) : command.stdout;
  if (raw.length === 0 || raw.includes("\n") || raw.includes("\r")) remoteRejected();
  parseAllowedRemote(raw);
  return raw;
}

/** Re-reads origin and exposes only the safe identity used by durable fetch records. */
export async function readOriginIdentity(
  runner: GitRunner,
  root: string,
  signal?: AbortSignal,
): Promise<RemoteIdentity> {
  return parseAllowedRemote(await readOrigin(runner, root, signal));
}

interface RefProof {
  readonly allFingerprint: string;
  readonly outsideOriginFingerprint: string;
  readonly originRefs: Readonly<Record<string, string>>;
}

async function readRefProof(
  runner: GitRunner,
  root: string,
  scope: "all" | "origin",
  signal?: AbortSignal,
): Promise<RefProof> {
  const label = scope === "all" ? "all refs" : "origin refs";
  const args = [
    "for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)",
    ...(scope === "origin" ? ["refs/remotes/origin"] : []),
  ];
  const allHash = createHash("sha256").update("git-mcp-server:all-refs:v1\0");
  const outsideHash = createHash("sha256").update("git-mcp-server:outside-origin-refs:v1\0");
  const origin: Record<string, string> = {};
  let originCount = 0;
  let originBytes = 0;
  let previousRef: Buffer | undefined;
  const parseFailure = (): never => { throw new Error(`Unable to parse ${label}`); };
  const parser = new DelimitedRecordParser(10, COMPLETE_RECORD_MAX_BYTES, `Git ${label}`, (line) => {
    throwIfDeadlineExceeded(signal);
    const nul = line.indexOf("\0");
    if (nul <= 0 || nul !== line.lastIndexOf("\0") || line.includes("�")) parseFailure();
    const ref = line.slice(0, nul);
    const object = line.slice(nul + 1);
    try { validateFullRef(ref); } catch { parseFailure(); }
    if (!OBJECT_ID.test(object)) parseFailure();
    const refBytes = Buffer.from(ref);
    if (previousRef !== undefined && Buffer.compare(previousRef, refBytes) >= 0) parseFailure();
    previousRef = refBytes;
    allHash.update(ref).update("\0").update(object).update("\0");
    if (ref.startsWith(ORIGIN_REFS_PREFIX)) {
      try { validateOriginRemoteRef(ref); } catch { parseFailure(); }
      const nextBytes = originBytes + utf8Bytes(ref) + utf8Bytes(object);
      if (originCount + 1 > RETURNED_REF_SET_MAX_COUNT || nextBytes > RETURNED_REF_SET_MAX_BYTES) {
        throw new BridgeRejection({
          code: "UNSUPPORTED_REPOSITORY_STATE",
          message: "Origin ref result exceeds its explicit returned-set limit",
        });
      }
      origin[ref] = object;
      originCount += 1;
      originBytes = nextBytes;
    } else {
      if (scope === "origin") parseFailure();
      outsideHash.update(ref).update("\0").update(object).update("\0");
    }
  });
  const command = await runner.runStreaming({
    cwd: root, args, timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read),
    maxStderrBytes: STREAM_STDERR_MAX_BYTES,
  }, (chunk) => parser.write(chunk), signal);
  if (!completeRead(command)) throw new Error(`Unable to read complete ${label}`);
  try { parser.finish(); } catch { throw new Error(`Unable to read complete ${label}`); }
  return Object.freeze({
    allFingerprint: allHash.digest("hex"),
    outsideOriginFingerprint: outsideHash.digest("hex"),
    originRefs: Object.freeze(origin),
  });
}

async function readFetchPolicyHash(
  runner: GitRunner,
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  await readAuditedOriginConfig(runner, root, signal);
  for (const key of FETCH_REQUIRED_ABSENT_CONFIG) {
    throwIfDeadlineExceeded(signal);
    const values = await readConfigValues(runner, root, ["config", "--get-all", key], signal);
    if (values.length !== 0) remoteRejected();
  }
  return FETCH_POLICY_HASH;
}

/** Reads only origin's remote-tracking namespace and fails closed on any ambiguous output. */
export async function listOriginRefs(
  runner: GitRunner,
  root: string,
  signal?: AbortSignal,
): Promise<Readonly<Record<string, string>>> {
  return (await readRefProof(runner, root, "origin", signal)).originRefs;
}

function assertIdentity(expected: RepositorySnapshot, actual: RepositorySnapshot): void {
  if (actual.repositoryId !== expected.repositoryId || actual.root !== expected.root || actual.gitDir !== expected.gitDir
    || actual.commonGitDir !== expected.commonGitDir) {
    throw new BridgeRejection({
      code: "UNSUPPORTED_REPOSITORY_STATE", message: "Repository identity changed while preparing fetch",
    });
  }
}

function sameLocalState(before: RepositorySnapshot, after: RepositorySnapshot): boolean {
  return before.repositoryId === after.repositoryId && before.root === after.root && before.gitDir === after.gitDir
    && before.commonGitDir === after.commonGitDir && before.branch === after.branch && before.branchRef === after.branchRef && before.head === after.head
    && before.headTree === after.headTree && before.indexTree === after.indexTree && before.operationState === after.operationState;
}

function proven<T>(result: BridgeResult<T>): never {
  throw new ProvenMutationOutcome<T>(result);
}

function indeterminate(): never {
  proven({
    status: "indeterminate", operation: "git_fetch", warnings: [],
    error: { code: "OPERATION_INDETERMINATE", message: "Fetch started but its final state could not be confirmed" },
  });
}

async function availableFetchId(sessions: SessionStore, generateId: () => string): Promise<string> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = generateId();
    if (await sessions.getFetch(candidate) === null) return candidate;
  }
  throw new Error("Unable to allocate a unique fetch ID");
}

/** Performs every rejection-capable repository, remote, ref, and ID check before mutationStarted. */
export async function prepareFetchOrigin(
  runner: GitRunner,
  sessions: SessionStore,
  snapshot: RepositorySnapshot,
  input: FetchRequest,
  signal?: AbortSignal,
  options: FetchPreparationOptions = {},
): Promise<PreparedFetch> {
  const before = await inspectRepository(runner, snapshot.root, signal);
  assertIdentity(snapshot, before);
  assertMutationReady(before, input.expectedBranch, input.expectedHead);
  const rawOrigin = await readOrigin(runner, before.root, signal);
  const remote = parseAllowedRemote(rawOrigin);
  const fetchPolicyHash = await readFetchPolicyHash(runner, before.root, signal);
  const refsProofBefore = await readRefProof(runner, before.root, "all", signal);
  const refsBefore = refsProofBefore.originRefs;

  const finalBefore = await inspectRepository(runner, before.root, signal);
  assertIdentity(before, finalBefore);
  assertMutationReady(finalBefore, input.expectedBranch, input.expectedHead);
  if (finalBefore.indexTree !== before.indexTree || finalBefore.headTree !== before.headTree) {
    throw new BridgeRejection({ code: "INDEX_MISMATCH", message: "Repository index changed while preparing fetch" });
  }
  const finalOrigin = await readOrigin(runner, finalBefore.root, signal);
  const finalFetchPolicyHash = await readFetchPolicyHash(runner, finalBefore.root, signal);
  const finalRefsProof = await readRefProof(runner, finalBefore.root, "all", signal);
  if (finalOrigin !== rawOrigin) remoteRejected();
  if (finalFetchPolicyHash !== fetchPolicyHash) remoteRejected();
  if (finalRefsProof.allFingerprint !== refsProofBefore.allFingerprint) throw new BridgeRejection({
    code: "UNSUPPORTED_REPOSITORY_STATE", message: "Repository refs changed while preparing fetch",
  });
  const fetchId = await availableFetchId(sessions, options.generateId ?? randomUUID);
  const prepared = Object.freeze({ fetchId, remoteIdentity: remoteIdentityString(remote) });
  preparedStates.set(prepared, {
    snapshot: Object.freeze({ ...finalBefore }), fetchId, rawOrigin, remote,
    refsBefore: Object.freeze({ ...refsBefore }),
    allRefsFingerprint: finalRefsProof.allFingerprint,
    outsideOriginFingerprint: finalRefsProof.outsideOriginFingerprint,
    fetchArgs: CONSTRAINED_FETCH_ARGS, fetchPolicyHash: finalFetchPolicyHash,
    now: options.now ?? (() => new Date().toISOString()),
  });
  return prepared;
}

/** Safe durable observation for the Task 14 coordinator adapter. */
export function preparedFetchObservation(prepared: PreparedFetch): FetchPreflightObservation {
  const state = preparedStates.get(prepared);
  if (state === undefined) throw new BridgeRejection({
    code: "INVALID_INPUT", message: "Prepared fetch authority is invalid or already consumed",
  });
  return Object.freeze({
    fetch_id: state.fetchId, branch: state.snapshot.branch!, head: state.snapshot.head,
    index_tree: state.snapshot.indexTree, remote_identity: remoteIdentityString(state.remote),
    fetch_policy_hash: state.fetchPolicyHash,
    refs_before: state.refsBefore,
  });
}

function failedCode(command: GitCommandResult | undefined): "GIT_TIMEOUT" | "OUTPUT_TRUNCATED" | "GIT_FAILED" {
  if (command?.timedOut) return "GIT_TIMEOUT";
  if (command?.stdoutTruncated || command?.stderrTruncated) return "OUTPUT_TRUNCATED";
  return "GIT_FAILED";
}

function failedMessage(code: ReturnType<typeof failedCode>): string {
  if (code === "GIT_TIMEOUT") return "Git fetch timed out without changing origin refs";
  if (code === "OUTPUT_TRUNCATED") return "Git fetch output was truncated without changing origin refs";
  return "Git fetch failed without changing origin refs";
}

/** Executes exactly one fetch, proves local/remote-tracking state, and publishes one immutable record. */
export async function executePreparedFetch(
  runner: GitRunner,
  sessions: SessionStore,
  prepared: PreparedFetch,
  signal?: AbortSignal,
): Promise<FetchData> {
  const state = preparedStates.get(prepared);
  if (state === undefined) throw new BridgeRejection({
    code: "INVALID_INPUT", message: "Prepared fetch authority is invalid or already consumed",
  });
  preparedStates.delete(prepared);

  let command: GitCommandResult | undefined;
  try {
    command = await runner.run({
      cwd: state.snapshot.root, args: state.fetchArgs,
      timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.remote),
      maxOutputBytes: READ_OUTPUT_LIMIT,
    }, signal);
  } catch {
    command = undefined;
  }

  return withReconciliationDeadline(async () => {
  // These proofs intentionally ignore the caller's canceled signal after the mutation began.
  let after: RepositorySnapshot | undefined;
  let refsProofAfter: RefProof | undefined;
  let finalOrigin: string | undefined;
  try { after = await inspectRepository(runner, state.snapshot.root); } catch { /* classified below */ }
  try { refsProofAfter = await readRefProof(runner, state.snapshot.root, "all"); } catch { /* classified below */ }
  try { finalOrigin = await readOrigin(runner, state.snapshot.root); } catch { /* classified below */ }
  if (after === undefined || refsProofAfter === undefined || finalOrigin === undefined
    || !sameLocalState(state.snapshot, after) || finalOrigin !== state.rawOrigin) indeterminate();
  const refsAfter = refsProofAfter.originRefs;

  const commandSucceeded = command !== undefined && command.exitCode === 0 && command.signal === null
    && !command.timedOut && !command.aborted && !command.stdoutTruncated && !command.stderrTruncated;
  if (!commandSucceeded) {
    if (state.allRefsFingerprint !== refsProofAfter.allFingerprint) indeterminate();
    const code = failedCode(command);
    proven({ status: "failed", operation: "git_fetch", warnings: [], error: { code, message: failedMessage(code) } });
  }
  if (state.outsideOriginFingerprint !== refsProofAfter.outsideOriginFingerprint) indeterminate();

  const fetchedAt = state.now();
  const record: FetchRecord = {
    kind: "fetch", fetchId: state.fetchId, repositoryId: after.repositoryId, branch: after.branch!, head: after.head,
    remoteIdentity: state.remote, refsBefore: state.refsBefore, refsAfter, fetchedAt,
  };
  try { await sessions.createFetch(record); } catch { indeterminate(); }
  return {
    fetch_id: record.fetchId, refs_before: { ...record.refsBefore }, refs_after: { ...record.refsAfter },
    remote_identity: remoteIdentityString(state.remote), fetched_at: record.fetchedAt,
  };
  });
}

/** Convenience wrapper; Task 14 must wire prepare and execute on opposite sides of mutationStarted. */
export async function fetchOrigin(
  runner: GitRunner,
  sessions: SessionStore,
  snapshot: RepositorySnapshot,
  input: FetchRequest,
  signal?: AbortSignal,
  options: FetchPreparationOptions = {},
): Promise<FetchData> {
  const prepared = await prepareFetchOrigin(runner, sessions, snapshot, input, signal, options);
  return executePreparedFetch(runner, sessions, prepared, signal);
}

function pushRejected(
  code: "INVALID_INPUT" | "UNSUPPORTED_REPOSITORY_STATE" | "INDEX_MISMATCH" | "REMOTE_HEAD_MISMATCH",
  message: string,
): never {
  throw new BridgeRejection({ code, message });
}

function pushBranchRef(branch: string): string {
  try {
    return canonicalBranchRef(branch);
  } catch {
    pushRejected("INVALID_INPUT", "Push branch name is invalid");
  }
}

function pushReadFailed(): never {
  throw new Error("Unable to read the complete remote branch head");
}

/** Reads only one exact branch from fixed remote origin and exposes no remote diagnostics. */
export async function readRemoteBranchHead(
  runner: GitRunner,
  repository: string | Pick<RepositorySnapshot, "root">,
  branch: string,
  signal?: AbortSignal,
): Promise<string | null> {
  return readRemoteBranchHeadFrom(runner, repository, branch, "origin", signal);
}

async function readRemoteBranchHeadFrom(
  runner: GitRunner,
  repository: string | Pick<RepositorySnapshot, "root">,
  branch: string,
  endpoint: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const ref = pushBranchRef(branch);
  const root = typeof repository === "string" ? repository : repository.root;
  let command: GitCommandResult;
  try {
    command = await runner.run({
      cwd: root,
      args: ["ls-remote", "--heads", endpoint, ref],
      timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read),
      maxOutputBytes: READ_OUTPUT_LIMIT,
    }, signal);
  } catch {
    pushReadFailed();
  }
  if (!completeRead(command)) pushReadFailed();
  if (command.stdout === "") return null;
  if (!command.stdout.endsWith("\n") || command.stdout.includes("\r") || command.stdout.includes("�")) pushReadFailed();
  const lines = command.stdout.slice(0, -1).split("\n");
  if (lines.length !== 1) pushReadFailed();
  const line = lines[0]!;
  const tab = line.indexOf("\t");
  if (tab <= 0 || tab !== line.lastIndexOf("\t") || line.slice(tab + 1) !== ref) pushReadFailed();
  const object = line.slice(0, tab);
  if (!OBJECT_ID.test(object)) pushReadFailed();
  return object;
}

function assertPushIdentity(expected: RepositorySnapshot, actual: RepositorySnapshot): void {
  if (actual.repositoryId !== expected.repositoryId || actual.root !== expected.root
    || actual.gitDir !== expected.gitDir || actual.commonGitDir !== expected.commonGitDir) {
    pushRejected("UNSUPPORTED_REPOSITORY_STATE", "Repository identity changed while preparing push");
  }
}

function assertPushRequest(input: PushRequest): void {
  pushBranchRef(input.expectedBranch);
  if (!OBJECT_ID.test(input.expectedHead)
    || (input.expectedRemoteHead !== null && !OBJECT_ID.test(input.expectedRemoteHead))) {
    pushRejected("INVALID_INPUT", "Push object ID is invalid");
  }
}

interface PushPolicyProof {
  readonly remote: RemoteIdentity;
  readonly rawEndpoint: string;
  readonly hash: string;
}

const PUSH_BOOLEAN_CONFIG = [
  "push.followTags",
  "submodule.recurse",
  "remote.origin.mirror",
  "push.gpgSign",
] as const;
const PUSH_ABSENT_CONFIG = [
  "push.pushOption",
  "remote.origin.receivepack",
  "remote.origin.uploadpack",
  "remote.origin.push",
  "remote.origin.vcs",
  "remote.origin.proxy",
  "remote.origin.proxyAuthMethod",
  "remote.origin.serverOption",
  "remote.origin.promisor",
  "remote.origin.partialCloneFilter",
] as const;
function pushPolicyRejected(): never {
  remoteRejected();
}

async function readConfigValues(
  runner: GitRunner,
  root: string,
  args: readonly string[],
  signal?: AbortSignal,
): Promise<readonly string[]> {
  let command: GitCommandResult;
  try {
    command = await runner.run({
      cwd: root, args, timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read), maxOutputBytes: READ_OUTPUT_LIMIT,
    }, signal);
  } catch {
    pushPolicyRejected();
  }
  if (command.exitCode === 1 && command.signal === null && !command.timedOut && !command.aborted
    && !command.stdoutTruncated && !command.stderrTruncated && command.stdout === "" && command.stderr === "") return [];
  if (!completeRead(command) || command.stdout === "" || !command.stdout.endsWith("\n")
    || command.stdout.includes("\r") || command.stdout.includes("�")) pushPolicyRejected();
  return command.stdout.slice(0, -1).split("\n");
}

async function readEffectivePushRemote(
  runner: GitRunner,
  root: string,
  signal?: AbortSignal,
): Promise<{ readonly rawEndpoint: string; readonly remote: RemoteIdentity }> {
  const args = ["remote", "get-url", "--push", "--all", "origin"];
  const values = await readConfigValues(runner, root, args, signal);
  if (values.length !== 1 || values[0] === "") pushPolicyRejected();
  try {
    return Object.freeze({ rawEndpoint: values[0]!, remote: parseAllowedRemote(values[0]!) });
  } catch {
    pushPolicyRejected();
  }
}

async function readAuditedOriginConfig(
  runner: GitRunner,
  root: string,
  signal?: AbortSignal,
): Promise<readonly string[]> {
  const values = await readConfigValues(
    runner,
    root,
    ["config", "--name-only", "--get-regexp", "^remote\\.origin\\."],
    signal,
  );
  const keys = [...new Set(values.map((value) => value.toLowerCase()))].sort();
  if (keys.some((key) => !AUDITED_ORIGIN_CONFIG.has(key))) pushPolicyRejected();
  return keys;
}

/**
 * Hashes only sanitized policy facts. Each queried key can expand the fixed
 * push's refs, destinations, transport helper, options, submodules, or signing.
 */
async function readPushPolicy(
  runner: GitRunner,
  root: string,
  signal?: AbortSignal,
): Promise<PushPolicyProof> {
  const origin = await readPushOriginIdentity(runner, root, signal);
  const effective = await readEffectivePushRemote(runner, root, signal);
  const remote = effective.remote;
  if (!sameRemoteIdentity(origin, remote)) pushPolicyRejected();

  const remoteKeys = await readAuditedOriginConfig(runner, root, signal);
  const facts: Record<string, string> = { endpoint: remoteIdentityString(remote), remote_keys: remoteKeys.join("\0") };
  for (const key of PUSH_BOOLEAN_CONFIG) {
    throwIfDeadlineExceeded(signal);
    const values = await readConfigValues(runner, root, ["config", "--type=bool", "--get-all", key], signal);
    if (values.length > 1 || (values.length === 1 && values[0] !== "false")) pushPolicyRejected();
    facts[key] = values.length === 0 ? "absent" : "false";
  }
  const recurse = await readConfigValues(runner, root, ["config", "--get-all", "push.recurseSubmodules"], signal);
  if (recurse.length > 1 || (recurse.length === 1 && recurse[0] !== "no")) pushPolicyRejected();
  facts["push.recurseSubmodules"] = recurse.length === 0 ? "absent" : "no";
  for (const key of PUSH_ABSENT_CONFIG) {
    throwIfDeadlineExceeded(signal);
    const values = await readConfigValues(runner, root, ["config", "--get-all", key], signal);
    if (values.length !== 0) pushPolicyRejected();
    facts[key] = "absent";
  }
  return {
    remote,
    rawEndpoint: effective.rawEndpoint,
    hash: createHash("sha256").update("push-policy-v1\0").update(JSON.stringify(facts)).digest("hex"),
  };
}

function sameRemoteIdentity(left: RemoteIdentity, right: RemoteIdentity): boolean {
  return left.scheme === right.scheme && left.host === right.host && left.pathHash === right.pathHash;
}

async function readPushOriginIdentity(runner: GitRunner, root: string, signal?: AbortSignal): Promise<RemoteIdentity> {
  try {
    return await readOriginIdentity(runner, root, signal);
  } catch (error) {
    if (error instanceof BridgeRejection) throw error;
    remoteRejected();
  }
}

function assertExpectedRemoteHead(expected: string | null, actual: string | null): void {
  if (actual !== expected) {
    pushRejected("REMOTE_HEAD_MISMATCH", "Origin branch does not match the expected remote head");
  }
}

async function assertRemoteHeadIsAncestor(
  runner: GitRunner,
  root: string,
  remoteHead: string | null,
  localHead: string,
  signal?: AbortSignal,
): Promise<void> {
  if (remoteHead === null) return;
  const result = await runner.run({
    cwd: root,
    args: ["--no-replace-objects", "merge-base", "--is-ancestor", remoteHead, localHead],
    timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.read),
    maxOutputBytes: READ_OUTPUT_LIMIT,
  }, signal);
  if (result.signal !== null || result.timedOut || result.aborted
    || result.stdoutTruncated || result.stderrTruncated || result.stdout !== "" || result.stderr !== ""
    || (result.exitCode !== 0 && result.exitCode !== 1)) {
    pushRejected("REMOTE_HEAD_MISMATCH", "Origin branch ancestry could not be proven");
  }
  if (result.exitCode === 1) {
    pushRejected("REMOTE_HEAD_MISMATCH", "Origin branch is not an ancestor of local HEAD");
  }
}

/**
 * Performs every rejection-capable push check before mutationStarted. A dirty
 * worktree is allowed, but its exact content-derived snapshot must remain unchanged.
 */
export async function preparePushOrigin(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  input: PushRequest,
  signal?: AbortSignal,
): Promise<PreparedPush> {
  assertPushRequest(input);
  if (snapshot.branch !== null && snapshot.branchRef !== pushBranchRef(snapshot.branch)) {
    pushRejected("INVALID_INPUT", "Push branch ref is invalid");
  }
  const before = await inspectRepository(runner, snapshot.root, signal);
  assertPushIdentity(snapshot, before);
  assertMutationReady(before, input.expectedBranch, input.expectedHead);
  const canonicalRef = pushBranchRef(before.branch!);
  if (before.branchRef !== canonicalRef) pushRejected("INVALID_INPUT", "Push branch ref is invalid");
  const trackedSnapshotId = await readPushTrackedWorktreeSnapshotId(runner, before, signal);
  const hooksPath = await readHooksPath(runner, before.root, signal);
  const policy = await readPushPolicy(runner, before.root, signal);
  const remoteHead = await readRemoteBranchHead(runner, before, before.branch!, signal);
  assertExpectedRemoteHead(input.expectedRemoteHead, remoteHead);
  await assertRemoteHeadIsAncestor(runner, before.root, remoteHead, before.head, signal);

  const finalBefore = await inspectRepository(runner, before.root, signal);
  assertPushIdentity(before, finalBefore);
  assertMutationReady(finalBefore, input.expectedBranch, input.expectedHead);
  if (!sameLocalState(before, finalBefore)) {
    pushRejected("INDEX_MISMATCH", "Local repository state changed while preparing push");
  }
  const finalTrackedSnapshotId = await readPushTrackedWorktreeSnapshotId(runner, finalBefore, signal);
  if (finalTrackedSnapshotId !== trackedSnapshotId) {
    pushRejected("INDEX_MISMATCH", "Local repository state changed while preparing push");
  }
  const finalHooksPath = await readHooksPath(runner, finalBefore.root, signal);
  if (finalHooksPath !== hooksPath) pushPolicyRejected();
  const finalPolicy = await readPushPolicy(runner, finalBefore.root, signal);
  if (finalPolicy.hash !== policy.hash || finalPolicy.rawEndpoint !== policy.rawEndpoint
    || !sameRemoteIdentity(finalPolicy.remote, policy.remote)) pushPolicyRejected();
  const finalRemoteHead = await readRemoteBranchHead(runner, finalBefore, finalBefore.branch!, signal);
  assertExpectedRemoteHead(input.expectedRemoteHead, finalRemoteHead);
  await assertRemoteHeadIsAncestor(runner, finalBefore.root, finalRemoteHead, finalBefore.head, signal);

  const remoteIdentity = remoteIdentityString(finalPolicy.remote);
  const prepared = Object.freeze({ remoteIdentity });
  preparedPushStates.set(prepared, {
    snapshot: Object.freeze({ ...finalBefore }),
    branchRef: canonicalRef,
    worktreeProof: "tracked",
    worktreeSnapshotId: finalTrackedSnapshotId,
    remoteIdentity,
    rawEndpoint: finalPolicy.rawEndpoint,
    hooksPath: finalHooksPath,
    remoteHead: finalRemoteHead,
    pushPolicyHash: finalPolicy.hash,
  });
  return prepared;
}

/** Safe durable observation for the Task 14 coordinator preflight adapter. */
export function preparedPushObservation(prepared: PreparedPush): PushPreflightObservation {
  const state = preparedPushStates.get(prepared);
  if (state === undefined) pushRejected("INVALID_INPUT", "Prepared push authority is invalid or already consumed");
  return Object.freeze({
    branch: state.snapshot.branch!,
    local_head: state.snapshot.head,
    index_tree: state.snapshot.indexTree,
    tracked_worktree_snapshot_id: state.worktreeSnapshotId,
    remote_identity: state.remoteIdentity,
    remote_head: state.remoteHead,
    push_policy_hash: state.pushPolicyHash,
  });
}

/**
 * Prepares one exact same-name origin update. It intentionally omits only the
 * fast-forward ancestry proof used by preparePushOrigin.
 */
export async function prepareForcePushOrigin(
  runner: GitRunner,
  sessions: SessionStore,
  snapshot: RepositorySnapshot,
  input: PushRequest,
  signal?: AbortSignal,
): Promise<PreparedForcePush> {
  assertPushRequest(input);
  if (snapshot.branch !== null && snapshot.branchRef !== pushBranchRef(snapshot.branch)) {
    pushRejected("INVALID_INPUT", "Push branch ref is invalid");
  }
  const before = await inspectRepository(runner, snapshot.root, signal);
  assertPushIdentity(snapshot, before);
  assertMutationReady(before, input.expectedBranch, input.expectedHead);
  await sessions.assertNoActiveSession(before.repositoryId);
  const canonicalRef = pushBranchRef(before.branch!);
  if (before.branchRef !== canonicalRef) pushRejected("INVALID_INPUT", "Push branch ref is invalid");
  const worktree = await readStatusWithWorktreeContentProof(runner, before, [], signal);
  const hooksPath = await readHooksPath(runner, before.root, signal);
  const policy = await readPushPolicy(runner, before.root, signal);
  const remoteHead = await readRemoteBranchHead(runner, before, before.branch!, signal);
  assertExpectedRemoteHead(input.expectedRemoteHead, remoteHead);

  const finalBefore = await inspectRepository(runner, before.root, signal);
  assertPushIdentity(before, finalBefore);
  assertMutationReady(finalBefore, input.expectedBranch, input.expectedHead);
  await sessions.assertNoActiveSession(finalBefore.repositoryId);
  if (!sameLocalState(before, finalBefore)) {
    pushRejected("INDEX_MISMATCH", "Local repository state changed while preparing push");
  }
  const finalWorktree = await readStatusWithWorktreeContentProof(
    runner,
    finalBefore,
    worktree.contentProof.paths,
    signal,
  );
  if (finalWorktree.status.worktree_snapshot_id !== worktree.status.worktree_snapshot_id
    || finalWorktree.contentProof.snapshotId !== worktree.contentProof.snapshotId
    || finalWorktree.contentProof.paths.join("\0") !== worktree.contentProof.paths.join("\0")) {
    pushRejected("INDEX_MISMATCH", "Local repository state changed while preparing push");
  }
  const finalHooksPath = await readHooksPath(runner, finalBefore.root, signal);
  if (finalHooksPath !== hooksPath) pushPolicyRejected();
  const finalPolicy = await readPushPolicy(runner, finalBefore.root, signal);
  if (finalPolicy.hash !== policy.hash || finalPolicy.rawEndpoint !== policy.rawEndpoint
    || !sameRemoteIdentity(finalPolicy.remote, policy.remote)) pushPolicyRejected();
  const finalRemoteHead = await readRemoteBranchHead(runner, finalBefore, finalBefore.branch!, signal);
  assertExpectedRemoteHead(input.expectedRemoteHead, finalRemoteHead);

  const remoteIdentity = remoteIdentityString(finalPolicy.remote);
  const prepared = Object.freeze({ remoteIdentity });
  preparedForcePushStates.set(prepared, {
    snapshot: Object.freeze({ ...finalBefore }),
    branchRef: canonicalRef,
    worktreeProof: "complete",
    worktreeSnapshotId: finalWorktree.status.worktree_snapshot_id,
    worktreePaths: Object.freeze([...finalWorktree.contentProof.paths]),
    worktreeContentSnapshotId: finalWorktree.contentProof.snapshotId,
    remoteIdentity,
    rawEndpoint: finalPolicy.rawEndpoint,
    hooksPath: finalHooksPath,
    remoteHead: finalRemoteHead,
    pushPolicyHash: finalPolicy.hash,
  });
  return prepared;
}

export function preparedForcePushObservation(prepared: PreparedForcePush): ForcePushPreflightObservation {
  const state = preparedForcePushStates.get(prepared);
  if (state === undefined) pushRejected("INVALID_INPUT", "Prepared force-push authority is invalid or already consumed");
  return Object.freeze({
    branch: state.snapshot.branch!,
    local_head: state.snapshot.head,
    index_tree: state.snapshot.indexTree,
    worktree_snapshot_id: state.worktreeSnapshotId,
    remote_identity: state.remoteIdentity,
    remote_head: state.remoteHead,
    push_policy_hash: state.pushPolicyHash,
  });
}

function pushIndeterminate(operation: "git_push" | "git_push_force_with_lease"): never {
  proven<PushData>({
    status: "indeterminate",
    operation,
    warnings: [],
    error: { code: "OPERATION_INDETERMINATE", message: "Push started but its final remote state could not be confirmed" },
  });
}

function pushCommandSucceeded(command: GitCommandResult | undefined): boolean {
  return command !== undefined && command.exitCode === 0 && command.signal === null
    && !command.timedOut && !command.aborted && !command.stdoutTruncated && !command.stderrTruncated;
}

function pushCommandClean(command: GitCommandResult | undefined): boolean {
  return pushCommandSucceeded(command) && command!.stderr === ""
    && !command!.stdout.includes("�") && !command!.stderr.includes("�");
}

function pushFailureMessage(code: ReturnType<typeof failedCode>): string {
  if (code === "GIT_TIMEOUT") return "Git push timed out without changing the remote branch";
  if (code === "OUTPUT_TRUNCATED") return "Git push output was truncated without changing the remote branch";
  return "Git push failed without changing the remote branch";
}

/** Executes one fixed push, then proves exact local, origin, and remote state without the caller signal. */
export async function executePreparedPush(
  runner: GitRunner,
  prepared: PreparedPush,
  signal?: AbortSignal,
): Promise<PushExecutionOutcome> {
  const state = preparedPushStates.get(prepared);
  if (state === undefined) pushRejected("INVALID_INPUT", "Prepared push authority is invalid or already consumed");
  preparedPushStates.delete(prepared);

  return executePreparedPushState(runner, state, "git_push", signal);
}

async function executePreparedPushState(
  runner: GitRunner,
  state: PreparedPushState,
  operation: "git_push" | "git_push_force_with_lease",
  signal?: AbortSignal,
): Promise<PushExecutionOutcome> {
  let command: GitCommandResult | undefined;
  let hookAdapter: Awaited<ReturnType<typeof createPushHookAdapter>> | undefined;
  try {
    hookAdapter = await createPushHookAdapter(state.hooksPath);
    command = await runner.run({
      cwd: state.snapshot.root,
      args: [
        "push",
        `--force-with-lease=${state.branchRef}:${state.remoteHead ?? ""}`,
        state.rawEndpoint,
        `${state.snapshot.head}:${state.branchRef}`,
      ],
      timeoutMs: remainingDeadlineTimeoutMs(OPERATION_TIMEOUT_MS.remote),
      maxOutputBytes: READ_OUTPUT_LIMIT,
      hookExecution: {
        wrappersDirectory: hookAdapter.directory,
        failureConsumer: () => undefined,
        prePushEndpoint: state.rawEndpoint,
      },
    }, signal);
  } catch {
    command = undefined;
  } finally {
    try { await hookAdapter?.cleanup(); }
    catch { /* The adapter contains no endpoint and cleanup cannot alter the Git outcome. */ }
  }

  return withReconciliationDeadline(async () => {
  let after: RepositorySnapshot;
  let worktreeSnapshotAfter: string;
  let worktreeContentSnapshotAfter: string | undefined;
  let worktreePathsAfter: readonly string[] | undefined;
  let hooksPathAfter: string;
  let policyAfter: PushPolicyProof;
  let remoteHeadAfter: string | null;
  try {
    after = await inspectRepository(runner, state.snapshot.root);
    if (state.worktreeProof === "tracked") {
      worktreeSnapshotAfter = await readPushTrackedWorktreeSnapshotId(runner, after);
    } else {
      const worktree = await readStatusWithWorktreeContentProof(runner, after, state.worktreePaths ?? []);
      worktreeSnapshotAfter = worktree.status.worktree_snapshot_id;
      worktreeContentSnapshotAfter = worktree.contentProof.snapshotId;
      worktreePathsAfter = worktree.contentProof.paths;
    }
    hooksPathAfter = await readHooksPath(runner, after.root);
    if (hooksPathAfter !== state.hooksPath) pushIndeterminate(operation);
    policyAfter = await readPushPolicy(runner, after.root);
    if (policyAfter.hash !== state.pushPolicyHash || policyAfter.rawEndpoint !== state.rawEndpoint
      || remoteIdentityString(policyAfter.remote) !== state.remoteIdentity) pushIndeterminate(operation);
    remoteHeadAfter = await readRemoteBranchHeadFrom(runner, after, after.branch!, state.rawEndpoint);
    const finalPolicy = await readPushPolicy(runner, after.root);
    const finalHooksPath = await readHooksPath(runner, after.root);
    if (policyAfter.hash !== finalPolicy.hash || policyAfter.rawEndpoint !== finalPolicy.rawEndpoint
      || !sameRemoteIdentity(policyAfter.remote, finalPolicy.remote)
      || finalHooksPath !== hooksPathAfter) pushIndeterminate(operation);
  } catch (error) {
    if (error instanceof ProvenMutationOutcome) throw error;
    pushIndeterminate(operation);
  }

  if (!sameLocalState(state.snapshot, after!)
    || worktreeSnapshotAfter! !== state.worktreeSnapshotId
    || (state.worktreeProof === "complete"
      && (worktreeContentSnapshotAfter !== state.worktreeContentSnapshotId
        || worktreePathsAfter?.join("\0") !== state.worktreePaths?.join("\0")))
    || hooksPathAfter! !== state.hooksPath
    || policyAfter!.hash !== state.pushPolicyHash
    || policyAfter!.rawEndpoint !== state.rawEndpoint
    || remoteIdentityString(policyAfter!.remote) !== state.remoteIdentity) {
    pushIndeterminate(operation);
  }

  if (remoteHeadAfter! === state.snapshot.head) {
    if (!pushCommandSucceeded(command)) pushIndeterminate(operation);
    const warnings = pushCommandClean(command)
      ? []
      : ["Git push completion was not clean after the remote update was proven"];
    return {
      data: { local_head: state.snapshot.head, remote_head: remoteHeadAfter! },
      warnings: Object.freeze(warnings),
    };
  }

  if (!pushCommandSucceeded(command) && remoteHeadAfter! === state.remoteHead) {
    const code = failedCode(command);
    proven<PushData>({
      status: "failed",
      operation,
      warnings: [],
      error: { code, message: pushFailureMessage(code) },
    });
  }
  pushIndeterminate(operation);
  });
}

export async function executePreparedForcePush(
  runner: GitRunner,
  prepared: PreparedForcePush,
  signal?: AbortSignal,
): Promise<PushExecutionOutcome> {
  const state = preparedForcePushStates.get(prepared);
  if (state === undefined) pushRejected("INVALID_INPUT", "Prepared force-push authority is invalid or already consumed");
  preparedForcePushStates.delete(prepared);
  return executePreparedPushState(runner, state, "git_push_force_with_lease", signal);
}

/** Convenience wrapper; Task 14 must wire prepare and execute on opposite sides of mutationStarted. */
export async function pushCurrentBranch(
  runner: GitRunner,
  snapshot: RepositorySnapshot,
  input: PushRequest,
  signal?: AbortSignal,
): Promise<PushExecutionOutcome> {
  const prepared = await preparePushOrigin(runner, snapshot, input, signal);
  return executePreparedPush(runner, prepared, signal);
}
