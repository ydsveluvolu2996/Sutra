import type { ScimGroupInput, ScimUserInput } from "../db/scim-repository";
import {
  SCIM_GROUP_SCHEMA,
  SCIM_USER_SCHEMA,
  ScimError,
  exactScimString,
  parsePatchOperations,
  requireSchema,
} from "./scim-protocol";

const USER_ID = /^scimu_[a-f0-9]{32}$/u;

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new ScimError(400, `${label} must be boolean`, "invalidValue");
  return value;
}

function emailFromEmails(value: unknown): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > 20) {
    throw new ScimError(400, "emails is invalid", "invalidValue");
  }
  const candidates = value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ScimError(400, "An email entry is invalid", "invalidValue");
    }
    const record = entry as Record<string, unknown>;
    return {
      value: exactScimString(record.value, "email", 254, { email: true }),
      primary: record.primary === true,
    };
  });
  return (candidates.find((entry) => entry.primary) ?? candidates[0])?.value ?? null;
}

export function userInputFromBody(body: Record<string, unknown>): ScimUserInput {
  requireSchema(body, SCIM_USER_SCHEMA);
  const emails = emailFromEmails(body.emails);
  const userName = exactScimString(body.userName ?? emails, "userName", 254, { email: true });
  if (userName === null) throw new ScimError(400, "userName is required", "invalidValue");
  if (emails !== null && emails !== userName) {
    throw new ScimError(400, "The primary email must match userName", "invalidValue");
  }
  const displayName = exactScimString(body.displayName ?? userName, "displayName", 128);
  if (displayName === null) throw new ScimError(400, "displayName is required", "invalidValue");
  return {
    userName,
    displayName,
    externalId: exactScimString(body.externalId, "externalId", 255, { optional: true }),
    active: body.active === undefined ? true : boolean(body.active, "active"),
  };
}

function userState(resource: Record<string, unknown>): ScimUserInput {
  return {
    userName: String(resource.userName),
    displayName: String(resource.displayName ?? resource.userName),
    externalId: typeof resource.externalId === "string" ? resource.externalId : null,
    active: resource.active === true,
  };
}

function normalizedPath(path: string): string {
  return path.trim().replace(/^urn:ietf:params:scim:schemas:core:2\.0:User:/iu, "").toLowerCase();
}

export function patchedUserInput(
  resource: Record<string, unknown>,
  body: Record<string, unknown>,
): ScimUserInput {
  let state = userState(resource);
  for (const operation of parsePatchOperations(body)) {
    if (operation.path === null) {
      if (
        (operation.op !== "add" && operation.op !== "replace") ||
        typeof operation.value !== "object" ||
        operation.value === null ||
        Array.isArray(operation.value)
      ) throw new ScimError(400, "A pathless user patch is invalid", "invalidPath");
      const values = operation.value as Record<string, unknown>;
      state = {
        userName:
          values.userName === undefined
            ? state.userName
            : exactScimString(values.userName, "userName", 254, { email: true }) ?? state.userName,
        displayName:
          values.displayName === undefined
            ? state.displayName
            : exactScimString(values.displayName, "displayName", 128) ?? state.displayName,
        externalId:
          values.externalId === undefined
            ? state.externalId
            : exactScimString(values.externalId, "externalId", 255, { optional: true }),
        active: values.active === undefined ? state.active : boolean(values.active, "active"),
      };
      continue;
    }
    const path = normalizedPath(operation.path);
    if (path === "active") {
      if (operation.op === "remove") state = { ...state, active: false };
      else state = { ...state, active: boolean(operation.value, "active") };
    } else if (path === "username") {
      if (operation.op === "remove") throw new ScimError(400, "userName cannot be removed", "mutability");
      state = {
        ...state,
        userName: exactScimString(operation.value, "userName", 254, { email: true }) ?? state.userName,
      };
    } else if (path === "displayname") {
      state = {
        ...state,
        displayName:
          operation.op === "remove"
            ? state.userName
            : exactScimString(operation.value, "displayName", 128) ?? state.displayName,
      };
    } else if (path === "externalid") {
      state = {
        ...state,
        externalId:
          operation.op === "remove"
            ? null
            : exactScimString(operation.value, "externalId", 255, { optional: true }),
      };
    } else if (path === "emails") {
      if (operation.op === "remove") throw new ScimError(400, "The primary email cannot be removed", "mutability");
      const email = emailFromEmails(operation.value);
      if (email === null) throw new ScimError(400, "A primary email is required", "invalidValue");
      state = { ...state, userName: email };
    } else {
      throw new ScimError(400, `The user patch path ${operation.path} is unsupported`, "invalidPath");
    }
  }
  return state;
}

