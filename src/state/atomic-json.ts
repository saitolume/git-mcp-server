import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;

export interface ReadJsonOptions { maxBytes?: number }

export type AtomicCreateStep = "linked" | "temporary-unlinked" | "directory-synced";

export interface AtomicCreateJsonOptions {
  onStep?: (step: AtomicCreateStep) => void | Promise<void>;
}

export interface AtomicCreateJsonOutcome {
  readonly cleanup: "complete" | "incomplete";
}

/** The no-replace target is visible, but its parent-directory durability was not confirmed. */
export class AtomicJsonDurabilityError extends Error {
  constructor() {
    super("Atomic JSON publication durability was not confirmed");
    this.name = "AtomicJsonDurabilityError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

function canonical(value: unknown, active: WeakSet<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError(`Unsupported JSON value: ${typeof value}`);
  if (active.has(value)) throw new TypeError("JSON value contains a circular reference");
  active.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) throw new TypeError("JSON array has an unsupported prototype");
      const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
      if (keys.some((key) => typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key))) {
        throw new TypeError("JSON array has unsupported properties");
      }
      if (keys.length !== value.length) throw new TypeError("Sparse arrays are not valid canonical JSON");
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      if (lengthDescriptor === undefined || !("value" in lengthDescriptor) || !lengthDescriptor.writable || lengthDescriptor.enumerable || lengthDescriptor.configurable) {
        throw new TypeError("JSON array has an unsupported length property");
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable || !descriptor.writable || !descriptor.configurable) {
          throw new TypeError("JSON array has an unsupported accessor or index property");
        }
        items.push(canonical(descriptor.value, active));
      }
      return `[${items.join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("JSON object has an unsupported prototype");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const symbolKeys = Object.getOwnPropertySymbols(value);
    if (symbolKeys.length > 0) throw new TypeError("JSON object has symbol properties");
    const keys = Object.keys(descriptors).sort();
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError("JSON object has unsupported properties");
      }
    }
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(descriptors[key]?.value, active)}`).join(",")}}`;
  } finally {
    active.delete(value);
  }
}

export function canonicalStringify(value: unknown): string {
  return canonical(value, new WeakSet<object>());
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

export type DurableUnlinkStep = "unlinked" | "directory-synced";

/** Removes one exact path and makes that directory entry transition durable before returning. */
export async function durableUnlink(
  path: string,
  onStep: (step: DurableUnlinkStep) => void | Promise<void> = () => undefined,
): Promise<void> {
  await unlink(path);
  await onStep("unlinked");
  await syncDirectory(dirname(path));
  await onStep("directory-synced");
}

async function writeTemporary(target: string, contents: string): Promise<{ path: string; close: () => Promise<void> }> {
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  let closed = false;
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    return {
      path: temporary,
      close: async () => { if (!closed) { closed = true; await handle.close(); } },
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function atomicWriteJson(target: string, value: unknown): Promise<void> {
  const contents = `${canonicalStringify(value)}\n`;
  const temporary = await writeTemporary(target, contents);
  try {
    await temporary.close();
    await rename(temporary.path, target);
    await syncDirectory(dirname(target));
  } catch (error) {
    await temporary.close().catch(() => undefined);
    await unlink(temporary.path).catch(() => undefined);
    throw error;
  }
}

/** Publishes a new JSON file atomically and fails if the target already exists. */
export async function atomicCreateJson(
  target: string,
  value: unknown,
  options: AtomicCreateJsonOptions = {},
): Promise<AtomicCreateJsonOutcome> {
  const contents = `${canonicalStringify(value)}\n`;
  const temporary = await writeTemporary(target, contents);
  let linked = false;
  try {
    await temporary.close();
    await link(temporary.path, target);
    linked = true;
    let cleanup: AtomicCreateJsonOutcome["cleanup"] = "complete";
    try {
      await options.onStep?.("linked");
      await unlink(temporary.path);
    } catch {
      cleanup = "incomplete";
    }
    try {
      await options.onStep?.("temporary-unlinked");
      await syncDirectory(dirname(target));
    } catch {
      throw new AtomicJsonDurabilityError();
    }
    await options.onStep?.("directory-synced");
    return { cleanup };
  } catch (error) {
    await temporary.close().catch(() => undefined);
    if (!linked) await unlink(temporary.path).catch(() => undefined);
    throw error;
  }
}

export async function readJson(target: string, options: ReadJsonOptions = {}): Promise<unknown | null> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_JSON_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive safe integer");
  let before;
  try {
    before = await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (before.isSymbolicLink()) throw new Error(`Refusing to read JSON symlink: ${target}`);
  if (!before.isFile()) throw new Error(`JSON path is not a regular file: ${target}`);
  if (typeof process.getuid === "function" && before.uid !== process.getuid()) throw new Error(`JSON file is not owned by this user: ${target}`);
  const handle = await open(target, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  try {
    const details = await handle.stat();
    if (!details.isFile()) throw new Error(`JSON path is not a regular file: ${target}`);
    if (details.dev !== before.dev || details.ino !== before.ino) throw new Error(`JSON file changed while opening: ${target}`);
    if (typeof process.getuid === "function" && details.uid !== process.getuid()) throw new Error(`JSON file is not owned by this user: ${target}`);
    await handle.chmod(0o600);
    if (details.size > maxBytes) throw new Error(`JSON file is too large: ${target}`);
    const contents = await handle.readFile("utf8");
    if (Buffer.byteLength(contents, "utf8") > maxBytes) throw new Error(`JSON file is too large: ${target}`);
    try { return JSON.parse(contents) as unknown; }
    catch { throw new Error(`Malformed JSON: ${target}`); }
  } finally {
    await handle.close();
  }
}
