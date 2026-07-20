import { isAbsolute, normalize, posix, resolve } from "node:path";
import { isIP } from "node:net";
import { validateOriginRemoteRef } from "../domain/origin-ref.js";
import { isWellFormedGitText } from "../domain/git-text.js";
import {
  BRIDGE_ERROR_CODES, validateOperationOutput, type BridgeResult, type OperationStatus,
} from "../domain/result.js";
import { redactDiagnostic } from "../domain/redaction.js";
import {
  GIT_PATH_MAX_BYTES,
  RETURNED_PATH_SET_MAX_BYTES,
  RETURNED_PATH_SET_MAX_COUNT,
  RETURNED_REF_SET_MAX_BYTES,
  RETURNED_REF_SET_MAX_COUNT,
} from "../limits.js";
import { canonicalStringify } from "./atomic-json.js";

export interface OperationRequestRecord { requestId: string; requestHash: string; operation: string; repositoryId: string; input: unknown; createdAt: string }
export interface OperationStartedRecord { requestId: string; startedAt: string; pid: number }
export interface OperationResultRecord { requestId: string; completedAt: string; result: BridgeResult<unknown> }
export interface RepositoryRecord { repositoryId: string; root: string; gitDir: string; commonGitDir: string; lastSeenAt: string }
export interface StageRecord {
  kind: "stage"; stageId: string; repositoryId: string; branch: string;
  baseHead: string; initialIndexTree: string; currentIndexTree: string;
  ownedPaths: readonly string[]; createdAt: string; updatedAt: string;
}
export interface FetchRecord {
  kind: "fetch"; fetchId: string; repositoryId: string; branch: string;
  head: string; remoteIdentity: { scheme: "https" | "ssh"; host: string; pathHash: string };
  refsBefore: Readonly<Record<string, string>>; refsAfter: Readonly<Record<string, string>>;
  fetchedAt: string;
}
export interface MergeRecord {
  kind: "merge"; mergeSessionId: string; repositoryId: string; branch: string;
  originalHead: string; targetObject: string; fetchId: string;
  currentIndexTree: string;
  conflictedPaths: readonly string[]; resolvedPaths: readonly string[];
  createdAt: string; updatedAt: string;
}
export interface AuditRecord {
  timestamp: string; requestId: string; operation: string; repositoryId: string;
  status: OperationStatus; durationMs: number; errorCode?: string; errorMessage?: string;
  hookChangedPaths?: readonly string[];
}

type UnknownRecord = Record<string, unknown>;
const statuses = new Set<OperationStatus>(["succeeded", "failed", "conflicted", "rejected", "indeterminate"]);
const errorCodes = new Set<string>(BRIDGE_ERROR_CODES);

function strictRecord(value: unknown, required: readonly string[], optional: readonly string[], label: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be an object`);
  }
  const keys = Object.keys(value);
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} has invalid keys`);
  }
  return value as UnknownRecord;
}

function stringField(record: UnknownRecord, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new TypeError(`${label}.${key} must be a string`);
  return value;
}

export function validateSafeId(value: unknown, label = "ID"): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value) || value === "." || value === "..") {
    throw new TypeError(`${label} is not a safe ID component`);
  }
  return value;
}

export function validateRepositoryId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new TypeError("Repository ID must be a SHA-256 value");
  return value;
}

