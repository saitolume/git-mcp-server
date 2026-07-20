import { isWellFormedGitText } from "./git-text.js";

/** Strict full refname validation for the only remote-tracking namespace exposed by the bridge. */
export function validateOriginRemoteRef(value: unknown): string {
  if (typeof value !== "string" || !value.startsWith("refs/remotes/origin/")
    || value.length === "refs/remotes/origin/".length || /[\x00-\x20\x7f~^:?*\[\\]/.test(value)
    || !isWellFormedGitText(value) || value.includes("..") || value.includes("@{") || value.startsWith("/") || value.endsWith("/")
    || value.endsWith(".")) throw new TypeError("origin ref is invalid");
  const components = value.split("/");
  if (components.some((component) => component.length === 0 || component.startsWith(".")
    || component.endsWith(".") || component.endsWith(".lock"))) throw new TypeError("origin ref is invalid");
  return value;
}

export function isOriginRemoteRef(value: string): boolean {
  try {
    validateOriginRemoteRef(value);
    return true;
  } catch {
    return false;
  }
}
