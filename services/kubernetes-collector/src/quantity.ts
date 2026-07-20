/**
 * Pure Kubernetes `resource.Quantity` parser.
 *
 * Kubernetes serialises CPU/memory quantities as strings such as "500m", "1",
 * "2", "512Mi", "1Gi", "536870912" or "1e9". This module turns those strings
 * into exact integer millicores (CPU) or bytes (memory) so the FinOps
 * allocation engine can weight namespaces by real reserved capacity instead of
 * a mere has-a-request boolean.
 *
 * Suffix rules (matching apimachinery's resource.Quantity):
 * - Binary suffixes are powers of 1024: Ki, Mi, Gi, Ti, Pi, Ei.
 * - Decimal SI suffixes are powers of 1000: n (1e-9), u (1e-6), m (1e-3),
 *   k (1e3), M (1e6), G (1e9), T (1e12), P (1e15), E (1e18).
 * - Scientific notation ("1e9", "1.5E6") is honoured inside the number itself;
 *   a bare lowercase "e" is NEVER a suffix, so malformed values like "1e" stay
 *   garbage and return null.
 * - A trailing suffix letter is only consumed when the remaining text is itself
 *   a complete number, so "1E3" parses as scientific 1000, while "1E" parses as
 *   1 exa. Anything that does not resolve to a finite number returns null.
 *
 * Nothing is invented: an unparseable, empty or non-string/number input yields
 * null, and the request-specific helpers additionally reject negative values.
 */

const BINARY_SUFFIX: Readonly<Record<string, number>> = Object.freeze({
  Ki: 1024,
  Mi: 1024 ** 2,
  Gi: 1024 ** 3,
  Ti: 1024 ** 4,
  Pi: 1024 ** 5,
  Ei: 1024 ** 6,
});

const DECIMAL_SUFFIX: Readonly<Record<string, number>> = Object.freeze({
  n: 1e-9,
  u: 1e-6,
  m: 1e-3,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
});

// A signed decimal number with an optional scientific exponent.
const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u;

/**
 * Parse a Kubernetes quantity into its scalar value in base units (unitless for
 * CPU cores, bytes for memory). Returns null for any input that does not
 * resolve to a finite number. The value may be negative or zero when the input
 * is; the request helpers below enforce non-negativity.
 */
export function parseKubernetesQuantity(raw: unknown): number | null {
  const text = typeof raw === "string"
    ? raw.trim()
    : typeof raw === "number" && Number.isFinite(raw)
      ? String(raw)
      : null;
  if (text === null || text.length === 0) return null;

  let numberPart = text;
  let factor = 1;

  // Longest match first: two-character binary suffix (Ki/Mi/Gi/Ti/Pi/Ei).
  const binary = text.length >= 3 ? text.slice(-2) : "";
  if (Object.hasOwn(BINARY_SUFFIX, binary)) {
    numberPart = text.slice(0, -2);
    factor = BINARY_SUFFIX[binary];
  } else {
    // Single-character decimal SI suffix (n/u/m/k/M/G/T/P/E). Only consumed when
    // the remaining text is itself a complete number; otherwise it stays part of
    // numberPart, which then fails NUMBER_RE and returns null.
    const last = text.slice(-1);
    if (text.length >= 2 && Object.hasOwn(DECIMAL_SUFFIX, last)) {
      const candidate = text.slice(0, -1);
      if (NUMBER_RE.test(candidate)) {
        numberPart = candidate;
        factor = DECIMAL_SUFFIX[last];
      }
    }
  }

  if (!NUMBER_RE.test(numberPart)) return null;
  const value = Number(numberPart) * factor;
  return Number.isFinite(value) ? value : null;
}

/**
 * Integer millicores from a CPU quantity ("500m" -> 500, "1" -> 1000,
 * "2" -> 2000). Returns null for unparseable, negative or unsafe-integer values.
 */
export function parseCpuRequestMillicores(raw: unknown): number | null {
  const cores = parseKubernetesQuantity(raw);
  if (cores === null || cores < 0) return null;
  const millicores = Math.round(cores * 1000);
  return Number.isSafeInteger(millicores) ? millicores : null;
}

/**
 * Integer bytes from a memory quantity ("512Mi" -> 536870912, "1Gi" ->
 * 1073741824, "1e9" -> 1000000000). Returns null for unparseable, negative or
 * unsafe-integer values.
 */
export function parseMemoryRequestBytes(raw: unknown): number | null {
  const bytes = parseKubernetesQuantity(raw);
  if (bytes === null || bytes < 0) return null;
  const rounded = Math.round(bytes);
  return Number.isSafeInteger(rounded) ? rounded : null;
}
