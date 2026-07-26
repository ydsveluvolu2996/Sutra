/**
 * Pure, deterministic resource-scheduling ADVISOR.
 *
 * The customer pain is concrete: dev/test EC2 and RDS instances are stopped by
 * hand every evening and started every morning, one account at a time. This
 * engine turns that habit into a stated schedule, computes what the schedule
 * would save, and — via `buildResourceScheduleArtifacts` — emits the
 * EventBridge Scheduler + Lambda template the CUSTOMER deploys in their OWN
 * account to enforce it.
 *
 * WHAT SUTRA DOES AND DOES NOT DO (honesty preamble — never soften this):
 * - Sutra's access to a customer account is READ-ONLY by construction: the
 *   trust role (`SutraReadOnlyRole`) grants no `ec2:Start`/`ec2:Stop` and no
 *   `rds:Start`/`rds:Stop` action. Sutra therefore NEVER starts or stops any
 *   resource. This engine is advisory: it says what WOULD be stopped and what
 *   that WOULD save. Enforcement is the generated artefact, applied by the
 *   customer in their own account with their own permissions.
 * - Nothing here calls an AWS API. It is a pure function over the CMDB
 *   snapshot and already-ingested billing lines.
 *
 * Evidence-honesty rules (mirroring finops-k8s-allocation / finops-cur):
 * - The per-resource hourly rate is DERIVED from ingested CUR/FOCUS lines
 *   joined to the resource by a resource-identifying cost-allocation tag. When
 *   that join is not possible the candidate reports `rateAvailable: false` with
 *   a disclosed reason and NO savings number is fabricated.
 * - Money is integer micro-units via BigInt (BigInt(0), never 0n). Currencies
 *   are NEVER summed together; totals are emitted per currency.
 * - Only EC2 instances and stoppable RDS DB instances are candidates. Every
 *   other resource — and every instance with evidence it must stay up — is
 *   listed in `excluded` WITH its reason, never silently dropped.
 * - The clock is INJECTED (`now`); Date.now() is never called here.
 *
 * TIME MATH IS FIXED-OFFSET, NOT DST-AWARE (disclosed, deliberate):
 * - The savings math converts the schedule's local windows using the schedule's
 *   fixed `utcOffsetMinutes`; daylight-saving transitions are NOT modelled, so
 *   in a month containing a transition the computed running hours can differ by
 *   up to one hour from the wall-clock truth.
 * - The GENERATED artefact does not share that limitation: it carries the IANA
 *   timezone as `ScheduleExpressionTimezone`, so AWS applies DST itself.
 */
import type { NormalizedCurLine } from "./finops-cur.ts";
import type { JsonValue, PilotResource } from "./pilot-types.ts";

export const RESOURCE_SCHEDULE_DISCLAIMER =
  "Sutra never starts or stops a resource: the customer trust role is read-only and grants no " +
  "start/stop permission. This is an advisory plan — the savings shown are what the stated schedule " +
  "would save if the customer applies it themselves in their own account using the generated " +
  "template. Savings are derived from ingested billing lines attributed to each resource; where a " +
  "resource's cost is not attributable, the resource is listed with the reason and no figure is " +
  "estimated. Hour math uses the schedule's fixed UTC offset and does not model daylight-saving " +
  "transitions; the generated template carries the IANA timezone, so AWS applies DST when enforcing.";

const MINUTES_PER_DAY = 1_440;
const MINUTES_PER_WEEK = MINUTES_PER_DAY * 7;
const MAX_WINDOWS = 28;
const MICROS = /^-?\d+$/u;
/** IANA-shaped zone name ("UTC", "Europe/London", "America/Argentina/Salta"). */
const TIMEZONE = /^[A-Za-z][A-Za-z0-9+_-]{0,31}(?:\/[A-Za-z0-9+_-]{1,32}){0,2}$/u;

export const WEEKDAY_TOKENS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"] as const;
/** 0 = Sunday … 6 = Saturday, matching Date#getUTCDay and EventBridge day tokens. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** One "the resource may run" window on one weekday, in minutes from local midnight. */
export interface ScheduleWindow {
  readonly weekday: Weekday;
  readonly startMinute: number; // 0..1439
  readonly endMinute: number; // startMinute+1..1440 (1440 == local midnight)
}

export interface ResourceScheduleDefinition {
  /** IANA zone, carried verbatim into the generated artefact. */
  readonly timezone: string;
  /** Fixed offset used for the (deliberately DST-free) hour math. */
  readonly utcOffsetMinutes: number;
  /** Windows during which the resource is allowed to RUN. Outside them it is off. */
  readonly windows: readonly ScheduleWindow[];
  /** Convenience: force Saturday and Sunday fully off regardless of the windows. */
  readonly offAtWeekends: boolean;
}

/** Which resources a schedule covers. A tag key is required — the artefact is tag-scoped. */
export interface ScheduleSelector {
  readonly tagKey: string;
  readonly tagValue?: string;
  /** Optional region allow-list; empty/absent means every collected region. */
  readonly regions?: readonly string[];
}

export type ScheduleKind = "ec2-instance" | "rds-db-instance";

export type RateReason =
  | "cur-not-ingested"
  | "cur-resource-join-key-not-configured"
  | "resource-cost-not-attributed-in-cur"
  | "resource-cost-in-multiple-currencies";

export type ExclusionReason =
  | "unsupported-kind"
  | "not-selected-by-tag"
  | "not-selected-by-region"
  | "already-not-running"
  | "production-environment-tag"
  | "schedule-exempt-tag"
  | "autoscaling-managed"
  | "kubernetes-cluster-node"
  | "spot-instance-not-stoppable"
  | "instance-store-root-not-stoppable"
  | "rds-read-replica-not-stoppable"
  | "rds-aurora-not-individually-stoppable";

export interface ExcludedResource {
  readonly resourceKey: string;
  readonly nativeId: string;
  readonly name: string | null;
  readonly resourceType: string;
  readonly region: string;
  readonly reason: ExclusionReason;
}

