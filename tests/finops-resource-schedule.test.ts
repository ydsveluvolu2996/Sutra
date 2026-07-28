import assert from "node:assert/strict";
import test from "node:test";
import {
  RESOURCE_SCHEDULE_READ_ONLY_NOTICE,
  buildResourceScheduleArtifacts,
  detectCurResourceTagKey,
  parseScheduleDefinition,
  parseScheduleSelector,
  planResourceSchedule,
  weekdayBusinessHoursSchedule,
} from "../lib/finops-resource-schedule.ts";
import type { ResourceScheduleDefinition, ScheduleSelector } from "../lib/finops-resource-schedule.ts";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";
import type { JsonValue, PilotResource } from "../lib/pilot-types.ts";

const micros = (whole: number): string => String(whole * 1_000_000);
// July 2026: 31 days, starts on a Wednesday — 23 weekdays, 8 weekend days.
const JULY_2026 = () => new Date("2026-07-15T12:00:00.000Z");
const SELECTOR: ScheduleSelector = { tagKey: "Environment", tagValue: "development" };

function resource(over: Partial<PilotResource> & { resourceType: string; nativeId: string }): PilotResource {
  return {
    resourceKey: over.resourceKey ?? `aws:1:us-east-1:svc:${over.resourceType}:${over.nativeId}`,
    service: over.service ?? "ec2",
    resourceType: over.resourceType,
    nativeId: over.nativeId,
    arn: over.arn ?? null,
    name: over.name ?? null,
    region: over.region ?? "us-east-1",
    state: over.state ?? "running",
    tags: over.tags ?? { Environment: "development" },
    configuration: (over.configuration ?? {}) as Readonly<Record<string, JsonValue>>,
    source: over.source ?? { api: "ec2:DescribeInstances", accountId: "111122223333", collectedAt: "2026-07-01T00:00:00.000Z" },
    contentSha256: over.contentSha256 ?? "0".repeat(64),
  };
}

function curLine(over: Partial<NormalizedCurLine> & { amountMicros: string; tags: Record<string, string> }): NormalizedCurLine {
  return {
    lineItemId: over.lineItemId ?? "line-1",
    usageAccountId: over.usageAccountId ?? "111122223333",
    service: over.service ?? "AmazonEC2",
    chargeCategory: over.chargeCategory ?? "Usage",
    usageStartIso: over.usageStartIso ?? "2026-07-01T00:00:00.000Z",
    amountMicros: over.amountMicros,
    currency: over.currency ?? "USD",
    region: over.region ?? "us-east-1",
    usageType: over.usageType ?? null,
    usageAmountMicros: over.usageAmountMicros ?? null,
    usageUnit: over.usageUnit ?? null,
    amortizedMicros: over.amortizedMicros ?? null,
    commitmentType: over.commitmentType ?? null,
    commitmentId: over.commitmentId ?? null,
    commitmentExpiry: over.commitmentExpiry ?? null,
    tags: over.tags,
  };
}

/* -------------------------------------------------------------------------- */
/* Hour math                                                                   */
/* -------------------------------------------------------------------------- */

test("weekday 08:00-20:00 with weekends off leaves the documented hours off in July 2026", () => {
  const plan = planResourceSchedule(
    { schedule: weekdayBusinessHoursSchedule("UTC", 0), selector: SELECTOR, resources: [] },
    { now: JULY_2026 },
  );
  // July 2026 starts on a Wednesday: 23 weekdays (Mon-Fri) and 8 weekend days.
  assert.equal(plan.month, "2026-07");
  assert.equal(plan.daysInMonth, 31);
  assert.equal(plan.baselineHoursPerMonth, 31 * 24);
  assert.equal(plan.runningHoursPerMonth, 23 * 12);
  assert.equal(plan.stoppedHoursPerMonth, 31 * 24 - 23 * 12);
  // Saturday and Sunday carry zero running minutes; each weekday carries 12 h.
  assert.deepEqual(plan.runningMinutesByWeekday, [0, 720, 720, 720, 720, 720, 0]);
});

