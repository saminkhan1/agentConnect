const SENSITIVE_KEYS = new Set(['number', 'cvc', 'cvv', 'cvv2', 'pan', 'card_number', 'secret']);

/** Shallow-redact known-sensitive fields before logging. Never mutates the original. */
export function redactSensitive(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = SENSITIVE_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : value;
  }
  return result;
}