export interface ScheduleCandidate {
  readonly resourceKey: string;
  readonly nativeId: string;
  readonly name: string | null;
  readonly kind: ScheduleKind;
  readonly region: string;
  readonly state: string;
  /** false when no billing line could be attributed to this resource. */
  readonly rateAvailable: boolean;
  readonly rateReason: RateReason | null;
  readonly currency: string | null;
  /** Billing-file cost attributed to this resource for the period, micro-units. */
  readonly observedMonthlyMicros: string | null;
  /** observedMonthlyMicros / baseline hours, micro-units, floored. Display only. */
  readonly hourlyRateMicros: string | null;
  readonly savingsMicros: string | null;
  readonly savingsUnits: number | null;
  /**
   * true when the attributed cost provably includes charges that keep accruing
   * while the resource is stopped (RDS storage and backups), so the figure is a
   * ceiling rather than an estimate.
   */
  readonly savingsIsUpperBound: boolean;
  readonly caveats: readonly string[];
}

export interface ScheduleCurrencyTotal {
  readonly currency: string;
  readonly totalSavingsMicros: string;
  readonly totalSavingsUnits: number;
  readonly candidateCount: number;
}

export interface ScheduleTransition {
  readonly action: "start" | "stop";
  readonly hour: number;
  readonly minute: number;
  readonly weekdays: readonly Weekday[];
  /** EventBridge Scheduler cron in the schedule's own timezone. */
  readonly cron: string;
}

export interface ResourceSchedulePlan {
  /** YYYY-MM of the month the hour math covers, in the schedule's local time. */
  readonly month: string;
  readonly daysInMonth: number;
  readonly baselineHoursPerMonth: number;
  readonly runningHoursPerMonth: number;
  readonly stoppedHoursPerMonth: number;
  /** Running minutes for each weekday (index 0 = Sunday) after the windows + weekend rule. */
  readonly runningMinutesByWeekday: readonly number[];
  readonly transitions: readonly ScheduleTransition[];
  readonly candidates: readonly ScheduleCandidate[];
  readonly excluded: readonly ExcludedResource[];
  readonly totalsByCurrency: readonly ScheduleCurrencyTotal[];
  readonly rateNotDerivableCount: number;
  readonly enforcement: "customer-applied";
  readonly disclaimer: string;
  readonly generatedAt: string | null;
}

export interface ResourceSchedulePlanInput {
  readonly schedule: ResourceScheduleDefinition;
  readonly selector: ScheduleSelector;
  readonly resources: readonly PilotResource[];
  /** Ingested CUR/FOCUS lines for ONE billing month; absent means no rate is derivable. */
  readonly curLines?: readonly NormalizedCurLine[];
  /**
   * Tag key on a CUR line whose value equals the resource nativeId (a
   * resource-id cost-allocation tag). Only when supplied is cost joined —
   * mirroring finops-idle-waste-inputs.
   */
  readonly curResourceTagKey?: string;
}

export interface ResourceSchedulePlanOptions {
  /** Injected clock. Required: the engine never reads a clock of its own. */
  readonly now: () => Date;
}

const EC2_TYPES = new Set(["aws.ec2.instance", "ec2.instance"]);
const RDS_TYPES = new Set(["aws.rds.db-instance", "rds.db-instance"]);
const EC2_RUNNING = /^running$/iu;
const RDS_RUNNING = /^available$/iu;
const PRODUCTION_TAG_KEYS = ["Environment", "environment", "env", "Env", "Stage", "stage"];
const PRODUCTION_TAG_VALUES = /^(production|prod|prd|live)$/iu;
const SCHEDULE_EXEMPT_TAG_KEYS = ["sutra:schedule-exempt", "SutraScheduleExempt", "DoNotStop", "do-not-stop"];
const AUTOSCALING_TAG_KEYS = ["aws:autoscaling:groupName", "aws:autoscaling:groupname"];

function toUnits(micros: bigint): number {
  return Number(micros) / 1_000_000;
}

function str(value: JsonValue | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/* -------------------------------------------------------------------------- */
/* Schedule parsing / validation                                              */
/* -------------------------------------------------------------------------- */

function isWeekday(value: unknown): value is Weekday {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6;
}

/**
 * Validate + normalize an untrusted schedule shape. Returns null (never throws)
 * when anything is out of contract, so the repository and the route can reject
 * with their own error code.
 */
export function parseScheduleDefinition(value: unknown): ResourceScheduleDefinition | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const timezone = raw.timezone;
  if (typeof timezone !== "string" || !TIMEZONE.test(timezone)) return null;
  const offset = raw.utcOffsetMinutes;
  if (
    typeof offset !== "number" || !Number.isInteger(offset) ||
    offset < -720 || offset > 840 || offset % 15 !== 0
  ) {
    return null;
  }
  if (typeof raw.offAtWeekends !== "boolean") return null;
  if (!Array.isArray(raw.windows) || raw.windows.length === 0 || raw.windows.length > MAX_WINDOWS) return null;
  const windows: ScheduleWindow[] = [];
  for (const entry of raw.windows as readonly unknown[]) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const window = entry as Record<string, unknown>;
    const { weekday, startMinute, endMinute } = window;
    if (!isWeekday(weekday)) return null;
    if (typeof startMinute !== "number" || !Number.isInteger(startMinute)) return null;
    if (typeof endMinute !== "number" || !Number.isInteger(endMinute)) return null;
    if (startMinute < 0 || startMinute >= MINUTES_PER_DAY) return null;
    if (endMinute <= startMinute || endMinute > MINUTES_PER_DAY) return null;
    windows.push({ weekday, startMinute, endMinute });
  }
  // Deterministic ordering so two equivalent schedules serialize identically.
  windows.sort((left, right) =>
    left.weekday - right.weekday || left.startMinute - right.startMinute || left.endMinute - right.endMinute);
  return { timezone, utcOffsetMinutes: offset, windows, offAtWeekends: raw.offAtWeekends };
}

