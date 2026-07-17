#!/usr/bin/env node
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const command = process.argv[2] ?? "plan";
const execute = process.argv.includes("--execute");
const confirmationIndex = process.argv.indexOf("--confirm");
const confirmation = confirmationIndex >= 0 ? process.argv[confirmationIndex + 1] ?? "" : "";
if (!new Set(["plan", "preflight", "budget", "teardown"]).has(command)) {
  throw new Error("Command must be plan, preflight, budget, or teardown");
}
if (command !== "plan" && !execute) {
  throw new Error(`${command} can call AWS; re-run with --execute after reviewing the plan`);
}

function required(name, pattern, planDefault = "") {
  const value = process.env[name]?.trim() || (command === "plan" ? planDefault : "");
  if (!pattern.test(value)) throw new Error(`${name} is missing or invalid`);
  return value;
}

const region = required("AWS_REGION", /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u, "ap-south-1");
const accountId = required("SUTRA_AWS_ACCOUNT_ID", /^\d{12}$/u, "738663485493");
const cluster = required(
  "SUTRA_EKS_CLUSTER_NAME",
  /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u,
  "sutra-enterprise-validation",
);
const kubernetesContext = required(
  "SUTRA_KUBERNETES_CONTEXT",
  /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,253}$/u,
  `arn:aws:eks:${region}:${accountId}:cluster/${cluster}`,
);
const notificationEmail = required(
  "SUTRA_BUDGET_NOTIFICATION_EMAIL",
  /^[^@\s]{1,64}@[^@\s]{1,190}$/u,
  "yds.veluvolu@gmail.com",
);
const expiration = required(
  "SUTRA_DISPOSABLE_EXPIRES_AT",
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u,
  new Date(Date.now() + 12 * 60 * 60_000).toISOString(),
);
const expirationMs = Date.parse(expiration);
const maximumBudget = Number(process.env.SUTRA_DISPOSABLE_BUDGET_USD ?? "40");
if (maximumBudget !== 40) throw new Error("Disposable validation budget must remain exactly USD 40");
if (
  command !== "teardown" &&
  !Number.isFinite(expirationMs) ||
  command !== "teardown" && (
    expirationMs <= Date.now() ||
    expirationMs - Date.now() > 24 * 60 * 60_000
  )
) throw new Error("SUTRA_DISPOSABLE_EXPIRES_AT must be within the next 24 hours");
if (!Number.isFinite(expirationMs)) throw new Error("SUTRA_DISPOSABLE_EXPIRES_AT is invalid");

const budgetName = `sutra-eks-disposable-${cluster}`;
const ecrRepository = process.env.SUTRA_ECR_REPOSITORY?.trim() ?? "";
if (ecrRepository && !/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/u.test(ecrRepository)) {
  throw new Error("SUTRA_ECR_REPOSITORY is invalid");
}

async function run(program, args) {
  if (args.some((value) => /(?:secret|token|password|access.?key)[=:]/iu.test(value))) {
    throw new Error("A secret-like process argument was rejected");
  }
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(program, args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, AWS_REGION: region },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", () => rejectPromise(new Error(`${program} is not installed`)));
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout.trim());
      else rejectPromise(new Error(`Guard operation failed: ${stderr.trim().slice(0, 500)}`));
    });
  });
}

function aws(...args) {
  return run("aws", [...args, "--region", region, "--no-cli-pager", "--output", "json"]);
}

async function identityAndCluster() {
  const identity = JSON.parse(await aws("sts", "get-caller-identity"));
  if (identity.Account !== accountId) throw new Error("AWS caller account does not match SUTRA_AWS_ACCOUNT_ID");
  const described = JSON.parse(await aws("eks", "describe-cluster", "--name", cluster));
  const tags = described.cluster?.tags ?? {};
  if (tags["sutra:disposable"] !== "true" || tags["sutra:expires-at"] !== expiration) {
    throw new Error("Cluster is missing the exact sutra:disposable and sutra:expires-at safety tags");
  }
  return described.cluster;
}

