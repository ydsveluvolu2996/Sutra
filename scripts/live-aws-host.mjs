import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { constants as fileConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  LIVE_POSTGRES_VOLUME,
  ensureDockerLocalEnvironment,
} from "./docker-local-env.mjs";

export const LIVE_AWS_ACKNOWLEDGEMENT = "I_ACKNOWLEDGE_THIS_WILL_CONTACT_AWS";
export const LIVE_RUNTIME_CONFIG = ".sutra/live-aws.env";
export const LIVE_COMPOSE_PROJECT = "sutra-live-aws";

const IAM_ROLE_ARN =
  /^arn:(aws|aws-us-gov|aws-cn):iam::([0-9]{12}):role\/([A-Za-z0-9_+=,.@\/-]+)$/u;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const MAX_AWS_SHARED_FILE_BYTES = 1_048_576;
const STATIC_SHARED_CREDENTIAL_KEYS = Object.freeze([
  "aws_access_key_id",
  "aws_secret_access_key",
  "aws_session_token",
  "aws_security_token",
]);
const UNSUPPORTED_CREDENTIAL_PROVIDER_KEYS = Object.freeze([
  "credential_process",
  "credential_source",
  "web_identity_token_file",
]);
const UNSUPPORTED_PROFILE_ENDPOINT_KEYS = Object.freeze([
  "endpoint_url",
  "services",
]);
const AWS_ENDPOINT_OVERRIDE_ENVIRONMENT = /^AWS_ENDPOINT_URL(?:_[A-Z0-9_]+)?$/u;
export const STATIC_CREDENTIAL_ENVIRONMENT_KEYS = Object.freeze([
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
]);
const RUNTIME_KEYS = Object.freeze([
  "SUTRA_LOCAL_MODE",
  "SUTRA_LOCAL_BOOTSTRAP_TOKEN",
  "SUTRA_AUTH_ENCRYPTION_KEY",
  "SUTRA_AUTH_KEY_VERSION",
  "SUTRA_CONNECTION_ENCRYPTION_KEY",
  "SUTRA_CONNECTION_KEY_VERSION",
  "SUTRA_BROKER_SHARED_SECRET",
  "SUTRA_REGISTRY_ENCRYPTION_KEY",
  "SUTRA_BROKER_URL",
  "SUTRA_COLLECTOR_MODE",
  "SUTRA_ALLOW_LIVE_AWS",
  "SUTRA_COLLECTOR_PRINCIPAL_ARN",
  "SUTRA_CUSTOMER_ROLE_TEMPLATE_URL",
  "SUTRA_REGISTRY_PATH",
  "SUTRA_LOCAL_JOBS_PATH",
  "SUTRA_WEB_HOST",
  "DATABASE_URL",
]);
const RUNTIME_KEY_SET = new Set(RUNTIME_KEYS);
const SECRET_RUNTIME_KEYS = Object.freeze([
  "SUTRA_LOCAL_BOOTSTRAP_TOKEN",
  "SUTRA_AUTH_ENCRYPTION_KEY",
  "SUTRA_CONNECTION_ENCRYPTION_KEY",
  "SUTRA_BROKER_SHARED_SECRET",
  "SUTRA_REGISTRY_ENCRYPTION_KEY",
]);
const SECRET_VALUE = /^[A-Za-z0-9_-]{43}$/u;
const DEFAULT_POSTGRES_PORT = 54329;
const DEFAULT_WEB_PORT = 3000;
const COLLECTOR_PORT = 8788;
const S3_TEMPLATE_HOST =
  /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]\.s3\.[a-z]{2}-[a-z0-9-]+-[0-9]+\.amazonaws\.com$/u;