/** Validate + normalize an untrusted selector. Returns null on any breach. */
export function parseScheduleSelector(value: unknown): ScheduleSelector | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const tagKey = raw.tagKey;
  if (typeof tagKey !== "string" || tagKey.length === 0 || tagKey.length > 128) return null;
  const selector: { tagKey: string; tagValue?: string; regions?: readonly string[] } = { tagKey };
  if (raw.tagValue !== undefined && raw.tagValue !== null) {
    if (typeof raw.tagValue !== "string" || raw.tagValue.length === 0 || raw.tagValue.length > 256) return null;
    selector.tagValue = raw.tagValue;
  }
  if (raw.regions !== undefined && raw.regions !== null) {
    if (!Array.isArray(raw.regions) || raw.regions.length > 40) return null;
    const regions: string[] = [];
    for (const region of raw.regions as readonly unknown[]) {
      if (typeof region !== "string" || !/^[a-z0-9-]{3,32}$/u.test(region)) return null;
      regions.push(region);
    }
    if (regions.length > 0) selector.regions = [...new Set(regions)].sort();
  }
  return selector;
}

/* -------------------------------------------------------------------------- */
/* Hour math                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Minute-of-week running bitmap. One byte per minute (10 080 bytes) keeps the
 * overlap, weekend-override, and transition-detection logic exact instead of
 * approximately-merged.
 */
function runningBitmap(schedule: ResourceScheduleDefinition): Uint8Array {
  const bitmap = new Uint8Array(MINUTES_PER_WEEK);
  for (const window of schedule.windows) {
    const base = window.weekday * MINUTES_PER_DAY;
    bitmap.fill(1, base + window.startMinute, base + window.endMinute);
  }
  if (schedule.offAtWeekends) {
    bitmap.fill(0, 0, MINUTES_PER_DAY); // Sunday
    bitmap.fill(0, 6 * MINUTES_PER_DAY, MINUTES_PER_WEEK); // Saturday
  }
  return bitmap;
}

function runningMinutesByWeekday(bitmap: Uint8Array): number[] {
  const perDay: number[] = [];
  for (let day = 0; day < 7; day += 1) {
    let minutes = 0;
    for (let minute = 0; minute < MINUTES_PER_DAY; minute += 1) {
      if (bitmap[day * MINUTES_PER_DAY + minute] === 1) minutes += 1;
    }
    perDay.push(minutes);
  }
  return perDay;
}

/**
 * Off→on and on→off boundaries, read circularly so a window that ends at local
 * midnight and continues into the next day produces no spurious stop/start
 * pair. Boundaries sharing a time-of-day are grouped into one cron expression.
 */
function transitionsFor(bitmap: Uint8Array): ScheduleTransition[] {
  const grouped = new Map<string, { action: "start" | "stop"; hour: number; minute: number; weekdays: Weekday[] }>();
  for (let minuteOfWeek = 0; minuteOfWeek < MINUTES_PER_WEEK; minuteOfWeek += 1) {
    const current = bitmap[minuteOfWeek];
    const previous = bitmap[(minuteOfWeek + MINUTES_PER_WEEK - 1) % MINUTES_PER_WEEK];
    if (current === previous) continue;
    const action: "start" | "stop" = current === 1 ? "start" : "stop";
    const weekday = Math.floor(minuteOfWeek / MINUTES_PER_DAY) as Weekday;
    const minuteOfDay = minuteOfWeek % MINUTES_PER_DAY;
    const hour = Math.floor(minuteOfDay / 60);
    const minute = minuteOfDay % 60;
    const key = `${action}-${hour}-${minute}`;
    const existing = grouped.get(key);
    if (existing === undefined) grouped.set(key, { action, hour, minute, weekdays: [weekday] });
    else if (!existing.weekdays.includes(weekday)) existing.weekdays.push(weekday);
  }
  return [...grouped.values()]
    .map((group) => {
      const weekdays = [...group.weekdays].sort((left, right) => left - right);
      const tokens = weekdays.map((weekday) => WEEKDAY_TOKENS[weekday]).join(",");
      return {
        action: group.action,
        hour: group.hour,
        minute: group.minute,
        weekdays,
        // EventBridge Scheduler cron: minutes hours day-of-month month day-of-week year.
        cron: `cron(${group.minute} ${group.hour} ? * ${tokens} *)`,
      };
    })
    .sort((left, right) =>
      left.hour - right.hour || left.minute - right.minute || left.action.localeCompare(right.action));
}

interface MonthShape {
  readonly month: string;
  readonly daysInMonth: number;
  readonly weekdayOccurrences: readonly number[];
}

/**
 * The calendar month containing `now` as seen through the schedule's fixed
 * offset, plus how many times each weekday occurs in it. Real occurrence counts
 * (not a 30.44-day average) are what make the hour figure defensible.
 */
function monthShape(now: Date, utcOffsetMinutes: number): MonthShape {
  const local = new Date(now.getTime() + utcOffsetMinutes * 60_000);
  const year = local.getUTCFullYear();
  const monthIndex = local.getUTCMonth();
  const daysInMonth = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  const firstWeekday = new Date(Date.UTC(year, monthIndex, 1)).getUTCDay();
  const occurrences = [0, 0, 0, 0, 0, 0, 0];
  for (let day = 0; day < daysInMonth; day += 1) occurrences[(firstWeekday + day) % 7] += 1;
  return {
    month: `${year.toString().padStart(4, "0")}-${(monthIndex + 1).toString().padStart(2, "0")}`,
    daysInMonth,
    weekdayOccurrences: occurrences,
  };
}

/* -------------------------------------------------------------------------- */
/* Rate derivation                                                            */
/* -------------------------------------------------------------------------- */

interface DerivedRate {
  readonly currency: string;
  readonly monthlyMicros: bigint;
}