test("per-weekday windows are honoured independently and the weekend flag overrides them", () => {
  const schedule: ResourceScheduleDefinition = {
    timezone: "UTC",
    utcOffsetMinutes: 0,
    offAtWeekends: true,
    windows: [
      { weekday: 1, startMinute: 9 * 60, endMinute: 17 * 60 }, // Mon 8 h
      { weekday: 3, startMinute: 0, endMinute: 1_440 }, // Wed all day
      { weekday: 6, startMinute: 10 * 60, endMinute: 12 * 60 }, // Sat — overridden
    ],
  };
  const plan = planResourceSchedule({ schedule, selector: SELECTOR, resources: [] }, { now: JULY_2026 });
  assert.deepEqual(plan.runningMinutesByWeekday, [0, 480, 0, 1_440, 0, 0, 0]);
  // July 2026 has 4 Mondays and 5 Wednesdays.
  assert.equal(plan.runningHoursPerMonth, 4 * 8 + 5 * 24);
});

test("overlapping windows on one day are counted once, not double-counted", () => {
  const schedule: ResourceScheduleDefinition = {
    timezone: "UTC",
    utcOffsetMinutes: 0,
    offAtWeekends: false,
    windows: [
      { weekday: 2, startMinute: 8 * 60, endMinute: 12 * 60 },
      { weekday: 2, startMinute: 10 * 60, endMinute: 14 * 60 },
    ],
  };
  const plan = planResourceSchedule({ schedule, selector: SELECTOR, resources: [] }, { now: JULY_2026 });
  assert.equal(plan.runningMinutesByWeekday[2], 6 * 60);
});

test("the month is taken from the schedule's fixed offset, and DST is documented as unmodelled", () => {
  // 2026-08-01T00:30Z is still 2026-07-31 in America/Los_Angeles (-08:00).
  const late = () => new Date("2026-08-01T00:30:00.000Z");
  const utc = planResourceSchedule(
    { schedule: weekdayBusinessHoursSchedule("UTC", 0), selector: SELECTOR, resources: [] },
    { now: late },
  );
  const pacific = planResourceSchedule(
    { schedule: weekdayBusinessHoursSchedule("America/Los_Angeles", -480), selector: SELECTOR, resources: [] },
    { now: late },
  );
  assert.equal(utc.month, "2026-08");
  assert.equal(pacific.month, "2026-07");
  // The engine states its own limitation rather than implying DST correctness.
  assert.match(utc.disclaimer, /does not model daylight-saving transitions/u);
  assert.match(utc.disclaimer, /never starts or stops a resource/u);
});

test("a window that runs to local midnight and continues next day produces no stop/start pair", () => {
  const schedule: ResourceScheduleDefinition = {
    timezone: "UTC",
    utcOffsetMinutes: 0,
    offAtWeekends: false,
    windows: [
      { weekday: 1, startMinute: 8 * 60, endMinute: 1_440 },
      { weekday: 2, startMinute: 0, endMinute: 17 * 60 },
    ],
  };
  const plan = planResourceSchedule({ schedule, selector: SELECTOR, resources: [] }, { now: JULY_2026 });
  assert.deepEqual(
    plan.transitions.map((transition) => `${transition.action} ${transition.hour}:${transition.minute}`),
    ["start 8:0", "stop 17:0"],
  );
  assert.equal(plan.transitions[0].cron, "cron(0 8 ? * MON *)");
  assert.equal(plan.transitions[1].cron, "cron(0 17 ? * TUE *)");
});