export function validateLiveAwsLaunchEnvironment(environment) {
  if (environment.SUTRA_LIVE_AWS_ACK !== LIVE_AWS_ACKNOWLEDGEMENT) {
    throw new Error(
      `Set SUTRA_LIVE_AWS_ACK exactly to ${LIVE_AWS_ACKNOWLEDGEMENT} for each live launch`,
    );
  }

  assertNoStaticAwsCredentialEnvironment(environment);
  assertNoAwsEndpointOverrideEnvironment(environment);

  const awsProfile = exactEnvironmentValue(environment, "AWS_PROFILE");
  if (!PROFILE_NAME.test(awsProfile)) {
    throw new Error("AWS_PROFILE must be a plain named profile (letters, numbers, dot, underscore, or dash)");
  }

  const principalArn = exactEnvironmentValue(environment, "SUTRA_COLLECTOR_PRINCIPAL_ARN");
  const principal = IAM_ROLE_ARN.exec(principalArn);
  if (
    principal === null ||
    principal[3] === undefined ||
    principal[3].startsWith("/") ||
    principal[3].endsWith("/") ||
    principal[3].includes("//")
  ) {
    throw new Error("SUTRA_COLLECTOR_PRINCIPAL_ARN must be the exact IAM role ARN used by AWS_PROFILE");
  }

  const postgresPort = optionalPort(environment.SUTRA_POSTGRES_PORT, DEFAULT_POSTGRES_PORT, "SUTRA_POSTGRES_PORT");
  const webPort = optionalPort(environment.SUTRA_WEB_PORT, DEFAULT_WEB_PORT, "SUTRA_WEB_PORT");
  if (webPort === COLLECTOR_PORT || postgresPort === COLLECTOR_PORT || webPort === postgresPort) {
    throw new Error("The web, collector, and PostgreSQL loopback ports must be distinct");
  }

  return {
    awsProfile,
    principalArn,
    postgresPort,
    webPort,
    region: optionalRegion(environment.AWS_REGION ?? environment.AWS_DEFAULT_REGION),
  };
}

export function assertNoStaticAwsCredentialEnvironment(environment) {
  for (const key of STATIC_CREDENTIAL_ENVIRONMENT_KEYS) {
    if (typeof environment[key] === "string" && environment[key].trim().length > 0) {
      throw new Error(
        `${key} must be unset; Sutra accepts only a short-lived AWS_PROFILE session`,
      );
    }
  }
}

export function assertNoAwsEndpointOverrideEnvironment(environment) {
  for (const [key, value] of Object.entries(environment)) {
    if (
      AWS_ENDPOINT_OVERRIDE_ENVIRONMENT.test(key) &&
      typeof value === "string" &&
      value.trim().length > 0
    ) {
      throw new Error(
        `${key} must be unset; Sutra contacts only the standard AWS service endpoints`,
      );
    }
  }
}

export function scrubAwsEndpointOverrideEnvironment(environment) {
  const safe = {};
  for (const [key, value] of Object.entries(environment)) {
    if (!AWS_ENDPOINT_OVERRIDE_ENVIRONMENT.test(key) && value !== undefined) {
      safe[key] = value;
    }
  }
  return safe;
}

function sharedFilePath(environment, key, fallback) {
  const configured = environment[key];
  if (configured === undefined || configured === "") {
    return { path: fallback, required: false };
  }
  if (
    typeof configured !== "string" ||
    configured !== configured.trim() ||
    /[\0\r\n]/u.test(configured) ||
    !isAbsolute(configured)
  ) {
    throw new Error(`${key} must be an absolute path without surrounding whitespace`);
  }
  return { path: configured, required: true };
}

