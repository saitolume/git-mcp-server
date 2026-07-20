const INLINE_PATHSPEC_MAX_BYTES = 48 * 1024;

function argumentBytes(path: string): number {
  if (path.includes("\0")) throw new TypeError("Literal Git paths must not contain NUL");
  return Buffer.byteLength(path, "utf8") + 1;
}

/** Splits literal argv pathspecs below a conservative macOS/Linux ARG_MAX budget. */
export function literalPathChunks(
  paths: readonly string[],
  maxBytes = INLINE_PATHSPEC_MAX_BYTES,
): readonly (readonly string[])[] {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError("maxBytes must be a positive safe integer");
  const chunks: string[][] = [];
  let chunk: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const size = argumentBytes(path);
    if (size > maxBytes) throw new RangeError("One literal Git path exceeds the argv chunk budget");
    if (chunk.length > 0 && bytes + size > maxBytes) {
      chunks.push(chunk);
      chunk = [];
      bytes = 0;
    }
    chunk.push(path);
    bytes += size;
  }
  if (chunk.length > 0) chunks.push(chunk);
  return chunks;
}

export type LiteralPathspecTransport = {
  readonly args: readonly string[];
  readonly stdin?: string;
};

/** Uses stdin for large sets on Git commands that implement pathspec-from-file. */
export function literalPathspecTransport(paths: readonly string[]): LiteralPathspecTransport {
  const bytes = paths.reduce((total, path) => total + argumentBytes(path), 0);
  if (bytes <= INLINE_PATHSPEC_MAX_BYTES) return { args: ["--", ...paths] };
  return {
    args: ["--pathspec-from-file=-", "--pathspec-file-nul"],
    stdin: `${paths.join("\0")}\0`,
  };
}
