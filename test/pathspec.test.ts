import assert from "node:assert/strict";
import test from "node:test";
import { literalPathspecTransport } from "../src/git/pathspec.js";

test("maximum path sets use NUL-delimited stdin instead of an ARG_MAX-sized mutation argv", () => {
  const paths = Array.from({ length: 10_000 }, (_, index) => `p${index.toString().padStart(6, "0")}`);
  const transport = literalPathspecTransport(paths);

  assert.deepEqual(transport.args, ["--pathspec-from-file=-", "--pathspec-file-nul"]);
  assert.equal(transport.stdin, `${paths.join("\0")}\0`);
  assert.ok(Buffer.byteLength(transport.stdin) <= 128 * 1024 + paths.length);
});

test("small path sets retain the literal double-dash command shape", () => {
  assert.deepEqual(literalPathspecTransport(["src/a.ts", "src/b.ts"]), {
    args: ["--", "src/a.ts", "src/b.ts"],
  });
});