async function readSafeAwsSharedFile({ path, required, label }) {
  let handle;
  try {
    handle = await open(path, fileConstants.O_RDONLY | fileConstants.O_NOFOLLOW);
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return "";
    if (error?.code === "ENOENT") throw new Error(`${label} does not exist`);
    throw new Error(`${label} must be a readable regular file and not a symbolic link`);
  }

  try {
    const status = await handle.stat();
    if (!status.isFile()) throw new Error(`${label} must be a regular file`);
    if (status.size > MAX_AWS_SHARED_FILE_BYTES) {
      throw new Error(`${label} is too large to validate safely`);
    }
    if ((status.mode & 0o022) !== 0) {
      throw new Error(`${label} must not be writable by group or other users`);
    }
    if (typeof process.getuid === "function" && status.uid !== process.getuid()) {
      throw new Error(`${label} must be owned by the current local user`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function newIniSection(map, name, label) {
  if (map.has(name)) throw new Error(`${label} contains a duplicate section`);
  const section = new Map();
  map.set(name, section);
  return section;
}

function parseAwsSharedFile(text, kind, label) {
  const profiles = new Map();
  const ssoSessions = new Map();
  let current;
  let ignored = false;
  const lines = text.replace(/^\uFEFF/u, "").split(/\r?\n/u);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#") || line.startsWith(";")) continue;

    const sectionMatch = /^\[([^\]\r\n]+)\]$/u.exec(line);
    if (sectionMatch !== null) {
      const sectionName = sectionMatch[1].trim();
      current = undefined;
      ignored = false;
      if (kind === "config" && sectionName === "default") {
        current = newIniSection(profiles, "default", label);
      } else if (kind === "config" && sectionName.startsWith("profile ")) {
        const profileName = sectionName.slice("profile ".length);
        if (!PROFILE_NAME.test(profileName)) throw new Error(`${label} contains an invalid profile name`);
        current = newIniSection(profiles, profileName, label);
      } else if (kind === "config" && sectionName.startsWith("sso-session ")) {
        const sessionName = sectionName.slice("sso-session ".length);
        if (!PROFILE_NAME.test(sessionName)) throw new Error(`${label} contains an invalid SSO session name`);
        current = newIniSection(ssoSessions, sessionName, label);
      } else if (kind === "credentials") {
        if (!PROFILE_NAME.test(sectionName)) throw new Error(`${label} contains an invalid profile name`);
        current = newIniSection(profiles, sectionName, label);
      } else {
        // AWS config can contain unrelated service sections. They cannot provide
        // credentials, so ignore their contents while validating profile sources.
        ignored = true;
      }
      continue;
    }

    if (ignored) continue;
    if (current === undefined) throw new Error(`${label} contains a setting outside a section`);
    const setting = /^([A-Za-z0-9_]+)\s*=\s*(.*)$/u.exec(line);
    if (setting === null) throw new Error(`${label} contains an unsupported setting`);
    const key = setting[1].toLowerCase();
    if (current.has(key)) throw new Error(`${label} contains a duplicate profile setting`);
    current.set(key, setting[2].trim());
  }

  return { profiles, ssoSessions };
}

function getSingleProfileValue(profileSections, key) {
  const values = profileSections
    .filter((section) => section.has(key))
    .map((section) => section.get(key));
  if (values.length > 1) throw new Error(`AWS profile has an ambiguous ${key} setting`);
  return values[0];
}

function requireNonemptyProfileValue(profileSections, key, description) {
  const value = getSingleProfileValue(profileSections, key);
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`AWS SSO profile is missing ${description}`);
  }
  return value;
}

function assertSsoTerminalProfile(profileSections, ssoSessions) {
  const sessionName = getSingleProfileValue(profileSections, "sso_session");
  const legacySsoKeys = ["sso_start_url", "sso_region", "sso_account_id", "sso_role_name"];
  const usesLegacySso = legacySsoKeys.some((key) => getSingleProfileValue(profileSections, key) !== undefined);

  if (sessionName !== undefined) {
    if (!PROFILE_NAME.test(sessionName)) throw new Error("AWS SSO profile has an invalid sso_session setting");
    if (["sso_start_url", "sso_region"].some((key) => getSingleProfileValue(profileSections, key) !== undefined)) {
      throw new Error("AWS SSO profile must not mix sso_session with legacy SSO settings");
    }
    requireNonemptyProfileValue(profileSections, "sso_account_id", "sso_account_id");
    requireNonemptyProfileValue(profileSections, "sso_role_name", "sso_role_name");
    const session = ssoSessions.get(sessionName);
    if (session === undefined) throw new Error("AWS SSO profile references a missing sso-session section");
    const startUrl = session.get("sso_start_url");
    const region = session.get("sso_region");
    if (typeof startUrl !== "string" || startUrl.length === 0 || typeof region !== "string" || region.length === 0) {
      throw new Error("AWS sso-session must define sso_start_url and sso_region");
    }
    return;
  }

  if (!usesLegacySso) {
    throw new Error("AWS profile chain must terminate in an IAM Identity Center/SSO profile");
  }
  for (const key of legacySsoKeys) requireNonemptyProfileValue(profileSections, key, key);
}

