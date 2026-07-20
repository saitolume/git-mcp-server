import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));

export interface PackageWorkspace {
  readonly root: string;
  readonly store: string;
  readonly tarballs: string;
  readonly install: string;
  readonly pnpmCommands: string[][];
}

export interface PackedPackage {
  readonly filename: string;
  readonly files: readonly string[];
  readonly tarball: string;
}

export async function createPackageWorkspace(): Promise<PackageWorkspace> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "git-mcp-server-package-")));
  const store = join(root, "store");
  const tarballs = join(root, "tarballs");
  const install = join(root, "install");
  await Promise.all([mkdir(store), mkdir(tarballs), mkdir(install)]);
  return { root, store, tarballs, install, pnpmCommands: [] };
}

export async function removePackageWorkspace(workspace: PackageWorkspace): Promise<void> {
  await rm(workspace.root, { recursive: true, force: true });
}

export function runPnpm(
  workspace: PackageWorkspace,
  args: readonly string[],
  cwd = repositoryRoot,
): string {
  workspace.pnpmCommands.push([...args]);
  return execFileSync("pnpm", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      PNPM_HOME: join(workspace.root, "pnpm-home"),
      XDG_CACHE_HOME: join(workspace.root, "cache"),
      pnpm_config_store_dir: workspace.store,
      CI: "true",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function packPackage(workspace: PackageWorkspace): PackedPackage {
  const packed = JSON.parse(runPnpm(workspace, [
    "--config.ignore-scripts=true", "pack", "--json", "--pack-destination", workspace.tarballs,
  ])) as { filename: string; files: Array<{ path: string }> };
  return {
    filename: basename(packed.filename),
    files: packed.files.map((file) => file.path).sort(),
    tarball: packed.filename,
  };
}

export function tarEntries(tarball: string): readonly string[] {
  const result = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  assert.equal(result.status, 0, `tar inspection failed: ${result.stderr}`);
  return result.stdout.trim().split("\n").filter(Boolean).sort();
}
