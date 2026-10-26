import type { Env } from "../env.js";
import type { AccountStatus } from "./users.js";

const ACCOUNT_STATUSES = new Set<AccountStatus>([
  "active",
  "frozen",
  "pending_deletion",
  "deleted",
]);

export function buildCryptoWriteFence(
  env: Env,
  input: {
    userId: string;
    keyVersion: number;
    allowedStatuses: readonly AccountStatus[];
  },
): D1PreparedStatement {
  if (
    input.allowedStatuses.length === 0 ||
    input.allowedStatuses.some((status) => !ACCOUNT_STATUSES.has(status))
  ) {
    throw new Error("crypto write fence requires a closed account-status set");
  }
  if (!Number.isSafeInteger(input.keyVersion) || input.keyVersion < 1) {
    throw new Error("crypto write fence requires a positive key version");
  }

  const statusSlots = input.allowedStatuses.map(() => "?").join(", ");
  return env.DB.prepare(
    `INSERT INTO assertion_probe (id, reason)
     SELECT 1, 'crypto write fence changed'
     WHERE NOT EXISTS (
       SELECT 1 FROM users u
       JOIN user_keys k ON k.user_id = u.id
       WHERE u.id = ?
         AND u.crypto_write_fence IS NULL
         AND u.status IN (${statusSlots})
         AND k.key_version = ?
         AND k.destroyed_at IS NULL
     )`,
  ).bind(
    input.userId,
    ...input.allowedStatuses,
    input.keyVersion,
  );
}

export function requireSingleCryptoWriteVersion(
  versions: readonly number[],
): number {
  const first = versions[0];
  if (
    first === undefined ||
    !Number.isSafeInteger(first) ||
    first < 1 ||
    versions.some((version) => version !== first)
  ) {
    throw new Error("encrypted writes must use one current user-key version");
  }
  return first;
}

