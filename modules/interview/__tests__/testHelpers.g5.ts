/**
 * Shim helpers that mirror the `??` / `== null` pattern used by the
 * G.5 edits in production code. Exported here so tests can assert
 * the documented behavior directly.
 *
 * Do not import these from production code — they exist purely for
 * test readability and as a regression anchor if a future refactor
 * reintroduces `||` where `??` / `== null` was used.
 */

export function isNullOrUndefined(v: unknown): boolean {
  return v == null
}

export function preserveZero<T>(value: T | null | undefined, fallback: T): T {
  return (value ?? fallback) as T
}