function validateSsoProfileChain({ selectedProfile, config, credentials }) {
  const chain = [];
  const visiting = new Set();

  function visit(profileName) {
    if (!PROFILE_NAME.test(profileName)) throw new Error("AWS profile chain contains an invalid profile name");
    if (visiting.has(profileName)) throw new Error("AWS profile source_profile chain contains a cycle");
    const configSection = config.profiles.get(profileName);
    const allProfileSections = [configSection, credentials.profiles.get(profileName)]
      .filter((section) => section !== undefined);
    if (allProfileSections.length === 0) throw new Error("AWS profile source_profile chain references a missing profile");
    const configSections = configSection === undefined ? [] : [configSection];

    visiting.add(profileName);
    chain.push(profileName);
    try {
      for (const key of STATIC_SHARED_CREDENTIAL_KEYS) {
        if (allProfileSections.some((section) => section.has(key))) {
          throw new Error("AWS profile chain must not use static shared-file credentials");
        }
      }
      for (const key of UNSUPPORTED_CREDENTIAL_PROVIDER_KEYS) {
        if (allProfileSections.some((section) => section.has(key))) {
          throw new Error(`AWS profile chain must not use ${key}`);
        }
      }
      for (const key of UNSUPPORTED_PROFILE_ENDPOINT_KEYS) {
        if (allProfileSections.some((section) => section.has(key))) {
          throw new Error(`AWS profile chain must not use ${key}`);
        }
      }

      const roleArn = getSingleProfileValue(configSections, "role_arn");
      const sourceProfile = getSingleProfileValue(configSections, "source_profile");
      const hasSsoSettings = [
        "sso_session",
        "sso_start_url",
        "sso_region",
        "sso_account_id",
        "sso_role_name",
      ].some((key) => getSingleProfileValue(configSections, key) !== undefined);

      if (roleArn !== undefined || sourceProfile !== undefined) {
        if (typeof roleArn !== "string" || IAM_ROLE_ARN.exec(roleArn) === null) {
          throw new Error("AWS role profile must define a valid role_arn");
        }
        if (typeof sourceProfile !== "string" || !PROFILE_NAME.test(sourceProfile)) {
          throw new Error("AWS role profile must define a valid source_profile");
        }
        if (hasSsoSettings) throw new Error("AWS role profile must not mix role and SSO credential sources");
        visit(sourceProfile);
        return;
      }

      assertSsoTerminalProfile(configSections, config.ssoSessions);
    } finally {
      visiting.delete(profileName);
    }
  }

  visit(selectedProfile);
  return chain;
}

export async function validateAwsProfileCredentialSource({ environment, homeDirectory = homedir() }) {
  assertNoAwsEndpointOverrideEnvironment(environment);
  const selectedProfile = exactEnvironmentValue(environment, "AWS_PROFILE");
  if (!PROFILE_NAME.test(selectedProfile)) throw new Error("AWS_PROFILE must be a plain named profile");

  const configFile = sharedFilePath(environment, "AWS_CONFIG_FILE", join(homeDirectory, ".aws", "config"));
  const credentialsFile = sharedFilePath(
    environment,
    "AWS_SHARED_CREDENTIALS_FILE",
    join(homeDirectory, ".aws", "credentials"),
  );
  const [configText, credentialsText] = await Promise.all([
    readSafeAwsSharedFile({ ...configFile, label: "AWS config file" }),
    readSafeAwsSharedFile({ ...credentialsFile, label: "AWS shared credentials file" }),
  ]);
  const config = parseAwsSharedFile(configText, "config", "AWS config file");
  const credentials = parseAwsSharedFile(credentialsText, "credentials", "AWS shared credentials file");
  const chain = validateSsoProfileChain({ selectedProfile, config, credentials });
  return {
    selectedProfile,
    chain,
    terminal: "sso",
    configFile: configFile.path,
    credentialsFile: credentialsFile.path,
  };
}

export function resolveValidatedSsoLoginProfile(profileSource, expectedSelectedProfile) {
  if (
    typeof expectedSelectedProfile !== "string" ||
    !PROFILE_NAME.test(expectedSelectedProfile) ||
    profileSource?.terminal !== "sso" ||
    profileSource?.selectedProfile !== expectedSelectedProfile ||
    !Array.isArray(profileSource?.chain) ||
    profileSource.chain.length === 0 ||
    profileSource.chain[0] !== expectedSelectedProfile
  ) {
    throw new Error("AWS profile validation did not return a safe SSO profile chain");
  }

  const visited = new Set();
  for (const profileName of profileSource.chain) {
    if (
      typeof profileName !== "string" ||
      !PROFILE_NAME.test(profileName) ||
      visited.has(profileName)
    ) {
      throw new Error("AWS profile validation did not return a safe SSO profile chain");
    }
    visited.add(profileName);
  }

  return profileSource.chain.at(-1);
}