function memberIds(value: unknown): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new ScimError(400, "members is invalid", "invalidValue");
  }
  const values = value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new ScimError(400, "A group member is invalid", "invalidValue");
    }
    const id = exactScimString((entry as Record<string, unknown>).value, "member value", 64);
    if (id === null || !USER_ID.test(id)) {
      throw new ScimError(400, "A group member identifier is invalid", "invalidValue");
    }
    return id;
  });
  return [...new Set(values)];
}

export function groupInputFromBody(body: Record<string, unknown>): ScimGroupInput {
  requireSchema(body, SCIM_GROUP_SCHEMA);
  const displayName = exactScimString(body.displayName, "displayName", 128);
  if (displayName === null) throw new ScimError(400, "displayName is required", "invalidValue");
  return {
    displayName,
    externalId: exactScimString(body.externalId, "externalId", 255, { optional: true }),
    memberIds: memberIds(body.members),
  };
}

function groupState(resource: Record<string, unknown>): ScimGroupInput {
  return {
    displayName: String(resource.displayName),
    externalId: typeof resource.externalId === "string" ? resource.externalId : null,
    memberIds: memberIds(resource.members),
  };
}

function filteredMember(path: string): string | null {
  const match = /^members\s*\[\s*value\s+eq\s+"(scimu_[a-f0-9]{32})"\s*\]$/iu.exec(path);
  return match?.[1] ?? null;
}

export function patchedGroupInput(
  resource: Record<string, unknown>,
  body: Record<string, unknown>,
): ScimGroupInput {
  let state = groupState(resource);
  for (const operation of parsePatchOperations(body)) {
    if (operation.path === null) {
      if (
        (operation.op !== "add" && operation.op !== "replace") ||
        typeof operation.value !== "object" ||
        operation.value === null ||
        Array.isArray(operation.value)
      ) throw new ScimError(400, "A pathless group patch is invalid", "invalidPath");
      const values = operation.value as Record<string, unknown>;
      state = {
        displayName:
          values.displayName === undefined
            ? state.displayName
            : exactScimString(values.displayName, "displayName", 128) ?? state.displayName,
        externalId:
          values.externalId === undefined
            ? state.externalId
            : exactScimString(values.externalId, "externalId", 255, { optional: true }),
        memberIds: values.members === undefined ? state.memberIds : memberIds(values.members),
      };
      continue;
    }
    const path = operation.path.trim();
    const lower = path.toLowerCase();
    if (lower === "displayname") {
      if (operation.op === "remove") throw new ScimError(400, "displayName cannot be removed", "mutability");
      state = {
        ...state,
        displayName: exactScimString(operation.value, "displayName", 128) ?? state.displayName,
      };
    } else if (lower === "externalid") {
      state = {
        ...state,
        externalId:
          operation.op === "remove"
            ? null
            : exactScimString(operation.value, "externalId", 255, { optional: true }),
      };
    } else if (lower === "members") {
      const patchMembers = memberIds(operation.value);
      if (operation.op === "replace") state = { ...state, memberIds: patchMembers };
      else if (operation.op === "add") {
        state = { ...state, memberIds: [...new Set([...state.memberIds, ...patchMembers])] };
      } else {
        const removed = new Set(patchMembers);
        state = { ...state, memberIds: state.memberIds.filter((id) => !removed.has(id)) };
      }
    } else {
      const selected = filteredMember(path);
      if (operation.op !== "remove" || selected === null) {
        throw new ScimError(400, `The group patch path ${operation.path} is unsupported`, "invalidPath");
      }
      state = { ...state, memberIds: state.memberIds.filter((id) => id !== selected) };
    }
  }
  return state;
}