function budgetDocument() {
  return JSON.stringify({
    BudgetName: budgetName,
    BudgetLimit: { Amount: "40", Unit: "USD" },
    BudgetType: "COST",
    TimeUnit: "MONTHLY",
    CostFilters: { TagKeyValue: ["user:sutra:disposable$true"] },
  });
}

function notificationsDocument() {
  return JSON.stringify([{
    Notification: {
      NotificationType: "ACTUAL",
      ComparisonOperator: "GREATER_THAN",
      Threshold: 80,
      ThresholdType: "PERCENTAGE",
    },
    Subscribers: [{ SubscriptionType: "EMAIL", Address: notificationEmail }],
  }, {
    Notification: {
      NotificationType: "ACTUAL",
      ComparisonOperator: "GREATER_THAN",
      Threshold: 100,
      ThresholdType: "PERCENTAGE",
    },
    Subscribers: [{ SubscriptionType: "EMAIL", Address: notificationEmail }],
  }]);
}

async function createBudget() {
  try {
    await aws(
      "budgets", "create-budget", "--account-id", accountId,
      "--budget", budgetDocument(),
      "--notifications-with-subscribers", notificationsDocument(),
    );
  } catch (error) {
    if (!String(error.message).includes("DuplicateRecordException")) throw error;
    await aws(
      "budgets", "update-budget", "--account-id", accountId,
      "--new-budget", budgetDocument(),
    );
  }
}

async function teardown() {
  if (confirmation !== cluster) {
    throw new Error(`Teardown requires --confirm ${cluster}`);
  }
  await identityAndCluster();
  await run(process.execPath, [
    "scripts/kubernetes-security-stack.mjs", "uninstall",
    "--context", kubernetesContext,
    "--modules", "cilium,trivy,kyverno,falco",
    "--allow-cni-change", "--delete-namespaces", "--execute",
  ]);
  const nodegroups = JSON.parse(await aws("eks", "list-nodegroups", "--cluster-name", cluster));
  for (const nodegroup of nodegroups.nodegroups ?? []) {
    await aws("eks", "delete-nodegroup", "--cluster-name", cluster, "--nodegroup-name", nodegroup);
    await aws(
      "eks", "wait", "nodegroup-deleted", "--cluster-name", cluster, "--nodegroup-name", nodegroup,
    );
  }
  await aws("eks", "delete-cluster", "--name", cluster);
  await aws("eks", "wait", "cluster-deleted", "--name", cluster);
  if (ecrRepository) {
    try {
      await aws("ecr", "delete-repository", "--repository-name", ecrRepository, "--force");
    } catch (error) {
      if (!String(error.message).includes("RepositoryNotFoundException")) throw error;
    }
  }
  try {
    await aws("budgets", "delete-budget", "--account-id", accountId, "--budget-name", budgetName);
  } catch (error) {
    if (!String(error.message).includes("NotFoundException")) throw error;
  }
}

if (command === "plan") {
  process.stdout.write([
    "Sutra disposable EKS guard plan (no AWS calls made)",
    `account=${accountId}`,
    `region=${region}`,
    `cluster=${cluster}`,
    `kubernetesContext=${kubernetesContext}`,
    `expiresAt=${expiration}`,
    "budget=USD 40; email alerts at 80% and 100%; tag-filtered to sutra:disposable=true",
    "preflight=verify caller account, EKS status and exact disposable/expiry tags",
    "teardown=uninstall security stack; delete nodegroups; delete cluster; optionally delete ECR; delete budget",
    `teardownConfirmation=--confirm ${cluster}`,
    "",
  ].join("\n"));
} else if (command === "preflight") {
  const described = await identityAndCluster();
  if (described.status !== "ACTIVE") throw new Error("Disposable EKS cluster is not ACTIVE");
  process.stdout.write("AWS disposable EKS preflight passed; no changes were made.\n");
} else if (command === "budget") {
  await identityAndCluster();
  await createBudget();
  process.stdout.write("USD 40 disposable AWS budget is active.\n");
} else {
  await teardown();
  process.stdout.write("Disposable EKS resources and budget were removed.\n");
}
