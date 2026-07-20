const DEFAULT_MAX_DIAGNOSTIC_BYTES = 16 * 1024;

function redactUrlUserinfo(value: string): string {
  return value.replace(/[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      if (url.username === "" && url.password === "") {
        return candidate;
      }
      url.username = "";
      url.password = "";
      return url.toString();
    } catch {
      return candidate;
    }
  });
}

function capUtf8(value: string, maxBytes: number): string {
  let capped = "";
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) {
      break;
    }
    capped += character;
    bytes += characterBytes;
  }
  return capped;
}

export function redactDiagnostic(value: string, maxBytes = DEFAULT_MAX_DIAGNOSTIC_BYTES): string {
  const normalizedMaxBytes = Number.isFinite(maxBytes) ? Math.max(0, Math.floor(maxBytes)) : 0;
  const redacted = redactUrlUserinfo(value).replace(
    /\b(authorization|token|password|secret)\b\s*([:=])\s*("[^"]*"|'[^']*'|(?:bearer\s+)?[^\s]+)/gi,
    "$1$2[REDACTED]",
  );
  return capUtf8(redacted, normalizedMaxBytes);
}