export function validateTimestamp(value: unknown, label = "timestamp"): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new TypeError(`${label} must be a canonical UTC timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) throw new TypeError(`${label} is invalid`);
  return value;
}

function validateHash(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`${label} must be a SHA-256 value`);
  return value;
}

function validateObjectId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value)) throw new TypeError(`${label} must be a Git object ID`);
  return value;
}

function validateOperation(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9_]{0,127}$/.test(value)) throw new TypeError("operation is invalid");
  return value;
}

function validateBranch(value: unknown): string {
  if (typeof value !== "string" || !isWellFormedGitText(value)
    || value.length === 0 || value.length > 1024 || /[\0-\x1f\x7f]/.test(value)) throw new TypeError("branch is invalid");
  return value;
}

function validateRelativePath(value: unknown): string {
  if (typeof value !== "string" || !isWellFormedGitText(value)
    || value.length === 0 || Buffer.byteLength(value, "utf8") > GIT_PATH_MAX_BYTES || value.startsWith(":")
    || value.includes("\\") || value.includes("\0") || posix.isAbsolute(value)) {
    throw new TypeError("path is not a safe repository-relative path");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new TypeError("path contains traversal");
  return value;
}

function validateGitOutputPath(value: unknown): string {
  if (typeof value !== "string" || !isWellFormedGitText(value)
    || value.length === 0 || Buffer.byteLength(value, "utf8") > GIT_PATH_MAX_BYTES
    || value.includes("\0") || value.startsWith("/")) {
    throw new TypeError("path is not a valid repository-relative Git output path");
  }
  const parts = value.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) throw new TypeError("path contains traversal");
  return value;
}

function validateStringArray(value: unknown, item: (entry: unknown) => string, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  return value.map(item);
}

function validateBoundedPathArray(
  value: unknown,
  item: (entry: unknown) => string,
  label: string,
): readonly string[] {
  const paths = validateStringArray(value, item, label);
  if (paths.length > RETURNED_PATH_SET_MAX_COUNT
    || paths.reduce((bytes, path) => bytes + Buffer.byteLength(path, "utf8"), 0) > RETURNED_PATH_SET_MAX_BYTES) {
    throw new TypeError(`${label} exceeds its count or byte limit`);
  }
  return paths;
}

function validateAbsoluteCanonicalPath(value: unknown, label: string): string {
  if (typeof value !== "string" || !isWellFormedGitText(value)
    || !isAbsolute(value) || normalize(value) !== value || resolve(value) !== value) {
    throw new TypeError(`${label} must be a canonical absolute path`);
  }
  return value;
}

function validateRefMap(value: unknown, label: string): Readonly<Record<string, string>> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be an object`);
  }
  const record = value as UnknownRecord;
  const entries = Object.entries(record);
  if (entries.length > RETURNED_REF_SET_MAX_COUNT
    || entries.reduce((bytes, [ref, object]) => bytes + Buffer.byteLength(ref) + (typeof object === "string" ? Buffer.byteLength(object) : 0), 0)
      > RETURNED_REF_SET_MAX_BYTES) {
    throw new TypeError(`${label} exceeds its count or byte limit`);
  }
  for (const [ref, object] of entries) {
    if (ref.length === 0 || ref.includes("\0")) throw new TypeError(`${label} contains an invalid ref`);
    validateObjectId(object, `${label}.${ref}`);
  }
  return record as Readonly<Record<string, string>>;
}

export { validateOriginRemoteRef } from "../domain/origin-ref.js";

function validateRemoteHost(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 259 || value !== value.toLowerCase()
    || /[\s/@%\0]/.test(value)) throw new TypeError("remoteIdentity.host is invalid");
  let parsed: URL;
  try { parsed = new URL(`ssh://${value}/repository`); }
  catch { throw new TypeError("remoteIdentity.host is invalid"); }
  const hostname = parsed.hostname;
  if (hostname.startsWith("[") || hostname.endsWith("]")) {
    if (!(hostname.startsWith("[") && hostname.endsWith("]")) || isIP(hostname.slice(1, -1)) !== 6) {
      throw new TypeError("remoteIdentity.host is invalid");
    }
  } else if (isIP(hostname) === 0 && hostname.split(".").some((label) => label.length === 0 || label.length > 63
    || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new TypeError("remoteIdentity.host is invalid");
  }
  if (parsed.port !== "" && (Number(parsed.port) < 1 || Number(parsed.port) > 65_535)) {
    throw new TypeError("remoteIdentity.host is invalid");
  }
  const normalized = parsed.port === "" ? hostname : `${hostname}:${parsed.port}`;
  if (normalized !== value) throw new TypeError("remoteIdentity.host is invalid");
  return value;
}

