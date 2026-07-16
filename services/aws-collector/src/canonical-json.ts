function canonicalValue(value: unknown): unknown {
  if (
    value === null || typeof value === "string" || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object") throw new TypeError("Value is not safe JSON");
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("Value is not plain JSON");
  }
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value).sort()) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw new TypeError("Value contains an unsafe JSON key");
    }
    result[key] = canonicalValue((value as Record<string, unknown>)[key]);
  }
  return result;
}

/** RFC 8785-shaped stable JSON for Sutra digests (arrays retain evidence order). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}
