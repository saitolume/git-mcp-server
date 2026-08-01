import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { OPERATION_TIMEOUT_MS } from "./product.js";

type DeadlineKind = "operation" | "reconciliation";

interface DeadlineContext {
  readonly kind: DeadlineKind;
  readonly deadlineAt: number;
  readonly monotonicNow: () => number;
  readonly controller: AbortController;
  readonly signal: AbortSignal;
}

export interface DeadlineOptions {
  readonly monotonicNow?: () => number;
}

export class OperationDeadlineExceeded extends Error {
  constructor(kind: DeadlineKind) {
    super(kind === "operation" ? "Operation deadline exceeded" : "Post-mutation reconciliation deadline exceeded");
    this.name = "OperationDeadlineExceeded";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const deadlines = new AsyncLocalStorage<DeadlineContext>();

function safeTimeout(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${label} must be a non-negative safe integer`);
  return value;
}

function combineSignals(left: AbortSignal, right?: AbortSignal): AbortSignal {
  if (right === undefined || right === left) return left;
  return AbortSignal.any([left, right]);
}

function expire(context: DeadlineContext): void {
  if (!context.controller.signal.aborted && context.monotonicNow() >= context.deadlineAt) {
    context.controller.abort(new OperationDeadlineExceeded(context.kind));
  }
}

/** True when an error, or the active budget behind a generic error, represents deadline expiry. */
export function isOperationDeadlineExceeded(error: unknown): boolean {
  if (error instanceof OperationDeadlineExceeded) return true;
  const context = deadlines.getStore();
  if (context === undefined) return false;
  expire(context);
  return context.controller.signal.reason instanceof OperationDeadlineExceeded;
}

function throwSignal(signal: AbortSignal): never {
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Operation was aborted");
  error.name = "AbortError";
  throw error;
}

async function withDeadlineKind<T>(
  kind: DeadlineKind,
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  task: (signal: AbortSignal) => Promise<T>,
  options: DeadlineOptions,
): Promise<T> {
  const boundedTimeout = safeTimeout(timeoutMs, "timeoutMs");
  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const controller = new AbortController();
  const signal = combineSignals(controller.signal, callerSignal);
  const context: DeadlineContext = {
    kind,
    deadlineAt: monotonicNow() + boundedTimeout,
    monotonicNow,
    controller,
    signal,
  };
  const timer = setTimeout(() => controller.abort(new OperationDeadlineExceeded(kind)), boundedTimeout);
  timer.unref();
  try {
    return await deadlines.run(context, () => task(signal));
  } finally {
    clearTimeout(timer);
  }
}

/** Establishes an explicit absolute budget, replacing any outer context. */
export function withDeadline<T>(
  timeoutMs: number,
  callerSignal: AbortSignal | undefined,
  task: (signal: AbortSignal) => Promise<T>,
  options: DeadlineOptions = {},
): Promise<T> {
  return withDeadlineKind("operation", timeoutMs, callerSignal, task, options);
}

export function operationTimeoutMs(operation: string): number {
  if (["git_status", "git_diff", "git_operation_get"].includes(operation)) return OPERATION_TIMEOUT_MS.read;
  if (["git_add", "git_restore_staged", "git_restore_worktree", "git_switch_create", "git_switch_attach"].includes(operation)) {
    return OPERATION_TIMEOUT_MS.stage;
  }
  if (["git_commit", "git_commit_range_validate", "git_reword", "git_commit_amend"].includes(operation)) {
    return OPERATION_TIMEOUT_MS.commit;
  }
  if (["git_merge", "git_merge_continue", "git_merge_abort"].includes(operation)) return OPERATION_TIMEOUT_MS.merge;
  if (["git_fetch", "git_push"].includes(operation)) return OPERATION_TIMEOUT_MS.remote;
  throw new RangeError(`Unknown operation timeout class: ${operation}`);
}

/** Starts an operation budget unless an outer service boundary already started it. */
export function withOperationDeadline<T>(
  operation: string,
  callerSignal: AbortSignal | undefined,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const current = deadlines.getStore();
  if (current?.kind === "operation") return task(combineSignals(current.signal, callerSignal));
  return withDeadlineKind("operation", operationTimeoutMs(operation), callerSignal, task, {});
}

/** Mandatory post-mutation proof ignores caller cancellation but has a separate finite budget. */
export function withReconciliationDeadline<T>(
  task: (signal: AbortSignal) => Promise<T>,
  options: DeadlineOptions = {},
): Promise<T> {
  return withDeadlineKind("reconciliation", OPERATION_TIMEOUT_MS.reconcile, undefined, task, options);
}

/** Clamps a child timeout to the current absolute budget. */
export function remainingDeadlineTimeoutMs(maximumMs: number): number {
  const maximum = safeTimeout(maximumMs, "maximumMs");
  const context = deadlines.getStore();
  if (context === undefined) return maximum;
  expire(context);
  return Math.max(0, Math.min(maximum, Math.ceil(context.deadlineAt - context.monotonicNow())));
}

/** Combines an explicit caller signal with the active absolute deadline. */
export function deadlineSignal(signal?: AbortSignal): AbortSignal | undefined {
  const context = deadlines.getStore();
  if (context === undefined) return signal;
  expire(context);
  return combineSignals(context.signal, signal);
}

/** Cooperative checkpoint for local parsing, hashing, and filesystem validation. */
export function throwIfDeadlineExceeded(signal?: AbortSignal): void {
  const effective = deadlineSignal(signal);
  if (effective?.aborted) throwSignal(effective);
}
