import * as Sentry from '@sentry/node';
import { scrubSentryEvent } from '../src/lib/shared/sentry-scrub';
import { readReplicaIdentity, replicaIdentityFields } from './config/replica-identity';

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment: process.env.NODE_ENV ?? 'development',
  beforeSend(event) {
    return scrubSentryEvent(event, { scrubRequestData: true });
  },
});

// Tag every event with which replica produced it (#567). The worker is
// single-replica by invariant and nothing inside the process can prove it, so
// this is the detection surface: two distinct `replica_id` values on events
// from one `deployment_id` means the service was scaled horizontally, which the
// scaling backlog's P2 items are not yet safe for. Identity values are Railway
// system variables — infrastructure metadata, never customer data.
for (const [key, value] of Object.entries(replicaIdentityFields(readReplicaIdentity()))) {
  Sentry.setTag(key, value);
}

export { Sentry };
