import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { assertWellFormedGitText } from "../domain/git-text.js";

const PRESERVED_VARIABLES = [
  "HOME", "PATH", "USER", "LOGNAME", "TMPDIR", "LANG", "SSH_AUTH_SOCK",
  "XDG_CONFIG_HOME", "XDG_RUNTIME_DIR",
] as const;

const FIXED_VARIABLES: NodeJS.ProcessEnv = {
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "Never",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_EDITOR: ":",
  GIT_OPTIONAL_LOCKS: "0",
};

export function createGitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};

  for (const name of PRESERVED_VARIABLES) {
    if (source[name] !== undefined) environment[name] = source[name];
  }
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith("LC_") && value !== undefined) environment[name] = value;
  }

  return { ...environment, ...FIXED_VARIABLES };
}

export async function resolveGitExecutable(pathValue = process.env.PATH): Promise<string> {
  if (!pathValue) throw new Error("PATH must not be empty");

  for (const directory of pathValue.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) {
      throw new Error("PATH entries must be absolute and non-empty");
    }
    assertWellFormedGitText(directory, "PATH entry");
    const candidate = assertWellFormedGitText(join(directory, "git"), "Git executable candidate");
    try {
      await access(candidate, constants.X_OK);
      if ((await stat(candidate)).isFile()) {
        return assertWellFormedGitText(await realpath(candidate), "Git executable path");
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "EACCES" && code !== "ENOTDIR") {
        throw error;
      }
    }
  }

  throw new Error("Git executable not found in PATH");
}
