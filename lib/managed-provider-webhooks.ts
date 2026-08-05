export type ManagedProviderWebhookTarget =
  | "jira-cloud-webhook"
  | "pagerduty-events"
  | "servicenow-webhook"
  | "slack-webhook"
  | "teams-logic-workflow"
  | "teams-powerplatform-workflow";

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SLACK_PATH =
  /^\/services\/[A-Za-z0-9_-]{8,}\/[A-Za-z0-9_-]{8,}\/[A-Za-z0-9_-]{16,}$/u;
const JIRA_AUTOMATION_PATH = /^\/pro\/hooks\/[A-Za-z0-9_-]{16,256}$/u;
const SERVICENOW_PATH =
  /^\/api\/[A-Za-z0-9_.-]{1,80}\/[A-Za-z0-9_.-]{1,80}(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]{1,160}){0,8}$/u;
const LOGIC_PATH =
  /^\/workflows\/[A-Fa-f0-9-]{16,128}\/triggers\/manual\/paths\/invoke$/u;
const POWER_PLATFORM_PATH =
  /^\/powerautomate\/automations\/direct\/workflows\/[A-Fa-f0-9-]{16,128}\/triggers\/manual\/paths\/invoke$/u;
const SAFE_QUERY_VALUE = /^[A-Za-z0-9._~!$'()*+,;:@%/=-]{1,1024}$/u;

function validHostname(hostname: string): boolean {
  return hostname.length <= 253 &&
    hostname === hostname.toLowerCase() &&
    hostname.split(".").every((label) => HOST_LABEL.test(label));
}

function exactHttps(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.port === "" &&
    url.hash === "" &&
    validHostname(url.hostname)
  );
}

function teamsQuery(url: URL): boolean {
  const required = new Set(["api-version", "sig"]);
  const permitted = new Set(["api-version", "sig", "sp", "sv"]);
  for (const key of url.searchParams.keys()) {
    const values = url.searchParams.getAll(key);
    if (
      !permitted.has(key) ||
      values.length !== 1 ||
      !SAFE_QUERY_VALUE.test(values[0] ?? "")
    ) return false;
  }
  return [...required].every((key) => url.searchParams.has(key));
}

function logicHostname(hostname: string): boolean {
  const labels = hostname.split(".");
  return (
    labels.length === 5 &&
    /^prod(?:-\d{1,3})?$/u.test(labels[0] ?? "") &&
    HOST_LABEL.test(labels[1] ?? "") &&
    labels.slice(2).join(".") === "logic.azure.com"
  );
}

function powerPlatformHostname(hostname: string): boolean {
  const labels = hostname.split(".");
  return (
    labels.length === 5 &&
    HOST_LABEL.test(labels[0] ?? "") &&
    labels.slice(1).join(".") === "environment.api.powerplatform.com"
  );
}

function serviceNowHostname(hostname: string): boolean {
  const labels = hostname.split(".");
  return (
    labels.length === 3 &&
    HOST_LABEL.test(labels[0] ?? "") &&
    labels.slice(1).join(".") === "service-now.com"
  );
}

export function classifyManagedProviderWebhookUrl(
  value: string | URL,
  method = "POST",
): ManagedProviderWebhookTarget | null {
  if (method.toUpperCase() !== "POST") return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (!exactHttps(url)) return null;
  if (
    url.hostname === "hooks.slack.com" &&
    url.search === "" &&
    SLACK_PATH.test(url.pathname)
  ) return "slack-webhook";
  if (
    url.hostname === "events.pagerduty.com" &&
    url.search === "" &&
    url.pathname === "/v2/enqueue"
  ) return "pagerduty-events";
  if (
    url.hostname === "automation.atlassian.com" &&
    url.search === "" &&
    JIRA_AUTOMATION_PATH.test(url.pathname)
  ) return "jira-cloud-webhook";
  if (
    serviceNowHostname(url.hostname) &&
    url.search === "" &&
    SERVICENOW_PATH.test(url.pathname)
  ) return "servicenow-webhook";
  if (
    logicHostname(url.hostname) &&
    LOGIC_PATH.test(url.pathname) &&
    teamsQuery(url)
  ) return "teams-logic-workflow";
  if (
    powerPlatformHostname(url.hostname) &&
    POWER_PLATFORM_PATH.test(url.pathname) &&
    teamsQuery(url)
  ) return "teams-powerplatform-workflow";
  return null;
}

export function isManagedTicketWebhookUrl(
  value: string | URL,
  connectorType?: "jira" | "servicenow",
): boolean {
  const target = classifyManagedProviderWebhookUrl(value);
  if (connectorType === "jira") return target === "jira-cloud-webhook";
  if (connectorType === "servicenow") return target === "servicenow-webhook";
  return target === "jira-cloud-webhook" || target === "servicenow-webhook";
}
