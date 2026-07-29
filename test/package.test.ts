import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  createPackageWorkspace,
  packPackage,
  removePackageWorkspace,
  repositoryRoot,
  tarEntries,
} from "./package-test-utils.js";

test("default pnpm package contract packs without install or lifecycle recursion", async (t) => {
  const workspace = await createPackageWorkspace();
  t.after(async () => removePackageWorkspace(workspace));

  const manifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8")) as Record<string, unknown> & {
    engines?: { node?: string };
  };
  assert.equal(manifest.name, "@saitolume/git-mcp-server");
  assert.equal(manifest.version, "0.1.0-beta.3");
  assert.equal(manifest.license, "MIT");
  assert.deepEqual(manifest.repository, {
    type: "git",
    url: "git+https://github.com/saitolume/git-mcp-server.git",
  });
  assert.deepEqual(manifest.files, ["dist", "README.md", "README.ja.md", "LICENSE"]);
  assert.deepEqual(manifest.publishConfig, { access: "public", tag: "beta" });
  assert.equal(manifest.os, undefined);
  assert.equal(manifest.cpu, undefined);
  assert.deepEqual(manifest.dependencies, {
    "@modelcontextprotocol/server": "2.0.0-beta.4",
    zod: "4.4.3",
  });
  const scripts = manifest.scripts as Record<string, string>;
  assert.equal(manifest.packageManager, "pnpm@11.15.1");
  assert.equal(manifest.engines?.node, ">=22");
  assert.equal(scripts.test, "pnpm test:compile && node --test .test-dist/test/*.test.js");
  assert.equal(scripts["check:git-version"], "node scripts/check-git-version.mjs");
  assert.equal(scripts["check:runtime-dependencies"], "node scripts/check-runtime-dependencies.mjs");
  assert.equal(scripts.check, "pnpm check:git-version && pnpm check:runtime-dependencies && pnpm typecheck && pnpm build && pnpm test");
  assert.equal(scripts.prepack, "pnpm clean && pnpm check");
  assert.equal(scripts["test:package-install"], "pnpm build && pnpm test:compile && node --test .test-dist/test/package-install.integration.js");
  assert.equal(existsSync(join(repositoryRoot, "package-lock.json")), false);
  assert.equal(existsSync(join(repositoryRoot, "pnpm-lock.yaml")), true);
  assert.equal(scripts.test.includes("package-install"), false);
  assert.equal(scripts.check.includes("package-install"), false);
  assert.equal(scripts.prepack.includes("npm pack"), false);
  assert.equal(scripts.preinstall, undefined);
  assert.equal(scripts.install, undefined);
  assert.equal(scripts.postinstall, undefined);

  const packed = packPackage(workspace);
  assert.deepEqual(workspace.pnpmCommands, [["--config.ignore-scripts=true", "pack", "--json", "--pack-destination", workspace.tarballs]]);
  assert.equal(packed.filename, "saitolume-git-mcp-server-0.1.0-beta.3.tgz");
  await access(packed.tarball);
  assert.equal(packed.tarball.startsWith(`${workspace.tarballs}/`), true);
  const paths = packed.files;
  for (const required of ["LICENSE", "README.ja.md", "README.md", "dist/cli.js", "package.json"]) {
    assert.ok(paths.includes(required), `package is missing ${required}`);
  }
  assert.ok(paths.every((path) =>
    ["LICENSE", "README.ja.md", "README.md", "package.json"].includes(path)
      || (path.startsWith("dist/") && path.endsWith(".js")),
  ));
  for (const excluded of ["src/", "test/", ".test-dist/", "docs/", "fixtures/", ".map"]) {
    assert.equal(paths.some((path) => path.includes(excluded)), false, `package unexpectedly contains ${excluded}`);
  }
  assert.ok(tarEntries(packed.tarball).includes("package/dist/cli.js"));
  assert.deepEqual((await readdir(repositoryRoot)).filter((path) => path.endsWith(".tgz")), []);
});

test("package verification workspaces are unique for concurrent runs", async (t) => {
  const [first, second] = await Promise.all([createPackageWorkspace(), createPackageWorkspace()]);
  t.after(async () => Promise.all([removePackageWorkspace(first), removePackageWorkspace(second)]));
  for (const key of ["root", "store", "tarballs", "install"] as const) assert.notEqual(first[key], second[key]);
  packPackage(first);
  packPackage(second);
  assert.deepEqual(first.pnpmCommands, [["--config.ignore-scripts=true", "pack", "--json", "--pack-destination", first.tarballs]]);
  assert.deepEqual(second.pnpmCommands, [["--config.ignore-scripts=true", "pack", "--json", "--pack-destination", second.tarballs]]);
});
