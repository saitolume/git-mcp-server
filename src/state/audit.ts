import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { canonicalStringify } from "./atomic-json.js";
import type { StatePaths } from "./paths.js";
import { sanitizePersistentString, validateAuditRecord, type AuditRecord } from "./records.js";

const MAX_AUDIT_LINE_BYTES = 8192;

export class AuditLog {
  constructor(private readonly paths: StatePaths) {}

  async append(value: AuditRecord): Promise<void> {
    const record = validateAuditRecord(value);
    const sanitized = validateAuditRecord({
      timestamp: record.timestamp,
      requestId: record.requestId,
      operation: record.operation,
      repositoryId: record.repositoryId,
      status: record.status,
      durationMs: record.durationMs,
      ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
      ...(record.errorMessage === undefined ? {} : { errorMessage: sanitizePersistentString(record.errorMessage) }),
      ...(record.hookChangedPaths === undefined ? {} : { hookChangedPaths: [...record.hookChangedPaths] }),
    });
    const buffer = Buffer.from(`${canonicalStringify(sanitized)}\n`, "utf8");
    if (buffer.length >= MAX_AUDIT_LINE_BYTES) throw new Error("Audit record must be smaller than 8192 UTF-8 bytes including newline");
    const target = join(this.paths.audit, `${record.timestamp.slice(0, 10)}.jsonl`);
    const handle = await open(target, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NONBLOCK | constants.O_NOFOLLOW, 0o600);
    try {
      const details = await handle.stat();
      if (!details.isFile()) throw new Error(`Audit path is not a regular file: ${target}`);
      if (typeof process.getuid === "function" && details.uid !== process.getuid()) throw new Error(`Audit file is not owned by this user: ${target}`);
      await handle.chmod(0o600);
      const written = await handle.write(buffer);
      if (written.bytesWritten !== buffer.length) throw new Error("Audit append was incomplete");
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}