test("identical weekday boundaries collapse into one cron per action", () => {
  const plan = planResourceSchedule(
    { schedule: weekdayBusinessHoursSchedule("Europe/Berlin", 60), selector: SELECTOR, resources: [] },
    { now: JULY_2026 },
  );
  assert.deepEqual(plan.transitions.map((transition) => transition.cron), [
    "cron(0 8 ? * MON,TUE,WED,THU,FRI *)",
    "cron(0 20 ? * MON,TUE,WED,THU,FRI *)",
  ]);
});

/* -------------------------------------------------------------------------- */
/* Savings math                                                                */
/* -------------------------------------------------------------------------- */

test("savings are the attributed monthly cost scaled by the hours not running", () => {
  const instance = resource({ resourceType: "aws.ec2.instance", nativeId: "i-dev1", name: "dev-1" });
  const plan = planResourceSchedule(
    {
      schedule: weekdayBusinessHoursSchedule("UTC", 0),
      selector: SELECTOR,
      resources: [instance],
      curLines: [curLine({ amountMicros: micros(744), tags: { resourceId: "i-dev1" } })],
      curResourceTagKey: "resourceId",
    },
    { now: JULY_2026 },
  );
  const candidate = plan.candidates[0];
  assert.equal(candidate.rateAvailable, true);
  assert.equal(candidate.observedMonthlyMicros, micros(744));
  // 744 currency units over 744 baseline hours == exactly 1 per hour.
  assert.equal(candidate.hourlyRateMicros, micros(1));
  // 744 - 276 running hours = 468 hours off, at 1/hour.
  assert.equal(plan.stoppedHoursPerMonth, 468);
  assert.equal(candidate.savingsMicros, micros(468));
  assert.equal(candidate.savingsUnits, 468);
  assert.equal(candidate.savingsIsUpperBound, false);
  assert.deepEqual(plan.totalsByCurrency, [
    { currency: "USD", totalSavingsMicros: micros(468), totalSavingsUnits: 468, candidateCount: 1 },
  ]);
});

test("currencies are never summed: two currencies produce two totals", () => {
  const plan = planResourceSchedule(
    {
      schedule: weekdayBusinessHoursSchedule("UTC", 0),
      selector: SELECTOR,
      resources: [
        resource({ resourceType: "aws.ec2.instance", nativeId: "i-usd" }),
        resource({ resourceType: "aws.ec2.instance", nativeId: "i-eur" }),
      ],
      curLines: [
        curLine({ amountMicros: micros(744), tags: { resourceId: "i-usd" } }),
        curLine({ amountMicros: micros(744), currency: "EUR", tags: { resourceId: "i-eur" } }),
      ],
      curResourceTagKey: "resourceId",
    },
    { now: JULY_2026 },
  );
  assert.deepEqual(plan.totalsByCurrency.map((total) => total.currency), ["EUR", "USD"]);
  assert.equal(plan.totalsByCurrency.every((total) => total.totalSavingsUnits === 468), true);
});

test("an RDS candidate's savings are flagged as a ceiling because storage keeps billing", () => {
  const plan = planResourceSchedule(
    {
      schedule: weekdayBusinessHoursSchedule("UTC", 0),
      selector: SELECTOR,
      resources: [resource({
        resourceType: "aws.rds.db-instance",
        nativeId: "dev-db",
        service: "rds",
        state: "available",
        configuration: { engine: "postgres" },
      })],
      curLines: [curLine({ amountMicros: micros(744), service: "AmazonRDS", tags: { resourceId: "dev-db" } })],
      curResourceTagKey: "resourceId",
    },
    { now: JULY_2026 },
  );
  const candidate = plan.candidates[0];
  assert.equal(candidate.kind, "rds-db-instance");
  assert.equal(candidate.savingsIsUpperBound, true);
  assert.equal(candidate.caveats.some((caveat) => /ceiling, not an estimate/u.test(caveat)), true);
});

/* -------------------------------------------------------------------------- */
/* Rate-not-derivable disclosure                                               */
/* -------------------------------------------------------------------------- */