export function assertLiveRuntimeRecoveryState({
  liveVolumeExists,
  runtimeConfigExists,
  runtimeConfigIsRegularFile,
}) {
  if (runtimeConfigExists && !runtimeConfigIsRegularFile) {
    throw new Error("The live runtime configuration must be a regular file, never a symbolic link");
  }
  if (liveVolumeExists && !runtimeConfigExists) {
    throw new Error(
      "The live PostgreSQL volume exists but .sutra/live-aws.env is missing; restore the original file or intentionally reset the live data",
    );
  }
}

function exactEnvironmentValue(environment, key) {
  const value = environment[key];
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || /[\r\n]/u.test(value)) {
    throw new Error(`${key} is required and must not contain surrounding whitespace`);
  }
  return value;
}

function optionalPort(value, fallback, key) {
  if (value === undefined || value === "") return fallback;
  if (!/^[0-9]{1,5}$/u.test(value)) throw new Error(`${key} must be an integer TCP port`);
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1_024 || port > 65_535) {
    throw new Error(`${key} must be between 1024 and 65535`);
  }
  return port;
}

function optionalRegion(value) {
  if (value === undefined || value === "") return undefined;
  if (!/^[a-z]{2}(?:-gov)?-[a-z0-9-]+-[0-9]$/u.test(value)) {
    throw new Error("AWS_REGION/AWS_DEFAULT_REGION is invalid");
  }
  return value;
}

function optionalPublicTemplateUrl(value) {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || value.length > 2_048 || value !== value.trim()) {
    throw new Error("SUTRA_CUSTOMER_ROLE_TEMPLATE_URL must be a bounded HTTPS URL");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("SUTRA_CUSTOMER_ROLE_TEMPLATE_URL must be a valid HTTPS URL");
  }
  const queryEntries = [...parsed.searchParams.entries()];
  if (
    parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "" ||
    parsed.port !== "" || parsed.hash !== "" ||
    queryEntries.length !== 1 ||
    queryEntries[0]?.[0] !== "versionId" ||
    queryEntries[0][1] === "" ||
    queryEntries[0][1] === "null" ||
    !S3_TEMPLATE_HOST.test(parsed.hostname) ||
    !/\.ya?ml$/u.test(parsed.pathname)
  ) {
    throw new Error(
      "SUTRA_CUSTOMER_ROLE_TEMPLATE_URL must be an immutable commercial-AWS S3 HTTPS object URL",
    );
  }
  return parsed.href;
}

export function parseRuntimeConfig(text) {
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("The live runtime configuration contains an invalid line");
    const key = line.slice(0, separator);
    if (!/^[A-Z][A-Z0-9_]*$/u.test(key) || values.has(key)) {
      throw new Error("The live runtime configuration contains an invalid or duplicate key");
    }
    if (!RUNTIME_KEY_SET.has(key)) {
      throw new Error(`The live runtime configuration contains unsupported key ${key}`);
    }
    values.set(key, line.slice(separator + 1));
  }
  return values;
}