/**
 * Sum each resource's attributed billing amount by the resource-identifying tag
 * — the same join finops-idle-waste-inputs uses. A resource billed in more than
 * one currency is dropped rather than summed into a fabricated single total.
 */
function attributedCostByResourceId(
  curLines: readonly NormalizedCurLine[],
  tagKey: string,
): Map<string, DerivedRate | "ambiguous-currency"> {
  const byId = new Map<string, Map<string, bigint>>();
  for (const line of curLines) {
    const id = line.tags[tagKey];
    if (id === undefined || id.length === 0 || !MICROS.test(line.amountMicros)) continue;
    const amount = BigInt(line.amountMicros);
    if (amount <= BigInt(0)) continue;
    const perCurrency = byId.get(id) ?? new Map<string, bigint>();
    perCurrency.set(line.currency, (perCurrency.get(line.currency) ?? BigInt(0)) + amount);
    byId.set(id, perCurrency);
  }
  const result = new Map<string, DerivedRate | "ambiguous-currency">();
  for (const [id, perCurrency] of byId) {
    if (perCurrency.size !== 1) {
      result.set(id, "ambiguous-currency");
      continue;
    }
    const [currency, monthlyMicros] = [...perCurrency.entries()][0];
    result.set(id, { currency, monthlyMicros });
  }
  return result;
}

/**
 * Find the cost-allocation tag key whose values are the collected resource ids,
 * so the operator does not have to name it by hand. A key qualifies only when at
 * least one of its values is EXACTLY a collected nativeId; the key matching the
 * most resources wins, ties broken alphabetically for determinism. Returns null
 * when no key matches — the caller then discloses "cost not attributed" rather
 * than joining on a guess.
 */
