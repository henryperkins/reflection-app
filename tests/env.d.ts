import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      RECOVERY: R2Bucket;
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