export function buildLiveRuntimeConfig({
  databaseUrl,
  principalArn,
  publicTemplateUrl = "",
  existingContents = "",
  createSecret = () => randomBytes(32).toString("base64url"),
}) {
  const database = new URL(databaseUrl);
  if (
    !new Set(["postgres:", "postgresql:"]).has(database.protocol) ||
    database.hostname !== "127.0.0.1" ||
    database.username !== "sutra_app" ||
    database.pathname !== "/sutra"
  ) {
    throw new Error("The live runtime DATABASE_URL must use the local sutra_app PostgreSQL role");
  }
  if (IAM_ROLE_ARN.exec(principalArn) === null) {
    throw new Error("The live runtime principal must be an IAM role ARN");
  }

  const values = parseRuntimeConfig(existingContents);
  for (const key of SECRET_RUNTIME_KEYS) {
    const existing = values.get(key);
    if (existing === undefined) {
      const generated = createSecret();
      if (!SECRET_VALUE.test(generated)) throw new Error("The secure random source returned an invalid secret");
      values.set(key, generated);
    } else if (!SECRET_VALUE.test(existing)) {
      throw new Error(`The existing ${key} value is invalid; restore the original live runtime configuration`);
    }
  }

  const fixedValues = {
    SUTRA_LOCAL_MODE: "true",
    SUTRA_AUTH_KEY_VERSION: "live-auth-v1",
    SUTRA_CONNECTION_KEY_VERSION: "live-connection-v1",
    SUTRA_BROKER_URL: "http://127.0.0.1:8788",
    SUTRA_COLLECTOR_MODE: "live",
    SUTRA_ALLOW_LIVE_AWS: "true",
    SUTRA_COLLECTOR_PRINCIPAL_ARN: principalArn,
    SUTRA_CUSTOMER_ROLE_TEMPLATE_URL: optionalPublicTemplateUrl(publicTemplateUrl),
    SUTRA_REGISTRY_PATH: ".sutra/live-aws-collector-registry.enc",
    SUTRA_LOCAL_JOBS_PATH: ".sutra/live-aws-jobs.json",
    SUTRA_WEB_HOST: "127.0.0.1",
    DATABASE_URL: databaseUrl,
  };
  for (const [key, value] of Object.entries(fixedValues)) values.set(key, value);

  const missing = RUNTIME_KEYS.filter((key) => !values.has(key));
  if (missing.length > 0) throw new Error(`The live runtime configuration is missing ${missing.join(", ")}`);
  const contents = [
    "# Local live-AWS runtime secrets. Never commit, upload, or paste this file.",
    ...RUNTIME_KEYS.map((key) => `${key}=${values.get(key)}`),
    "",
  ].join("\n");
  if (/^AWS_/mu.test(contents) || contents.includes("SUTRA_LIVE_AWS_ACK=")) {
    throw new Error("AWS credentials, profiles, and live acknowledgement must never be persisted");
  }
  return { contents, variables: values };
}

export async function ensureLiveRuntimeConfiguration({
  root,
  databaseUrl,
  principalArn,
  publicTemplateUrl = "",
  createSecret,
}) {
  const stateDirectory = resolve(root, ".sutra");
  const configPath = resolve(root, LIVE_RUNTIME_CONFIG);
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const stateStatus = await lstat(stateDirectory);
  if (!stateStatus.isDirectory() || stateStatus.isSymbolicLink()) {
    throw new Error(".sutra must be a real local directory, not a symbolic link");
  }
  await chmod(stateDirectory, 0o700);

  let existingContents = "";
  try {
    const configStatus = await lstat(configPath);
    if (!configStatus.isFile() || configStatus.isSymbolicLink()) {
      throw new Error("The live runtime configuration must be a regular file");
    }
    await chmod(configPath, 0o600);
    existingContents = await readFile(configPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const built = buildLiveRuntimeConfig({
    databaseUrl,
    principalArn,
    publicTemplateUrl,
    existingContents,
    ...(createSecret === undefined ? {} : { createSecret }),
  });
  const temporaryPath = `${configPath}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await writeFile(temporaryPath, built.contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, configPath);
    await chmod(configPath, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
  return { configPath, variables: built.variables };
}

function withoutAwsOrSutraEnvironment(environment) {
  const safe = {};
  for (const [key, value] of Object.entries(environment)) {
    if (
      value !== undefined &&
      !key.startsWith("AWS_") &&
      !key.startsWith("SUTRA_") &&
      key !== "DATABASE_URL"
    ) {
      safe[key] = value;
    }
  }
  return safe;
}

function run(command, args, { cwd, environment, stdio = "inherit" }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: environment, stdio });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited ${signal ?? code}`));
    });
  });
}

function capture(command, args, { cwd, environment }) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (stdout.length < 8_192) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 8_192) stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(`${command} exited ${signal ?? code}: ${stderr.trim()}`));
    });
  });
}

async function dockerVolumeExists(volume, { cwd, environment }) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn("docker", ["volume", "inspect", volume], {
      cwd,
      env: environment,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise(true);
      else if (code === 1) resolvePromise(false);
      else reject(new Error(`docker volume inspect exited ${signal ?? code}`));
    });
  });
}

async function liveRuntimeConfigStatus(root) {
  try {
    const status = await lstat(resolve(root, LIVE_RUNTIME_CONFIG));
    return { exists: true, isRegularFile: status.isFile() && !status.isSymbolicLink() };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false, isRegularFile: false };
    throw error;
  }
}