test("no ingested billing lines: the candidate is kept and the reason disclosed, with no number", () => {
  const plan = planResourceSchedule(
    {
      schedule: weekdayBusinessHoursSchedule("UTC", 0),
      selector: SELECTOR,
      resources: [resource({ resourceType: "aws.ec2.instance", nativeId: "i-dev1" })],
    },
    { now: JULY_2026 },
  );
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.rateNotDerivableCount, 1);
  assert.deepEqual(
    [plan.candidates[0].rateAvailable, plan.candidates[0].rateReason, plan.candidates[0].savingsMicros],
    [false, "cur-not-ingested", null],
  );
  assert.deepEqual(plan.totalsByCurrency, []);
});

test("lines exist but no join key is configured: the reason names the missing join key", () => {
  const plan = planResourceSchedule(
    {
      schedule: weekdayBusinessHoursSchedule("UTC", 0),
      selector: SELECTOR,
      resources: [resource({ resourceType: "aws.ec2.instance", nativeId: "i-dev1" })],
      curLines: [curLine({ amountMicros: micros(744), tags: { resourceId: "i-dev1" } })],
    },
    { now: JULY_2026 },
  );
  assert.equal(plan.candidates[0].rateReason, "cur-resource-join-key-not-configured");
});

test("cost attributed in two currencies is disclosed as ambiguous, never summed into one total", () => {
  const plan = planResourceSchedule(
    {
      schedule: weekdayBusinessHoursSchedule("UTC", 0),
      selector: SELECTOR,
      resources: [resource({ resourceType: "aws.ec2.instance", nativeId: "i-dev1" })],
      curLines: [
        curLine({ amountMicros: micros(100), tags: { resourceId: "i-dev1" } }),
        curLine({ amountMicros: micros(100), currency: "GBP", tags: { resourceId: "i-dev1" } }),
      ],
      curResourceTagKey: "resourceId",
    },
    { now: JULY_2026 },
  );
  assert.equal(plan.candidates[0].rateReason, "resource-cost-in-multiple-currencies");
  assert.equal(plan.candidates[0].savingsMicros, null);
  assert.deepEqual(plan.totalsByCurrency, []);
});

test("the resource-id tag key is detected from the data, and null when nothing matches", () => {
  const resources = [resource({ resourceType: "aws.ec2.instance", nativeId: "i-dev1" })];
  assert.equal(
    detectCurResourceTagKey([curLine({ amountMicros: micros(1), tags: { myResourceId: "i-dev1", Team: "core" } })], resources),
    "myResourceId",
  );
  assert.equal(
    detectCurResourceTagKey([curLine({ amountMicros: micros(1), tags: { Team: "core" } })], resources),
    null,
  );
});

/* -------------------------------------------------------------------------- */
/* Exclusions                                                                  */
/* -------------------------------------------------------------------------- */