function validateJsonObject(value: unknown, label: string): UnknownRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be an object`);
  }
  canonicalStringify(value);
  return value as UnknownRecord;
}

export function validateOperationRequestRecord(value: unknown, expectedId?: string): OperationRequestRecord {
  const record = strictRecord(value, ["requestId", "requestHash", "operation", "repositoryId", "input", "createdAt"], [], "Operation request record");
  const requestId = validateSafeId(record.requestId, "Request ID");
  if (expectedId !== undefined && requestId !== expectedId) throw new TypeError("Operation request record ID does not match its path");
  validateHash(record.requestHash, "requestHash"); validateOperation(record.operation); validateRepositoryId(record.repositoryId);
  canonicalStringify(record.input); validateTimestamp(record.createdAt, "createdAt");
  return record as unknown as OperationRequestRecord;
}

export function validateOperationStartedRecord(value: unknown, expectedId?: string): OperationStartedRecord {
  const record = strictRecord(value, ["requestId", "startedAt", "pid"], [], "Operation started record");
  const requestId = validateSafeId(record.requestId, "Request ID");
  if (expectedId !== undefined && requestId !== expectedId) throw new TypeError("Operation started record ID does not match its path");
  validateTimestamp(record.startedAt, "startedAt");
  if (!Number.isSafeInteger(record.pid) || (record.pid as number) <= 0) throw new TypeError("Operation started record pid is invalid");
  return record as unknown as OperationStartedRecord;
}

function validateBridgeResult(value: unknown, expectedId?: string): BridgeResult<unknown> {
  const result = strictRecord(value, ["status", "operation", "warnings"], ["request_id", "repository_id", "observed_before", "observed_after", "data", "error"], "Bridge result");
  if (typeof result.status !== "string" || !statuses.has(result.status as OperationStatus)) throw new TypeError("Bridge result status is invalid");
  validateOperation(result.operation);
  if (result.request_id !== undefined) {
    const requestId = validateSafeId(result.request_id, "Request ID");
    if (expectedId !== undefined && requestId !== expectedId) throw new TypeError("Bridge result request ID does not match");
  }
  if (result.repository_id !== undefined) validateRepositoryId(result.repository_id);
  validateStringArray(result.warnings, (entry) => {
    if (typeof entry !== "string") throw new TypeError("Bridge result warning must be a string"); return entry;
  }, "warnings");
  for (const key of ["observed_before", "observed_after"] as const) {
    if (result[key] !== undefined) validateJsonObject(result[key], `Bridge result ${key}`);
  }
  if (result.data !== undefined) canonicalStringify(result.data);
  if (result.error !== undefined) {
    const error = strictRecord(result.error, ["code", "message"], ["details"], "Bridge error");
    if (typeof error.code !== "string" || !errorCodes.has(error.code)) throw new TypeError("Bridge error code is invalid");
    if (typeof error.message !== "string") throw new TypeError("Bridge error message is invalid");
    if (error.details !== undefined) validateJsonObject(error.details, "Bridge error details");
    canonicalStringify(error.details ?? {});
  }
  const status = result.status as OperationStatus;
  const hasData = result.data !== undefined;
  const hasError = result.error !== undefined;
  if (status === "succeeded" || status === "conflicted") {
    if (!hasData) throw new TypeError(`Bridge result data is required for ${status}`);
    if (hasError) throw new TypeError(`Bridge result error is forbidden for ${status}`);
    validateOperationOutput(result.operation as string, result.data);
  } else {
    if (hasData) throw new TypeError(`Bridge result data is forbidden for ${status}`);
    if (!hasError) throw new TypeError(`Bridge result error is required for ${status}`);
  }
  if (status === "conflicted" && result.operation !== "git_merge") {
    throw new TypeError("Only git_merge may persist a conflicted result");
  }
  canonicalStringify(result);
  return result as unknown as BridgeResult<unknown>;
}

export function validateOperationResultRecord(value: unknown, expectedId?: string): OperationResultRecord {
  const record = strictRecord(value, ["requestId", "completedAt", "result"], [], "Operation result record");
  const requestId = validateSafeId(record.requestId, "Request ID");
  if (expectedId !== undefined && requestId !== expectedId) throw new TypeError("Operation result record ID does not match its path");
  validateTimestamp(record.completedAt, "completedAt"); validateBridgeResult(record.result, requestId);
  return record as unknown as OperationResultRecord;
}

export function validateRepositoryRecord(value: unknown, expectedId?: string): RepositoryRecord {
  const record = strictRecord(value, ["repositoryId", "root", "gitDir", "commonGitDir", "lastSeenAt"], [], "Repository record");
  const id = validateRepositoryId(record.repositoryId);
  if (expectedId !== undefined && id !== expectedId) throw new TypeError("Repository record ID does not match its path");
  validateAbsoluteCanonicalPath(record.root, "root"); validateAbsoluteCanonicalPath(record.gitDir, "gitDir");
  validateAbsoluteCanonicalPath(record.commonGitDir, "commonGitDir"); validateTimestamp(record.lastSeenAt, "lastSeenAt");
  return record as unknown as RepositoryRecord;
}

export function validateStageRecord(value: unknown, expectedId?: string): StageRecord {
  const record = strictRecord(value, ["kind", "stageId", "repositoryId", "branch", "baseHead", "initialIndexTree", "currentIndexTree", "ownedPaths", "createdAt", "updatedAt"], [], "Stage record");
  if (record.kind !== "stage") throw new TypeError("Stage record kind is invalid");
  const id = validateSafeId(record.stageId, "Stage ID"); if (expectedId !== undefined && id !== expectedId) throw new TypeError("Stage record ID does not match its path");
  validateRepositoryId(record.repositoryId); validateBranch(record.branch); validateObjectId(record.baseHead, "Stage record baseHead");
  validateHash(record.initialIndexTree, "Stage record initialIndexTree"); validateHash(record.currentIndexTree, "Stage record currentIndexTree");
  validateBoundedPathArray(record.ownedPaths, validateRelativePath, "ownedPaths"); validateTimestamp(record.createdAt, "createdAt"); validateTimestamp(record.updatedAt, "updatedAt");
  return record as unknown as StageRecord;
}

export function validateFetchRecord(value: unknown, expectedId?: string): FetchRecord {
  const record = strictRecord(value, ["kind", "fetchId", "repositoryId", "branch", "head", "remoteIdentity", "refsBefore", "refsAfter", "fetchedAt"], [], "Fetch record");
  if (record.kind !== "fetch") throw new TypeError("Fetch record kind is invalid");
  const id = validateSafeId(record.fetchId, "Fetch ID"); if (expectedId !== undefined && id !== expectedId) throw new TypeError("Fetch record ID does not match its path");
  validateRepositoryId(record.repositoryId); validateBranch(record.branch); validateObjectId(record.head, "head");
  const remote = strictRecord(record.remoteIdentity, ["scheme", "host", "pathHash"], [], "remoteIdentity");
  if (remote.scheme !== "https" && remote.scheme !== "ssh") throw new TypeError("remoteIdentity.scheme is invalid");
  validateRemoteHost(remote.host);
  validateHash(remote.pathHash, "remoteIdentity.pathHash");
  const refsBefore = validateRefMap(record.refsBefore, "refsBefore");
  const refsAfter = validateRefMap(record.refsAfter, "refsAfter");
  for (const ref of [...Object.keys(refsBefore), ...Object.keys(refsAfter)]) validateOriginRemoteRef(ref);
  validateTimestamp(record.fetchedAt, "fetchedAt"); return record as unknown as FetchRecord;
}

export function validateMergeRecord(value: unknown, expectedId?: string): MergeRecord {
  const record = strictRecord(value, ["kind", "mergeSessionId", "repositoryId", "branch", "originalHead", "targetObject", "fetchId", "currentIndexTree", "conflictedPaths", "resolvedPaths", "createdAt", "updatedAt"], [], "Merge record");
  if (record.kind !== "merge") throw new TypeError("Merge record kind is invalid");
  const id = validateSafeId(record.mergeSessionId, "Merge ID"); if (expectedId !== undefined && id !== expectedId) throw new TypeError("Merge record ID does not match its path");
  validateRepositoryId(record.repositoryId); validateBranch(record.branch); validateObjectId(record.originalHead, "originalHead"); validateObjectId(record.targetObject, "targetObject");
  validateSafeId(record.fetchId, "Fetch ID"); validateHash(record.currentIndexTree, "currentIndexTree");
  validateBoundedPathArray(record.conflictedPaths, validateGitOutputPath, "conflictedPaths");
  validateBoundedPathArray(record.resolvedPaths, validateGitOutputPath, "resolvedPaths");
  validateTimestamp(record.createdAt, "createdAt"); validateTimestamp(record.updatedAt, "updatedAt"); return record as unknown as MergeRecord;
}

export function validateAuditRecord(value: unknown): AuditRecord {
  const record = strictRecord(value, ["timestamp", "requestId", "operation", "repositoryId", "status", "durationMs"], ["errorCode", "errorMessage", "hookChangedPaths"], "Audit record");
  validateTimestamp(record.timestamp); validateSafeId(record.requestId, "Request ID"); validateOperation(record.operation); validateRepositoryId(record.repositoryId);
  if (typeof record.status !== "string" || !statuses.has(record.status as OperationStatus)) throw new TypeError("Audit status is invalid");
  if (!Number.isSafeInteger(record.durationMs) || (record.durationMs as number) < 0) throw new TypeError("Audit durationMs is invalid");
  if (record.errorCode !== undefined && typeof record.errorCode !== "string") throw new TypeError("Audit errorCode is invalid");
  if (record.errorMessage !== undefined && typeof record.errorMessage !== "string") throw new TypeError("Audit errorMessage is invalid");
  if (record.hookChangedPaths !== undefined) validateBoundedPathArray(record.hookChangedPaths, validateGitOutputPath, "hookChangedPaths");
  return record as unknown as AuditRecord;
}

function redactFullUrls(value: string): string {
  return value
    .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[REMOTE_URL_REDACTED]")
    .replace(/(?:[^\s@"'<>:]+@)?[^\s\/@"'<>:]+:(?:[^\s"'<>]*\/[^\s"'<>]*|[^\s"'<>]*\.git)/g, "[REMOTE_URL_REDACTED]");
}

export function sanitizePersistentString(value: string): string {
  return redactFullUrls(redactDiagnostic(value));
}

function sanitizeContextualString(value: string, fieldName?: string): string {
  const diagnostic = redactDiagnostic(value);
  if (/remote|url|uri|endpoint|warning|message|diagnostic/i.test(fieldName ?? "") || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)
    || /^[^\s@]+@[^\s/:]+:[^\s]+/.test(value)) {
    return redactFullUrls(diagnostic);
  }
  return diagnostic;
}

type PersistenceContext = "structured" | "structured-map" | "diagnostic" | "remote";

const STRUCTURED_REMOTE_FIELDS = new Set([
  "expected_remote_head", "expected_remote_object", "remote_head", "remote_identity", "remote_ref",
]);
const STRUCTURED_MAP_FIELDS = new Set(["labels", "refs", "refs_after", "refs_before"]);

function normalizedFieldName(fieldName: string): string {
  return fieldName.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function fieldWords(fieldName: string): readonly string[] {
  return normalizedFieldName(fieldName).split(/[^a-z0-9]+/).filter(Boolean);
}

function isCredentialField(fieldName: string): boolean {
  if (fieldName.includes("/") || fieldName.includes("=")) return false;
  const words = fieldWords(fieldName);
  return words.some((word) => ["authorization", "credential", "credentials", "password", "secret", "token"].includes(word));
}

function childPersistenceContext(fieldName: string, parent: PersistenceContext): PersistenceContext {
  if (parent === "diagnostic") return "diagnostic";
  if (parent === "structured-map") return "structured-map";
  const normalized = normalizedFieldName(fieldName);
  if (STRUCTURED_MAP_FIELDS.has(normalized)) return "structured-map";
  if (STRUCTURED_REMOTE_FIELDS.has(normalized)) return "structured";
  const words = fieldWords(fieldName);
  if (words.some((word) => ["details", "diagnostic", "error", "message", "stderr", "stdout", "warning", "warnings"].includes(word))) {
    return "diagnostic";
  }
  if (words.some((word) => ["endpoint", "remote", "uri", "url"].includes(word))) return "remote";
  return "structured";
}

export function sanitizePersistentJson(
  value: unknown,
  fieldName?: string,
  context: PersistenceContext = "structured",
): unknown {
  canonicalStringify(value);
  const effectiveContext = fieldName === undefined ? context : childPersistenceContext(fieldName, context);
  if (typeof value === "string") {
    if (effectiveContext === "structured" || effectiveContext === "structured-map") return value;
    return sanitizePersistentString(value);
  }
  if (Array.isArray(value)) return value.map((entry) => sanitizePersistentJson(entry, undefined, effectiveContext));
  if (value !== null && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      sanitized[key] = effectiveContext !== "structured-map" && isCredentialField(key)
        ? "[REDACTED]"
        : sanitizePersistentJson(entry, key, effectiveContext);
    }
    return sanitized;
  }
  return value;
}

export function sanitizeAndValidateBridgeResult(value: BridgeResult<unknown>, requestId: string): BridgeResult<unknown> {
  const valid = validateBridgeResult(value, requestId);
  const data = valid.data === undefined ? undefined : validateOperationOutput(valid.operation, valid.data);
  const sanitized: BridgeResult<unknown> = {
    status: valid.status,
    ...(valid.request_id === undefined ? {} : { request_id: valid.request_id }),
    ...(valid.repository_id === undefined ? {} : { repository_id: valid.repository_id }),
    operation: valid.operation,
    ...(valid.observed_before === undefined ? {} : {
      observed_before: sanitizePersistentJson(valid.observed_before, "observed_before") as Readonly<Record<string, unknown>>,
    }),
    ...(valid.observed_after === undefined ? {} : {
      observed_after: sanitizePersistentJson(valid.observed_after, "observed_after") as Readonly<Record<string, unknown>>,
    }),
    ...(data === undefined ? {} : { data }),
    warnings: valid.warnings.map((warning) => sanitizeContextualString(warning, "warning")),
    ...(valid.error === undefined ? {} : {
      error: {
        code: valid.error.code,
        message: sanitizeContextualString(valid.error.message, "message"),
        ...(valid.error.details === undefined ? {} : {
          details: sanitizePersistentJson(valid.error.details, undefined, "diagnostic") as Readonly<Record<string, unknown>>,
        }),
      },
    }),
  };
  return validateBridgeResult(sanitized, requestId);
}