async function composeServiceIsRunning(root, environmentPath, service, environment, projectName) {
  const projectArguments = projectName === undefined ? [] : ["--project-name", projectName];
  const output = await capture(
    "docker",
    ["compose", ...projectArguments, "--env-file", environmentPath, "ps", "--status", "running", "--services", service],
    { cwd: root, environment },
  );
  return output.split(/\r?\n/u).some((line) => line.trim() === service);
}

async function assertLoopbackPortAvailable(port, label) {
  await new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", () => reject(new Error(`${label} loopback port ${port} is already in use`)));
    server.listen(port, "127.0.0.1", () => server.close(resolvePromise));
  });
}

function childExit(child, name) {
  return new Promise((resolvePromise) => {
    child.once("exit", (code, signal) => resolvePromise({ name, code, signal }));
    child.once("error", (error) => resolvePromise({ name, code: 1, signal: null, error }));
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000)),
  ]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function waitForHealth(url, childExited) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      childExited.then((exit) => ({ exit })),
      fetch(url, { signal: AbortSignal.timeout(3_000) })
        .then(async (response) => ({ response, body: await response.json().catch(() => null) }))
        .catch(() => ({ response: null, body: null })),
    ]);
    if ("exit" in outcome) return outcome;
    if (outcome.response?.ok === true && outcome.body?.ok === true) return { ready: true };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
  throw new Error("The host web and collector processes did not become healthy within 90 seconds");
}

