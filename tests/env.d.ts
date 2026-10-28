import type { OfflineControl } from '../src/worker/recovery/hosted-coordinator.ts';
import type { D1Migration } from 'cloudflare:test';

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      MIGRATION_DB: D1Database;
      RECOVERY: R2Bucket;
      BACKUP_INVENTORY: R2Bucket;
      OFFLINE_COORDINATOR: DurableObjectNamespace<OfflineControl>;
      TEST_MIGRATIONS: D1Migration[];
      QUIESCENCE_TRUST: string;
      TEST_QUIESCENCE_SIGNING_KEY: string;
      RECOVERY_VALIDATION_TRUST: string;
      TEST_RECOVERY_VALIDATION_SIGNING_KEY: string;
    }
  }
}
