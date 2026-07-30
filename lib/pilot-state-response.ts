interface PilotStateResponse {
  readonly state?: {
    readonly connection?: {
      readonly id?: unknown;
    } | null;
  };
}

const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;

/**
 * Keep clients on the exact `/api/pilot/state` envelope. Invalid or stale
 * response shapes fail visibly instead of becoming `connectionId=undefined`.
 */
export function connectionIdFromPilotStateResponse(value: unknown): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Could not load the workspace state");
  }
  const connection = (value as PilotStateResponse).state?.connection;
  if (connection === null) return null;
  if (typeof connection?.id !== "string" || !CONNECTION_ID.test(connection.id)) {
    throw new Error("Could not load the workspace state");
  }
  return connection.id;
}