async function main() {
  const root = resolve(import.meta.dirname, "..");
  const launch = validateLiveAwsLaunchEnvironment(process.env);
  // This is deliberately the first asynchronous preflight. It reads only local
  // AWS shared files and must succeed before any Docker command or AWS request.
  const profileSource = await validateAwsProfileCredentialSource({ environment: process.env });
  const baseEnvironment = withoutAwsOrSutraEnvironment(process.env);
  const dockerEnvironment = {
    ...baseEnvironment,
    SUTRA_POSTGRES_PORT: String(launch.postgresPort),
  };
  const { environmentPath, ownerPassword, appPassword } = await ensureDockerLocalEnvironment(root);
  const fixtureAppIsRunning = await composeServiceIsRunning(
    root,
    environmentPath,
    "app",
    dockerEnvironment,
  );
  const fixturePostgresIsRunning = await composeServiceIsRunning(
    root,
    environmentPath,
    "postgres",
    dockerEnvironment,
  );
  if (fixtureAppIsRunning || fixturePostgresIsRunning) {
    throw new Error("The fixture Docker stack is running; run `pnpm docker:down` before a host live-AWS launch");
  }
  const liveAppIsRunning = await composeServiceIsRunning(
    root,
    environmentPath,
    "app",
    dockerEnvironment,
    LIVE_COMPOSE_PROJECT,
  );
  if (liveAppIsRunning) {
    throw new Error("A live-project app container is running; stop it before using the host-only live launcher");
  }
  const [liveVolumeExists, runtimeConfig] = await Promise.all([
    dockerVolumeExists(LIVE_POSTGRES_VOLUME, { cwd: root, environment: dockerEnvironment }),
    liveRuntimeConfigStatus(root),
  ]);
  assertLiveRuntimeRecoveryState({
    liveVolumeExists,
    runtimeConfigExists: runtimeConfig.exists,
    runtimeConfigIsRegularFile: runtimeConfig.isRegularFile,
  });
  await assertLoopbackPortAvailable(launch.webPort, "Web");
  await assertLoopbackPortAvailable(COLLECTOR_PORT, "Collector");

  const postgresWasRunning = await composeServiceIsRunning(
    root,
    environmentPath,
    "postgres",
    dockerEnvironment,
    LIVE_COMPOSE_PROJECT,
  );
  let startedPostgres = false;
  let collector;
  let web;
  try {
    if (!postgresWasRunning) {
      startedPostgres = true;
      await run(
        "docker",
        [
          "compose",
          "--project-name", LIVE_COMPOSE_PROJECT,
          "--env-file", environmentPath,
          "up", "--detach", "--wait", "postgres",
        ],
        { cwd: root, environment: dockerEnvironment },
      );
    }

    const runtimeDatabaseUrl =
      `postgresql://sutra_app:${encodeURIComponent(appPassword)}@127.0.0.1:${launch.postgresPort}/sutra`;
    const migratorDatabaseUrl =
      `postgresql://sutra_owner:${encodeURIComponent(ownerPassword)}@127.0.0.1:${launch.postgresPort}/sutra`;
    const runtime = await ensureLiveRuntimeConfiguration({
      root,
      databaseUrl: runtimeDatabaseUrl,
      principalArn: launch.principalArn,
      publicTemplateUrl: process.env.SUTRA_CUSTOMER_ROLE_TEMPLATE_URL,
    });

    await run(process.execPath, [resolve(root, "scripts/postgres-migrate.mjs")], {
      cwd: root,
      environment: {
        ...baseEnvironment,
        SUTRA_MIGRATOR_DATABASE_URL: migratorDatabaseUrl,
        SUTRA_POSTGRES_RUNTIME_ROLE: "sutra_app",
      },
    });
    await run("pnpm", ["build"], { cwd: root, environment: baseEnvironment });
    await run("pnpm", ["--dir", "services/aws-collector", "build"], {
      cwd: root,
      environment: baseEnvironment,
    });

    const awsEnvironment = {
      ...baseEnvironment,
      ...Object.fromEntries(runtime.variables),
      AWS_PROFILE: launch.awsProfile,
      AWS_CONFIG_FILE: profileSource.configFile,
      AWS_SHARED_CREDENTIALS_FILE: profileSource.credentialsFile,
      AWS_SDK_LOAD_CONFIG: "1",
      ...(launch.region === undefined ? {} : { AWS_REGION: launch.region, AWS_DEFAULT_REGION: launch.region }),
      SUTRA_COLLECTOR_MODE: "live",
      SUTRA_ALLOW_LIVE_AWS: "true",
      SUTRA_COLLECTOR_PRINCIPAL_ARN: launch.principalArn,
    };
    process.stdout.write("Validating the short-lived AWS profile identity before starting live collection...\n");
    await run(
      process.execPath,
      [resolve(root, "services/aws-collector/dist/src/aws-sandbox-preflight.js")],
      { cwd: root, environment: awsEnvironment },
    );

    collector = spawn(
      process.execPath,
      [resolve(root, "services/aws-collector/dist/src/local-server.js")],
      { cwd: root, env: awsEnvironment, stdio: "inherit" },
    );
    const webEnvironment = {
      ...baseEnvironment,
      ...Object.fromEntries(runtime.variables),
      WRANGLER_LOG_PATH: ".wrangler/wrangler.log",
    };
    web = spawn(
      resolve(root, "node_modules/.bin/wrangler"),
      [
        "dev",
        "--config", resolve(root, "dist/server/wrangler.json"),
        "--env-file", runtime.configPath,
        "--ip", "127.0.0.1",
        "--port", String(launch.webPort),
        "--show-interactive-dev-session", "false",
      ],
      { cwd: root, env: webEnvironment, stdio: "inherit" },
    );

    const childExited = Promise.race([childExit(collector, "collector"), childExit(web, "web")]);
    const startup = await waitForHealth(`http://127.0.0.1:${launch.webPort}/api/healthz`, childExited);
    if ("exit" in startup) {
      throw new Error(`${startup.exit.name} stopped before the live demo became healthy`);
    }
    process.stdout.write(`Sutra live AWS demo is ready at http://127.0.0.1:${launch.webPort}/\n`);
    process.stdout.write("Press Ctrl-C to stop the host processes and any PostgreSQL container started by this command.\n");

    const signal = new Promise((resolvePromise) => {
      for (const name of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(name, () => resolvePromise({ signal: name }));
    });
    const stopped = await Promise.race([childExited, signal]);
    if (!("signal" in stopped)) {
      throw new Error(`${stopped.name} stopped unexpectedly (${stopped.signal ?? stopped.code ?? 1})`);
    }
  } finally {
    if (collector !== undefined) await stopChild(collector);
    if (web !== undefined) await stopChild(web);
    if (startedPostgres) {
      await run(
        "docker",
        [
          "compose",
          "--project-name", LIVE_COMPOSE_PROJECT,
          "--env-file", environmentPath,
          "stop", "postgres",
        ],
        { cwd: root, environment: dockerEnvironment },
      ).catch(() => undefined);
    }
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : "Live AWS launcher failed";
    process.stderr.write(`Live AWS launcher failed: ${message}\n`);
    process.exitCode = 1;
  });
}
