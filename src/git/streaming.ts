export {
  COMPLETE_RECORD_MAX_BYTES,
  GIT_PATH_MAX_BYTES,
  RETURNED_PATH_SET_MAX_COUNT,
  RETURNED_PATH_SET_MAX_BYTES,
  RETURNED_REF_SET_MAX_COUNT,
  RETURNED_REF_SET_MAX_BYTES,
  STREAM_STDERR_MAX_BYTES,
} from "../limits.js";

/** Incrementally frames a byte stream while retaining at most one bounded record. */
export class DelimitedRecordParser {
  private chunks: Buffer[] = [];
  private buffered = 0;

  constructor(
    private readonly delimiter: number,
    private readonly maxRecordBytes: number,
    private readonly label: string,
    private readonly onRecord: (record: string) => void,
  ) {
    if (!Number.isInteger(delimiter) || delimiter < 0 || delimiter > 255) {
      throw new RangeError("delimiter must be one byte");
    }
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
      throw new RangeError("maxRecordBytes must be a positive integer");
    }
  }

  write(chunk: Buffer): void {
    let cursor = 0;
    while (cursor < chunk.length) {
      const boundary = chunk.indexOf(this.delimiter, cursor);
      if (boundary === -1) {
        this.append(chunk.subarray(cursor));
        return;
      }
      this.append(chunk.subarray(cursor, boundary));
      this.emit();
      cursor = boundary + 1;
    }
  }

  finish(): void {
    if (this.buffered !== 0) throw new Error(`${this.label} is missing its record terminator`);
  }

  private append(chunk: Buffer): void {
    if (this.buffered + chunk.length > this.maxRecordBytes) {
      throw new Error(`${this.label} record exceeds ${this.maxRecordBytes} bytes`);
    }
    if (chunk.length === 0) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
  }

  private emit(): void {
    const bytes = this.chunks.length === 0 ? Buffer.alloc(0)
      : this.chunks.length === 1 ? this.chunks[0]!
        : Buffer.concat(this.chunks, this.buffered);
    this.chunks = [];
    this.buffered = 0;
    this.onRecord(bytes.toString("utf8"));
  }
}

export function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}