test("only stoppable EC2/RDS instances are candidates; everything else is excluded with a reason", () => {
  const plan = planResourceSchedule(
    {
      schedule: weekdayBusinessHoursSchedule("UTC", 0),
      selector: { tagKey: "Environment" },
      resources: [
        resource({ resourceType: "aws.ec2.instance", nativeId: "i-ok" }),
        resource({ resourceType: "aws.ec2.volume", nativeId: "vol-1" }),
        resource({ resourceType: "aws.ec2.instance", nativeId: "i-stopped", state: "stopped" }),
        resource({ resourceType: "aws.ec2.instance", nativeId: "i-prod", tags: { Environment: "production" } }),
        resource({ resourceType: "aws.ec2.instance", nativeId: "i-exempt", tags: { Environment: "dev", "sutra:schedule-exempt": "yes" } }),
        resource({ resourceType: "aws.ec2.instance", nativeId: "i-asg", tags: { Environment: "dev", "aws:autoscaling:groupName": "web" } }),
        resource({ resourceType: "aws.ec2.instance", nativeId: "i-eks", tags: { Environment: "dev", "kubernetes.io/cluster/prod": "owned" } }),
        resource({ resourceType: "aws.ec2.instance", nativeId: "i-spot", configuration: { instanceLifecycle: "spot" } }),
        resource({ resourceType: "aws.ec2.instance", nativeId: "i-store", configuration: { rootDeviceType: "instance-store" } }),
        resource({ resourceType: "aws.rds.db-instance", nativeId: "db-replica", state: "available", configuration: { readReplicaSourceDBInstanceIdentifier: "db-main" } }),
        resource({ resourceType: "aws.rds.db-instance", nativeId: "db-aurora", state: "available", configuration: { engine: "aurora-postgresql" } }),
      ],
    },
    { now: JULY_2026 },
  );
  assert.deepEqual(plan.candidates.map((candidate) => candidate.nativeId), ["i-ok"]);
  assert.deepEqual(
    Object.fromEntries(plan.excluded.map((excluded) => [excluded.nativeId, excluded.reason])),
    {
      "vol-1": "unsupported-kind",
      "i-stopped": "already-not-running",
      "i-prod": "production-environment-tag",
      "i-exempt": "schedule-exempt-tag",
      "i-asg": "autoscaling-managed",
      "i-eks": "kubernetes-cluster-node",
      "i-spot": "spot-instance-not-stoppable",
      "i-store": "instance-store-root-not-stoppable",
      "db-replica": "rds-read-replica-not-stoppable",
      "db-aurora": "rds-aurora-not-individually-stoppable",
    },
  );
});

test("resources the selector never covered are silently out of scope, not reported as exclusions", () => {
  const plan = planResourceSchedule(
    {
      schedule: weekdayBusinessHoursSchedule("UTC", 0),
      selector: { tagKey: "Environment", tagValue: "development", regions: ["us-east-1"] },
      resources: [
        resource({ resourceType: "aws.ec2.instance", nativeId: "i-other-tag", tags: { Environment: "staging" } }),
        resource({ resourceType: "aws.ec2.instance", nativeId: "i-other-region", region: "eu-west-1" }),
        resource({ resourceType: "aws.ec2.instance", nativeId: "i-untagged", tags: {} }),
      ],
    },
    { now: JULY_2026 },
  );
  assert.deepEqual(plan.candidates, []);
  assert.deepEqual(plan.excluded, []);
});

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

test("schedule and selector parsers reject out-of-contract shapes instead of coercing them", () => {
  const valid = { timezone: "UTC", utcOffsetMinutes: 0, offAtWeekends: false, windows: [{ weekday: 1, startMinute: 0, endMinute: 60 }] };
  assert.notEqual(parseScheduleDefinition(valid), null);
  assert.equal(parseScheduleDefinition({ ...valid, windows: [] }), null);
  assert.equal(parseScheduleDefinition({ ...valid, utcOffsetMinutes: 7 }), null);
  assert.equal(parseScheduleDefinition({ ...valid, timezone: "../../etc/passwd" }), null);
  assert.equal(parseScheduleDefinition({ ...valid, windows: [{ weekday: 7, startMinute: 0, endMinute: 60 }] }), null);
  assert.equal(parseScheduleDefinition({ ...valid, windows: [{ weekday: 1, startMinute: 60, endMinute: 60 }] }), null);
  assert.equal(parseScheduleDefinition({ ...valid, windows: [{ weekday: 1, startMinute: 0, endMinute: 1_441 }] }), null);
  assert.equal(parseScheduleDefinition({ ...valid, offAtWeekends: "yes" }), null);
  assert.equal(parseScheduleSelector({ tagKey: "" }), null);
  assert.equal(parseScheduleSelector({ tagKey: "Environment", regions: ["Not A Region"] }), null);
  assert.deepEqual(parseScheduleSelector({ tagKey: "Environment", tagValue: "dev" }), { tagKey: "Environment", tagValue: "dev" });
});