export function detectCurResourceTagKey(
  curLines: readonly NormalizedCurLine[],
  resources: readonly PilotResource[],
): string | null {
  const ids = new Set(resources.map((resource) => resource.nativeId));
  if (ids.size === 0) return null;
  const matchedByKey = new Map<string, Set<string>>();
  for (const line of curLines) {
    for (const [key, value] of Object.entries(line.tags)) {
      if (!ids.has(value)) continue;
      const matched = matchedByKey.get(key) ?? new Set<string>();
      matched.add(value);
      matchedByKey.set(key, matched);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [key, matched] of [...matchedByKey.entries()].sort((left, right) => left[0].localeCompare(right[0]))) {
    if (matched.size > bestCount) {
      best = key;
      bestCount = matched.size;
    }
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* Candidacy                                                                  */
/* -------------------------------------------------------------------------- */

function tagValueFor(resource: PilotResource, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = resource.tags[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function selectedByTag(resource: PilotResource, selector: ScheduleSelector): boolean {
  const value = resource.tags[selector.tagKey];
  if (typeof value !== "string" || value.length === 0) return false;
  return selector.tagValue === undefined || value === selector.tagValue;
}

function kindFor(resource: PilotResource): ScheduleKind | null {
  if (EC2_TYPES.has(resource.resourceType)) return "ec2-instance";
  if (RDS_TYPES.has(resource.resourceType)) return "rds-db-instance";
  return null;
}

/**
 * Conservative exclusion. Every reason is a documented AWS fact or an operator
 * signal, and the reason travels with the resource so nothing looks "missing".
 */
function exclusionFor(
  resource: PilotResource,
  kind: ScheduleKind,
  selector: ScheduleSelector,
): ExclusionReason | null {
  if (selector.regions !== undefined && !selector.regions.includes(resource.region)) return "not-selected-by-region";
  if (!selectedByTag(resource, selector)) return "not-selected-by-tag";
  if (tagValueFor(resource, SCHEDULE_EXEMPT_TAG_KEYS) !== null) return "schedule-exempt-tag";
  const environment = tagValueFor(resource, PRODUCTION_TAG_KEYS);
  if (environment !== null && PRODUCTION_TAG_VALUES.test(environment)) return "production-environment-tag";
  if (tagValueFor(resource, AUTOSCALING_TAG_KEYS) !== null) return "autoscaling-managed";
  for (const key of Object.keys(resource.tags)) {
    // An ASG/EKS-owned node is replaced after a stop, so a schedule is unsafe.
    if (key.startsWith("kubernetes.io/cluster/") || key.startsWith("eks:")) return "kubernetes-cluster-node";
  }
  if (kind === "ec2-instance") {
    const lifecycle = str(resource.configuration.instanceLifecycle);
    if (lifecycle !== null && /spot/iu.test(lifecycle)) return "spot-instance-not-stoppable";
    const rootDevice = str(resource.configuration.rootDeviceType);
    if (rootDevice !== null && /instance-store/iu.test(rootDevice)) return "instance-store-root-not-stoppable";
    if (!EC2_RUNNING.test(resource.state)) return "already-not-running";
    return null;
  }
  const replicaSource = str(resource.configuration.readReplicaSourceDBInstanceIdentifier)
    ?? str(resource.configuration.readReplicaSourceIdentifier);
  if (replicaSource !== null) return "rds-read-replica-not-stoppable";
  const engine = str(resource.configuration.engine);
  if (engine !== null && /^aurora/iu.test(engine)) return "rds-aurora-not-individually-stoppable";
  if (!RDS_RUNNING.test(resource.state)) return "already-not-running";
  return null;
}

function caveatsFor(kind: ScheduleKind, stoppedHoursPerLongestGap: number): string[] {
  if (kind === "ec2-instance") {
    return [
      "Attached EBS volumes and Elastic IPs keep billing while the instance is stopped; they are " +
      "separate CMDB resources and are not part of this figure.",
    ];
  }
  const caveats = [
    "RDS keeps charging for allocated storage, snapshots, and backups while a DB instance is " +
    "stopped, and those charges are inside the cost attributed to this instance — so this figure " +
    "is a ceiling, not an estimate.",
  ];
  if (stoppedHoursPerLongestGap > 7 * 24) {
    caveats.push(
      "AWS restarts a stopped RDS DB instance automatically after 7 days; this schedule has an " +
      "off period longer than that, so the instance will come back on its own.",
    );
  }
  return caveats;
}

/** Longest contiguous off stretch in the week, in hours (read circularly). */
function longestOffHours(bitmap: Uint8Array): number {
  let allOff = true;
  for (let minute = 0; minute < MINUTES_PER_WEEK; minute += 1) {
    if (bitmap[minute] === 1) { allOff = false; break; }
  }
  if (allOff) return MINUTES_PER_WEEK / 60;
  let longest = 0;
  let current = 0;
  // Two laps so a stretch that wraps the week boundary is measured whole.
  for (let index = 0; index < MINUTES_PER_WEEK * 2; index += 1) {
    if (bitmap[index % MINUTES_PER_WEEK] === 0) {
      current += 1;
      if (current > longest) longest = current;
    } else current = 0;
  }
  return Math.min(longest, MINUTES_PER_WEEK) / 60;
}

/**
 * Plan a schedule: candidacy, exclusions with reasons, and per-resource savings.
 *
 * SAVINGS FORMULA (the whole claim, in one line):
 *   savingsMicros = floor(attributedMonthlyMicros × stoppedMinutesPerMonth ÷ baselineMinutesPerMonth)
 * where attributedMonthlyMicros is the billing-file cost joined to the resource,
 * baselineMinutesPerMonth = daysInMonth × 1440 (the resource billed as always-on),
 * and stoppedMinutesPerMonth = baselineMinutesPerMonth − Σ weekdayOccurrences[d] × runningMinutes[d].
 * That is exactly "derived hourly rate × hours-not-running", carried out in
 * integer micro-units so the rate is never rounded twice.
 */
export function planResourceSchedule(
  input: ResourceSchedulePlanInput,
  options: ResourceSchedulePlanOptions,
): ResourceSchedulePlan {
  const { schedule, selector } = input;
  const bitmap = runningBitmap(schedule);
  const perWeekday = runningMinutesByWeekday(bitmap);
  const now = options.now();
  const shape = monthShape(now, schedule.utcOffsetMinutes);
  const baselineMinutes = shape.daysInMonth * MINUTES_PER_DAY;
  let runningMinutes = 0;
  for (let weekday = 0; weekday < 7; weekday += 1) {
    runningMinutes += shape.weekdayOccurrences[weekday] * perWeekday[weekday];
  }
  const stoppedMinutes = baselineMinutes - runningMinutes;
  const baselineMinutesBig = BigInt(baselineMinutes);
  const stoppedMinutesBig = BigInt(stoppedMinutes);
  const baselineHoursBig = BigInt(shape.daysInMonth * 24);
  const offHours = longestOffHours(bitmap);

  const joinKey = input.curResourceTagKey;
  const lines = input.curLines ?? [];
  const attributed = joinKey === undefined || joinKey.length === 0 || lines.length === 0
    ? new Map<string, DerivedRate | "ambiguous-currency">()
    : attributedCostByResourceId(lines, joinKey);
  const missingRateReason: RateReason = lines.length === 0
    ? "cur-not-ingested"
    : joinKey === undefined || joinKey.length === 0
      ? "cur-resource-join-key-not-configured"
      : "resource-cost-not-attributed-in-cur";

  const candidates: ScheduleCandidate[] = [];
  const excluded: ExcludedResource[] = [];
  const totals = new Map<string, { micros: bigint; count: number }>();
  let rateNotDerivableCount = 0;

  for (const resource of input.resources) {
    const kind = kindFor(resource);
    if (kind === null) {
      // Only report unsupported kinds that the operator actually selected;
      // otherwise every VPC and subnet in the snapshot would be listed.
      if (selectedByTag(resource, selector)) {
        excluded.push({
          resourceKey: resource.resourceKey,
          nativeId: resource.nativeId,
          name: resource.name,
          resourceType: resource.resourceType,
          region: resource.region,
          reason: "unsupported-kind",
        });
      }
      continue;
    }
    const exclusion = exclusionFor(resource, kind, selector);
    if (exclusion !== null) {
      // Resources the selector never covered are not "excluded" news either.
      if (exclusion !== "not-selected-by-tag" && exclusion !== "not-selected-by-region") {
        excluded.push({
          resourceKey: resource.resourceKey,
          nativeId: resource.nativeId,
          name: resource.name,
          resourceType: resource.resourceType,
          region: resource.region,
          reason: exclusion,
        });
      }
      continue;
    }
    const derived = attributed.get(resource.nativeId);
    if (derived === undefined || derived === "ambiguous-currency") {
      rateNotDerivableCount += 1;
      candidates.push({
        resourceKey: resource.resourceKey,
        nativeId: resource.nativeId,
        name: resource.name,
        kind,
        region: resource.region,
        state: resource.state,
        rateAvailable: false,
        rateReason: derived === "ambiguous-currency" ? "resource-cost-in-multiple-currencies" : missingRateReason,
        currency: null,
        observedMonthlyMicros: null,
        hourlyRateMicros: null,
        savingsMicros: null,
        savingsUnits: null,
        savingsIsUpperBound: false,
        caveats: caveatsFor(kind, offHours),
      });
      continue;
    }
    const savings = (derived.monthlyMicros * stoppedMinutesBig) / baselineMinutesBig;
    const hourly = derived.monthlyMicros / baselineHoursBig;
    candidates.push({
      resourceKey: resource.resourceKey,
      nativeId: resource.nativeId,
      name: resource.name,
      kind,
      region: resource.region,
      state: resource.state,
      rateAvailable: true,
      rateReason: null,
      currency: derived.currency,
      observedMonthlyMicros: derived.monthlyMicros.toString(),
      hourlyRateMicros: hourly.toString(),
      savingsMicros: savings.toString(),
      savingsUnits: toUnits(savings),
      savingsIsUpperBound: kind === "rds-db-instance",
      caveats: caveatsFor(kind, offHours),
    });
    const bucket = totals.get(derived.currency) ?? { micros: BigInt(0), count: 0 };
    totals.set(derived.currency, { micros: bucket.micros + savings, count: bucket.count + 1 });
  }

  candidates.sort((left, right) => {
    const leftSavings = left.savingsMicros === null ? BigInt(-1) : BigInt(left.savingsMicros);
    const rightSavings = right.savingsMicros === null ? BigInt(-1) : BigInt(right.savingsMicros);
    if (leftSavings !== rightSavings) return rightSavings > leftSavings ? 1 : -1;
    return left.nativeId.localeCompare(right.nativeId);
  });
  excluded.sort((left, right) => left.reason.localeCompare(right.reason) || left.nativeId.localeCompare(right.nativeId));

  return {
    month: shape.month,
    daysInMonth: shape.daysInMonth,
    baselineHoursPerMonth: baselineMinutes / 60,
    runningHoursPerMonth: runningMinutes / 60,
    stoppedHoursPerMonth: stoppedMinutes / 60,
    runningMinutesByWeekday: perWeekday,
    transitions: transitionsFor(bitmap),
    candidates,
    excluded,
    totalsByCurrency: [...totals.entries()]
      .map(([currency, bucket]) => ({
        currency,
        totalSavingsMicros: bucket.micros.toString(),
        totalSavingsUnits: toUnits(bucket.micros),
        candidateCount: bucket.count,
      }))
      .sort((left, right) => left.currency.localeCompare(right.currency)),
    rateNotDerivableCount,
    enforcement: "customer-applied",
    disclaimer: RESOURCE_SCHEDULE_DISCLAIMER,
    generatedAt: now.toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Customer-applied artefact                                                  */
/* -------------------------------------------------------------------------- */

export interface ResourceScheduleArtifactInput {
  readonly scheduleName: string;
  readonly schedule: ResourceScheduleDefinition;
  readonly selector: ScheduleSelector;
  /** Whether the generated automation covers EC2, RDS, or both. */
  readonly includeEc2?: boolean;
  readonly includeRds?: boolean;
}

export interface ResourceScheduleArtifacts {
  readonly cloudFormationYaml: string;
  readonly terraformHcl: string;
  readonly transitions: readonly ScheduleTransition[];
  /** The exact IAM actions the CUSTOMER's own automation role receives. */
  readonly grantedActions: readonly string[];
  readonly readOnlyNotice: string;
}

const ARTIFACT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/u;

export const RESOURCE_SCHEDULE_READ_ONLY_NOTICE =
  "This template is deployed by YOU, in YOUR account, and the start/stop permissions below belong " +
  "to a role YOU own. Sutra's connection role stays read-only and is not referenced anywhere in " +
  "this template — Sutra cannot start or stop your resources before or after you apply it.";

function logicalName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9]/gu, " ")
    .split(" ")
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
  return cleaned.length === 0 ? "SutraSchedule" : cleaned.slice(0, 48);
}

function yamlQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * The inline handler. It is written once and shared by both artefacts so the
 * CloudFormation and Terraform outputs enforce identical behaviour. It filters
 * strictly by the schedule's tag, and it treats "already in the desired state"
 * as success so a retry is harmless.
 */
function handlerSource(selector: ScheduleSelector, includeEc2: boolean, includeRds: boolean): string {
  const tagValueLine = selector.tagValue === undefined
    ? "TAG_VALUE = None  # any non-empty value of TAG_KEY matches"
    : `TAG_VALUE = ${JSON.stringify(selector.tagValue)}`;
  return `import os
import boto3

TAG_KEY = ${JSON.stringify(selector.tagKey)}
${tagValueLine}
INCLUDE_EC2 = ${includeEc2 ? "True" : "False"}
INCLUDE_RDS = ${includeRds ? "True" : "False"}


def _matches(tags):
    for tag in tags or []:
        key = tag.get("Key") or tag.get("key")
        value = tag.get("Value") or tag.get("value")
        if key != TAG_KEY:
            continue
        if TAG_VALUE is None:
            return bool(value)
        return value == TAG_VALUE
    return False


def _ec2(action, region):
    client = boto3.client("ec2", region_name=region)
    ids = []
    paginator = client.get_paginator("describe_instances")
    filters = [{"Name": "tag-key", "Values": [TAG_KEY]}]
    if TAG_VALUE is not None:
        filters = [{"Name": "tag:" + TAG_KEY, "Values": [TAG_VALUE]}]
    for page in paginator.paginate(Filters=filters):
        for reservation in page.get("Reservations", []):
            for instance in reservation.get("Instances", []):
                state = instance.get("State", {}).get("Name")
                if action == "stop" and state == "running":
                    ids.append(instance["InstanceId"])
                if action == "start" and state == "stopped":
                    ids.append(instance["InstanceId"])
    if not ids:
        return []
    if action == "stop":
        client.stop_instances(InstanceIds=ids)
    else:
        client.start_instances(InstanceIds=ids)
    return ids


def _rds(action, region):
    client = boto3.client("rds", region_name=region)
    touched = []
    for page in client.get_paginator("describe_db_instances").paginate():
        for database in page.get("DBInstances", []):
            if database.get("ReadReplicaSourceDBInstanceIdentifier"):
                continue
            if (database.get("Engine") or "").startswith("aurora"):
                continue
            arn = database.get("DBInstanceArn")
            tags = client.list_tags_for_resource(ResourceName=arn).get("TagList", [])
            if not _matches(tags):
                continue
            status = database.get("DBInstanceStatus")
            identifier = database["DBInstanceIdentifier"]
            if action == "stop" and status == "available":
                client.stop_db_instance(DBInstanceIdentifier=identifier)
                touched.append(identifier)
            if action == "start" and status == "stopped":
                client.start_db_instance(DBInstanceIdentifier=identifier)
                touched.append(identifier)
    return touched


def handler(event, _context):
    action = (event or {}).get("action")
    if action not in ("start", "stop"):
        raise ValueError("event.action must be 'start' or 'stop'")
    region = os.environ["AWS_REGION"]
    result = {"action": action, "region": region, "ec2": [], "rds": []}
    if INCLUDE_EC2:
        result["ec2"] = _ec2(action, region)
    if INCLUDE_RDS:
        result["rds"] = _rds(action, region)
    return result
`;
}

function grantedActionsFor(includeEc2: boolean, includeRds: boolean): string[] {
  const actions: string[] = [];
  if (includeEc2) actions.push("ec2:DescribeInstances", "ec2:StartInstances", "ec2:StopInstances");
  if (includeRds) {
    actions.push(
      "rds:DescribeDBInstances",
      "rds:ListTagsForResource",
      "rds:StartDBInstance",
      "rds:StopDBInstance",
    );
  }
  return actions;
}

function indentBlock(source: string, indentation: string): string {
  return source.split("\n").map((line) => (line.length === 0 ? "" : `${indentation}${line}`)).join("\n");
}

/** A transition carrying the zone label used in the generated descriptions. */
interface LabelledTransition extends ScheduleTransition {
  readonly timezoneLabel: string;
}

function buildCloudFormation(
  input: ResourceScheduleArtifactInput,
  transitions: readonly LabelledTransition[],
  includeEc2: boolean,
  includeRds: boolean,
): string {
  const base = logicalName(input.scheduleName);
  const actions = grantedActionsFor(includeEc2, includeRds);
  const schedules = transitions.map((transition, index) => {
    const name = `${base}${transition.action === "start" ? "Start" : "Stop"}${index}`;
    return `  ${name}:
    Type: AWS::Scheduler::Schedule
    Properties:
      Name: !Sub '\${AWS::StackName}-${transition.action}-${index}'
      Description: ${yamlQuote(`Sutra-advised ${transition.action} at ${String(transition.hour).padStart(2, "0")}:${String(transition.minute).padStart(2, "0")} ${transition.timezoneLabel}`)}
      ScheduleExpression: ${yamlQuote(transition.cron)}
      ScheduleExpressionTimezone: ${yamlQuote(input.schedule.timezone)}
      FlexibleTimeWindow:
        Mode: 'OFF'
      State: ENABLED
      Target:
        Arn: !GetAtt SchedulerFunction.Arn
        RoleArn: !GetAtt SchedulerInvokeRole.Arn
        Input: '{"action":"${transition.action}"}'`;
  }).join("\n\n");
  return `AWSTemplateFormatVersion: '2010-09-09'
Description: >-
  Customer-applied resource schedule advised by Sutra (${input.scheduleName}).
  Sutra's own connection role is read-only and is NOT referenced by this stack;
  the start/stop permissions below belong to a role in THIS account, created and
  owned by the account holder who deploys this template.
  Scope: resources tagged ${input.selector.tagKey}${input.selector.tagValue === undefined ? " (any value)" : `=${input.selector.tagValue}`}.
  Timezone: ${input.schedule.timezone} (AWS applies daylight saving for this zone).

Resources:
  SchedulerFunctionRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: lambda.amazonaws.com
            Action: sts:AssumeRole
      ManagedPolicyArns:
        - !Sub 'arn:\${AWS::Partition}:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole'
      Policies:
        - PolicyName: SutraAdvisedScheduleActions
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Sid: ScheduleTaggedInstances
                Effect: Allow
                Action:
${actions.map((action) => `                  - ${yamlQuote(action)}`).join("\n")}
                Resource: '*'
      Tags:
        - Key: 'sutra:advised-schedule'
          Value: ${yamlQuote(input.scheduleName)}
        - Key: 'sutra:managed-by'
          Value: customer

  SchedulerFunction:
    Type: AWS::Lambda::Function
    Properties:
      Description: Starts and stops tagged EC2/RDS instances on the advised schedule.
      Handler: index.handler
      Role: !GetAtt SchedulerFunctionRole.Arn
      Runtime: python3.12
      Timeout: 300
      Code:
        ZipFile: |
${indentBlock(handlerSource(input.selector, includeEc2, includeRds), "          ")}

  SchedulerInvokeRole:
    Type: AWS::IAM::Role
    Properties:
      AssumeRolePolicyDocument:
        Version: '2012-10-17'
        Statement:
          - Effect: Allow
            Principal:
              Service: scheduler.amazonaws.com
            Action: sts:AssumeRole
            Condition:
              StringEquals:
                'aws:SourceAccount': !Ref 'AWS::AccountId'
      Policies:
        - PolicyName: InvokeScheduleFunction
          PolicyDocument:
            Version: '2012-10-17'
            Statement:
              - Effect: Allow
                Action: lambda:InvokeFunction
                Resource: !GetAtt SchedulerFunction.Arn

${schedules}

Outputs:
  ScheduleFunctionArn:
    Description: Function this account invokes on the advised schedule. Sutra never invokes it.
    Value: !GetAtt SchedulerFunction.Arn
  ScheduledTransitionCount:
    Description: Number of start/stop transitions created from the advised schedule.
    Value: '${transitions.length}'
`;
}

function buildTerraform(
  input: ResourceScheduleArtifactInput,
  transitions: readonly ScheduleTransition[],
  includeEc2: boolean,
  includeRds: boolean,
): string {
  const actions = grantedActionsFor(includeEc2, includeRds);
  const schedules = transitions.map((transition, index) => `resource "aws_scheduler_schedule" "sutra_${transition.action}_${index}" {
  name                         = "\${var.name_prefix}-${transition.action}-${index}"
  description                  = ${JSON.stringify(`Sutra-advised ${transition.action} at ${String(transition.hour).padStart(2, "0")}:${String(transition.minute).padStart(2, "0")}`)}
  schedule_expression          = ${JSON.stringify(transition.cron)}
  schedule_expression_timezone = ${JSON.stringify(input.schedule.timezone)}

  flexible_time_window {
    mode = "OFF"
  }

  target {
    arn      = aws_lambda_function.sutra_scheduler.arn
    role_arn = aws_iam_role.sutra_scheduler_invoke.arn
    input    = jsonencode({ action = "${transition.action}" })
  }
}`).join("\n\n");
  return `# Customer-applied resource schedule advised by Sutra (${input.scheduleName}).
#
# Sutra's connection role is read-only and is NOT referenced in this file. The
# start/stop permissions below belong to a role in YOUR account, created by YOU
# when you apply this configuration. Sutra cannot start or stop your resources.
#
# Scope:    resources tagged ${input.selector.tagKey}${input.selector.tagValue === undefined ? " (any value)" : `=${input.selector.tagValue}`}
# Timezone: ${input.schedule.timezone} (AWS applies daylight saving for this zone)

terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0, < 7.0"
    }
    # Packages the inline handler below; no code is fetched from anywhere.
    archive = {
      source  = "hashicorp/archive"
      version = ">= 2.4"
    }
  }
}

variable "name_prefix" {
  description = "Prefix for the created schedule names."
  type        = string
  default     = ${JSON.stringify(logicalName(input.scheduleName).toLowerCase())}
}

data "aws_caller_identity" "current" {}

resource "aws_iam_role" "sutra_scheduler" {
  name               = "\${var.name_prefix}-scheduler"
  description        = "Customer-owned role that starts and stops tagged instances on the Sutra-advised schedule"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })

  tags = {
    "sutra:advised-schedule" = ${JSON.stringify(input.scheduleName)}
    "sutra:managed-by"       = "customer"
  }
}

resource "aws_iam_role_policy_attachment" "sutra_scheduler_basic" {
  role       = aws_iam_role.sutra_scheduler.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "sutra_scheduler_actions" {
  name   = "sutra-advised-schedule-actions"
  role   = aws_iam_role.sutra_scheduler.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid      = "ScheduleTaggedInstances"
      Effect   = "Allow"
      Action   = ${JSON.stringify(actions)}
      Resource = "*"
    }]
  })
}

data "archive_file" "sutra_scheduler" {
  type        = "zip"
  output_path = "\${path.module}/sutra-scheduler.zip"

  source {
    filename = "index.py"
    content  = <<-PYTHON
${indentBlock(handlerSource(input.selector, includeEc2, includeRds), "    ")}
    PYTHON
  }
}

resource "aws_lambda_function" "sutra_scheduler" {
  function_name    = "\${var.name_prefix}-scheduler"
  description      = "Starts and stops tagged EC2/RDS instances on the Sutra-advised schedule"
  role             = aws_iam_role.sutra_scheduler.arn
  handler          = "index.handler"
  runtime          = "python3.12"
  timeout          = 300
  filename         = data.archive_file.sutra_scheduler.output_path
  source_code_hash = data.archive_file.sutra_scheduler.output_base64sha256
}

resource "aws_iam_role" "sutra_scheduler_invoke" {
  name               = "\${var.name_prefix}-scheduler-invoke"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "scheduler.amazonaws.com" }
      Action    = "sts:AssumeRole"
      Condition = {
        StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }
      }
    }]
  })
}

resource "aws_iam_role_policy" "sutra_scheduler_invoke" {
  name   = "invoke-schedule-function"
  role   = aws_iam_role.sutra_scheduler_invoke.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect   = "Allow"
      Action   = "lambda:InvokeFunction"
      Resource = aws_lambda_function.sutra_scheduler.arn
    }]
  })
}

${schedules}
`;
}

/**
 * Build the artefacts the CUSTOMER applies. Nothing here is executed by Sutra
 * and nothing here references a Sutra principal: the created role, function,
 * and schedules live entirely in the customer's account.
 */
export function buildResourceScheduleArtifacts(
  input: ResourceScheduleArtifactInput,
): ResourceScheduleArtifacts {
  if (!ARTIFACT_NAME.test(input.scheduleName)) {
    throw new Error("Schedule name must be 1–64 characters of letters, numbers, spaces, dots, underscores, or hyphens.");
  }
  const includeEc2 = input.includeEc2 !== false;
  const includeRds = input.includeRds !== false;
  if (!includeEc2 && !includeRds) {
    throw new Error("A generated schedule must cover EC2 instances, RDS DB instances, or both.");
  }
  const bitmap = runningBitmap(input.schedule);
  const plain = transitionsFor(bitmap);
  if (plain.length === 0) {
    throw new Error("This schedule never changes state, so there is nothing to automate.");
  }
  const labelled = plain.map((transition) => ({ ...transition, timezoneLabel: input.schedule.timezone }));
  return {
    cloudFormationYaml: buildCloudFormation(input, labelled, includeEc2, includeRds),
    terraformHcl: buildTerraform(input, labelled, includeEc2, includeRds),
    transitions: plain,
    grantedActions: grantedActionsFor(includeEc2, includeRds),
    readOnlyNotice: RESOURCE_SCHEDULE_READ_ONLY_NOTICE,
  };
}

/**
 * The habit this feature replaces: off overnight and all weekend. Windows are
 * emitted for Monday–Friday only; the weekend flag keeps Saturday and Sunday off
 * even if a window is later added to them.
 */
export function weekdayBusinessHoursSchedule(
  timezone: string,
  utcOffsetMinutes: number,
  startMinute = 8 * 60,
  endMinute = 20 * 60,
): ResourceScheduleDefinition {
  const windows: ScheduleWindow[] = [];
  for (const weekday of [1, 2, 3, 4, 5] as const) windows.push({ weekday, startMinute, endMinute });
  return { timezone, utcOffsetMinutes, windows, offAtWeekends: true };
}
