import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";

import { IDENTITY_A, resetDb, seedUser, USER_A } from "../../test/helpers.js";
import {
  buildCryptoWriteFence,
  requireSingleCryptoWriteVersion,
} from "./crypto-write-fence.js";

beforeEach(async () => {
  await resetDb();
  await seedUser(IDENTITY_A);
});

describe("crypto write fence", () => {
  it("admits the current live key while the user is writable", async () => {
    await expect(env.DB.batch([
      buildCryptoWriteFence(env, {
        userId: USER_A,
        keyVersion: 1,
        allowedStatuses: ["active"],
      }),
    ])).resolves.toHaveLength(1);
  });

  it("aborts the batch when a rotation fence is active", async () => {
    await env.DB.prepare(
      "UPDATE users SET crypto_write_fence = ? WHERE id = ?",
    ).bind("cop_00000000000000000000000000000001", USER_A).run();

    await expect(env.DB.batch([
      buildCryptoWriteFence(env, {
        userId: USER_A,
        keyVersion: 1,
        allowedStatuses: ["active", "frozen"],
      }),
    ])).rejects.toThrow();
  });

  it("aborts for a stale key version or disallowed status", async () => {
    await expect(env.DB.batch([
      buildCryptoWriteFence(env, {
        userId: USER_A,
        keyVersion: 2,
        allowedStatuses: ["active"],
      }),
    ])).rejects.toThrow();

    await env.DB.prepare("UPDATE users SET status = 'frozen' WHERE id = ?")
      .bind(USER_A).run();
    await expect(env.DB.batch([
      buildCryptoWriteFence(env, {
        userId: USER_A,
        keyVersion: 1,
        allowedStatuses: ["active"],
      }),
    ])).rejects.toThrow();
  });
});

describe("single crypto write version", () => {
  it("returns the one shared version", () => {
    expect(requireSingleCryptoWriteVersion([3, 3, 3])).toBe(3);
  });

  it("rejects empty or mixed version sets", () => {
    expect(() => requireSingleCryptoWriteVersion([])).toThrow();
    expect(() => requireSingleCryptoWriteVersion([3, 4])).toThrow();
  });
});

