export type DigestPreferenceView = {
  enabled: boolean;
  updatedAt: string | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 40 &&
    Number.isFinite(new Date(value).getTime())
  );
}

/** Pull only the two preference fields this overview control may render. */
export function digestPreferenceFrom(
  value: unknown,
): DigestPreferenceView | null {
  const source = record(value);
  if (!source || typeof source.enabled !== "boolean") return null;
  if (source.updatedAt !== null && !validTimestamp(source.updatedAt)) {
    return null;
  }
  return { enabled: source.enabled, updatedAt: source.updatedAt };
}