/* -------------------------------------------------------------------------- */
/* Customer-applied artefact                                                   */
/* -------------------------------------------------------------------------- */

test("the artefact is customer-applied, tag-scoped, and grants start/stop only in the customer's own role", () => {
  const artifacts = buildResourceScheduleArtifacts({
    scheduleName: "Dev off overnight",
    schedule: weekdayBusinessHoursSchedule("America/New_York", -300),
    selector: { tagKey: "Environment", tagValue: "development" },
  });
  for (const document of [artifacts.cloudFormationYaml, artifacts.terraformHcl]) {
    // Enforcement is the customer's, in the customer's account.
    assert.match(document, /read-only/u);
    assert.match(document, /ec2:StopInstances/u);
    assert.match(document, /rds:StopDBInstance/u);
    // The schedule's IANA zone travels with it, so AWS handles DST.
    assert.match(document, /America\/New_York/u);
    // Both start and stop transitions are present, and the scope is the tag.
    assert.match(document, /cron\(0 8 \? \* MON,TUE,WED,THU,FRI \*\)/u);
    assert.match(document, /cron\(0 20 \? \* MON,TUE,WED,THU,FRI \*\)/u);
    assert.match(document, /Environment/u);
    // No Sutra principal, role, or endpoint is referenced anywhere.
    assert.equal(/Sutra(ReadOnly|Collector)Role|sts:AssumeRole"\s*,?\s*Principal.*sutra/iu.test(document), false);
    assert.equal(document.includes("sutracmdb.com"), false);
  }
  assert.deepEqual(artifacts.grantedActions, [
    "ec2:DescribeInstances",
    "ec2:StartInstances",
    "ec2:StopInstances",
    "rds:DescribeDBInstances",
    "rds:ListTagsForResource",
    "rds:StartDBInstance",
    "rds:StopDBInstance",
  ]);
  assert.equal(artifacts.readOnlyNotice, RESOURCE_SCHEDULE_READ_ONLY_NOTICE);
  assert.match(artifacts.readOnlyNotice, /Sutra cannot start or stop your resources/u);
});

test("an EC2-only artefact grants no RDS action at all", () => {
  const artifacts = buildResourceScheduleArtifacts({
    scheduleName: "ec2-only",
    schedule: weekdayBusinessHoursSchedule("UTC", 0),
    selector: { tagKey: "Schedule" },
    includeRds: false,
  });
  assert.deepEqual(artifacts.grantedActions, ["ec2:DescribeInstances", "ec2:StartInstances", "ec2:StopInstances"]);
  assert.equal(artifacts.cloudFormationYaml.includes("rds:StopDBInstance"), false);
});

test("a schedule with nothing to automate is refused rather than emitting an empty template", () => {
  const alwaysOn: ResourceScheduleDefinition = {
    timezone: "UTC",
    utcOffsetMinutes: 0,
    offAtWeekends: false,
    windows: ([0, 1, 2, 3, 4, 5, 6] as const).map((weekday) => ({ weekday, startMinute: 0, endMinute: 1_440 })),
  };
  assert.throws(
    () => buildResourceScheduleArtifacts({ scheduleName: "always-on", schedule: alwaysOn, selector: { tagKey: "Schedule" } }),
    /nothing to automate/u,
  );
  const plan = planResourceSchedule({ schedule: alwaysOn, selector: SELECTOR, resources: [] }, { now: JULY_2026 });
  assert.deepEqual(plan.transitions, []);
  assert.equal(plan.stoppedHoursPerMonth, 0);
});

test("the plan states enforcement is customer-applied", () => {
  const plan = planResourceSchedule(
    { schedule: weekdayBusinessHoursSchedule("UTC", 0), selector: SELECTOR, resources: [] },
    { now: JULY_2026 },
  );
  assert.equal(plan.enforcement, "customer-applied");
  assert.equal(plan.generatedAt, "2026-07-15T12:00:00.000Z");
});
