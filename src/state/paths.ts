import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { homedir as processHomedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface StatePaths {
  root: string;
  locks: string;
  repositories: string;
  operations: string;
  stages: string;
  fetches: string;
  merges: string;
  audit: string;
}

export interface StatePathOptions {
  platform?: NodeJS.Platform;
  homedir?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

export function resolveStatePaths(options: StatePathOptions = {}): StatePaths {
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? processHomedir();
  const env = options.env ?? process.env;
  if (platform !== "darwin" && platform !== "linux") throw new Error(`Unsupported platform: ${platform}`);
  if (!isAbsolute(home)) throw new Error("Home directory must be absolute");

  let root: string;
  if (platform === "darwin") {
    root = join(home, "Library", "Application Support", "git-mcp-server");
  } else if (platform === "linux") {
    const stateHome = env.XDG_STATE_HOME ?? join(home, ".local", "state");
    if (!isAbsolute(stateHome)) throw new Error("XDG_STATE_HOME must be absolute");
    root = join(stateHome, "git-mcp-server");
  } else throw new Error(`Unsupported platform: ${platform}`);

  return {
    root,
    locks: join(root, "locks"),
    repositories: join(root, "repositories"),
    operations: join(root, "operations"),
    stages: join(root, "stages"),
    fetches: join(root, "fetches"),
    merges: join(root, "merges"),
    audit: join(root, "audit"),
  };
}

export async function initializeStatePaths(paths = resolveStatePaths()): Promise<StatePaths> {
  for (const directory of Object.values(paths)) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink()) {
      throw new Error(`State path is not a real directory: ${directory}`);
    }
    if (typeof process.getuid === "function" && details.uid !== process.getuid()) {
      throw new Error(`State directory is not owned by this user: ${directory}`);
    }
    const handle = await open(directory, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY);
    try {
      const opened = await handle.stat();
      if (!opened.isDirectory() || opened.dev !== details.dev || opened.ino !== details.ino) {
        throw new Error(`State directory changed while opening: ${directory}`);
      }
      if (typeof process.getuid === "function" && opened.uid !== process.getuid()) {
        throw new Error(`State directory is not owned by this user: ${directory}`);
      }
      await handle.chmod(0o700);
    } finally {
      await handle.close();
    }
  }
  return paths;
}
