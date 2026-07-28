/**
 * Parses a Trivy JSON report into Sutra findings.
 *
 * Split out from the container entrypoint so it is unit-testable without Docker,
 * a mounted filesystem, or a Trivy binary. The entrypoint does I/O; this module
 * does the interpretation, which is where the mistakes with consequences live.
 *
 * ── THE SECRET-REDACTION RULE ───────────────────────────────────────────────
 * Trivy's secret scanner reports a hit with `Match` and `Code` fields that
 * contain the secret's ACTUAL TEXT — the credential itself, plus several lines
 * of surrounding source. Sutra's privacy policy states that for a detected
 * secret we record its location and type and never its value, and Sutra's whole
 * pitch is that a customer can hand us a disk without handing us its contents.
 *
 * So this parser never copies those fields into a finding, and never falls back
 * to `Match` when a title is missing. `assertNoSecretMaterial` re-checks the
 * finished findings, because "we intended not to copy it" is a weaker guarantee
 * than "nothing that looks like the payload survives the boundary".
 */

export type FindingSeverity = "critical" | "high" | "medium" | "low" | "unknown";

/** Matches the `AgentlessScanFinding` the executor's ScanWorker must return. */
export interface ParsedFinding {
  readonly source: string;
  readonly severity: FindingSeverity;
  readonly title: string;
}

export interface TrivyParseResult {
  readonly findings: readonly ParsedFinding[];
  /**
   * Counts by class, so an operator can tell "the scan found nothing" apart from
   * "the scan produced a report shape we did not understand".
   */
  readonly summary: {
    readonly vulnerabilities: number;
    readonly secrets: number;
    readonly misconfigurations: number;
    readonly unparsableResults: number;
  };
}

/** Trivy severities are upper-case; anything unrecognised degrades to unknown. */
function normalizeSeverity(value: unknown): FindingSeverity {
  switch (typeof value === "string" ? value.toUpperCase() : "") {
    case "CRITICAL": return "critical";
    case "HIGH": return "high";
    case "MEDIUM": return "medium";
    case "LOW": return "low";
    // Trivy also emits NEGLIGIBLE for some distros. It is a real severity, not a
    // parse failure, and mapping it to "low" would overstate it.
    default: return "unknown";
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Field names carrying secret material or raw file content. Checked by name so a
 * future Trivy schema addition has to be reviewed rather than silently copied.
 */
const SECRET_BEARING_FIELDS = ["Match", "Code", "Lines", "Content", "Snippet"] as const;

export function parseTrivyReport(raw: unknown): TrivyParseResult {
  const root = asRecord(raw);
  const results = Array.isArray(root?.Results) ? root.Results : [];
  const findings: ParsedFinding[] = [];
  let vulnerabilities = 0;
  let secrets = 0;
  let misconfigurations = 0;
  let unparsableResults = 0;

  for (const entry of results) {
    const result = asRecord(entry);
    if (result === null) {
      unparsableResults += 1;
      continue;
    }
    // `Target` is a path inside the mounted copy. A path is location, not
    // content, and it is what makes a finding actionable — keep it.
    const target = str(result.Target) ?? "unknown-target";

    for (const item of Array.isArray(result.Vulnerabilities) ? result.Vulnerabilities : []) {
      const vuln = asRecord(item);
      const id = str(vuln?.VulnerabilityID);
      if (vuln === null || id === null) {
        unparsableResults += 1;
        continue;
      }
      const pkg = str(vuln.PkgName);
      const installed = str(vuln.InstalledVersion);
      // Deliberately NOT vuln.Description: it is long, it is upstream prose, and
      // it is not what identifies the finding. The CVE id plus the exact package
      // version is what a remediation decision needs.
      const where = pkg === null ? target : `${pkg}${installed === null ? "" : `@${installed}`}`;
      findings.push({
        source: "trivy-agentless",
        severity: normalizeSeverity(vuln.Severity),
        title: `${id} in ${where}`,
      });
      vulnerabilities += 1;
    }

    for (const item of Array.isArray(result.Secrets) ? result.Secrets : []) {
      const secret = asRecord(item);
      if (secret === null) {
        unparsableResults += 1;
        continue;
      }
      // RuleID is the CLASS of secret ("aws-access-key-id"), which is safe and is
      // exactly what an operator needs. Title is Trivy's human label for the same
      // rule. Neither contains the value. StartLine is a location.
      const rule = str(secret.RuleID) ?? str(secret.Category) ?? "unclassified-secret";
      const line = typeof secret.StartLine === "number" ? secret.StartLine : null;
      findings.push({
        source: "trivy-agentless",
        // A live credential on a disk image is not a "medium".
        severity: "high",
        title: `Exposed secret (${rule}) at ${target}${line === null ? "" : `:${line}`}`,
      });
      secrets += 1;
    }

    for (const item of Array.isArray(result.Misconfigurations) ? result.Misconfigurations : []) {
      const misconfig = asRecord(item);
      const id = str(misconfig?.ID);
      if (misconfig === null || id === null) {
        unparsableResults += 1;
        continue;
      }
      findings.push({
        source: "trivy-agentless",
        severity: normalizeSeverity(misconfig.Severity),
        title: `${id}: ${str(misconfig.Title) ?? "misconfiguration"} at ${target}`,
      });
      misconfigurations += 1;
    }
  }

  const parsed: TrivyParseResult = {
    findings,
    summary: { vulnerabilities, secrets, misconfigurations, unparsableResults },
  };
  assertNoSecretMaterial(raw, parsed.findings);
  return parsed;
}

/**
 * Fails loudly if any secret-bearing value from the report survived into a
 * finding. Refusing to emit is the correct outcome: losing one scan's results is
 * recoverable, leaking a customer's credential into our database is not.
 */
export function assertNoSecretMaterial(raw: unknown, findings: readonly ParsedFinding[]): void {
  const forbidden = new Set<string>();
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    const record = asRecord(value);
    if (record === null) return;
    for (const [key, child] of Object.entries(record)) {
      if ((SECRET_BEARING_FIELDS as readonly string[]).includes(key)) {
        // Short values are things like "true" or a line number and would produce
        // meaningless substring collisions with legitimate titles.
        const text = typeof child === "string" ? child.trim() : "";
        if (text.length >= 8) forbidden.add(text);
      }
      collect(child);
    }
  };
  collect(raw);
  if (forbidden.size === 0) return;

  for (const finding of findings) {
    for (const secret of forbidden) {
      if (finding.title.includes(secret)) {
        throw new Error(
          "agentless-scan-refused: a finding contained secret material from the "
          + "Trivy report; refusing to emit results rather than persist a credential",
        );
      }
    }
  }
}
