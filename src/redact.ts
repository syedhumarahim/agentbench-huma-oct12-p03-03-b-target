const REDACTED = "[REDACTED]";

interface RedactionRule {
  readonly pattern: RegExp;
  readonly replacement: string;
}

const RULES: readonly RedactionRule[] = [
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g, replacement: REDACTED },
  { pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, replacement: REDACTED },
  {
    pattern: /\b(authorization\s*["']?\s*[:=]\s*["']?)(?:(?:bearer|token|basic)\s+)?[^\s"',;]+/gi,
    replacement: `$1${REDACTED}`,
  },
  { pattern: /\b(bearer|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi, replacement: `$1 ${REDACTED}` },
  { pattern: /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, replacement: `$1${REDACTED}@` },
  {
    pattern: /\b(x-github-request-id\s*["']?\s*[:=]\s*["']?)[A-Za-z0-9:._-]+/gi,
    replacement: `$1${REDACTED}`,
  },
];

/**
 * Remove credential material from text that may be shown to an operator or written to disk.
 * `secrets` are exact values (for example the runtime token) that must never survive.
 */
export function redactText(text: string, secrets: readonly string[] = []): string {
  let result = text;
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join(REDACTED);
  }
  for (const rule of RULES) {
    result = result.replace(rule.pattern, rule.replacement);
  }
  return result;
}

/** Redact every string inside a JSON-compatible value. */
export function redactValue(value: unknown, secrets: readonly string[] = []): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, secrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, redactValue(entry, secrets)]),
    );
  }
  return value;
}

/** Collapse a remote error message to a short, single-line, redacted summary. */
export function summarizeRemoteMessage(message: string, secrets: readonly string[] = []): string {
  const singleLine = redactText(message, secrets).replace(/\s+/g, " ").trim();
  return singleLine.length > 160 ? `${singleLine.slice(0, 157)}...` : singleLine;
}
