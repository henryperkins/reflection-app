export class IdentityError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 503,
    readonly code: string,
  ) {
    super(code);
  }
}
export interface Session {
  subjectId: string;
  epoch: number;
  authenticatedAt: number;
  passkeyAuthenticatedAt: number | null;
  tokenHash: string;
  csrfToken: string;
  writeFence: string | null;
}
export interface Challenge {
  id: string;
  owner_id: string | null;
  purpose: string;
  challenge_hash: string;
  browser_hash: string;
  auth_epoch: number | null;
  expires_at: number;
  consumed_at: number | null;
}
export interface CredentialRow {
  id: string;
  owner_id: string;
  public_key: ArrayBuffer;
  sign_count: number;
  backed_up: number;
  transports_json: string;
  created_at: number;
}
