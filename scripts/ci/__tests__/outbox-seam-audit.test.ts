import { describe, it, expect } from 'vitest';
import {
  HELPER_MODULE,
  deriveHelperTopicKeys,
  evaluateFindings,
  findOutboxInserts,
  maskSqlTemplate,
} from '../outbox-seam-audit';

/** Wraps a SQL body in the tagged template the audit scans for. */
const tx = (body: string): string => `await tx\`${body}\`;`;

describe('outbox-seam-audit / maskSqlTemplate', () => {
  it('preserves length so mask offsets index the original', () => {
    const sql = "VALUES (${uuidv7()}, 'topic') -- note";
    expect(maskSqlTemplate(sql)).toHaveLength(sql.length);
  });

  it('blanks interpolations, string literals and line comments', () => {
    const masked = maskSqlTemplate("VALUES (${tx.json(x)}, 'lit') -- ON CONFLICT");
    expect(masked).not.toContain('json');
    expect(masked).not.toContain('lit');
    expect(masked).not.toContain('CONFLICT');
    expect(masked).toContain('VALUES');
  });
});

describe('outbox-seam-audit / findOutboxInserts', () => {
  it('reads a single-row VALUES insert and its QUEUE_NAMES topic', () => {
    const [site] = findOutboxInserts(
      tx(`INSERT INTO job_outbox (id, topic, aggregate_id)
          VALUES (\${id}, \${QUEUE_NAMES.SEND_NOTIFICATION}, \${responseId})`),
    );
    expect(site).toMatchObject({
      shape: 'single-row',
      topic: { kind: 'queue-names', key: 'SEND_NOTIFICATION' },
    });
  });

  it('reads a raw string-literal topic (the legacy notify_owner_* aliases)', () => {
    const [site] = findOutboxInserts(
      tx(`INSERT INTO job_outbox (id, topic, aggregate_id)
          VALUES (\${id}, 'notify_owner_connection_lost', \${businessId})`),
    );
    expect(site?.topic).toEqual({ kind: 'literal', value: 'notify_owner_connection_lost' });
  });

  // The classifier's whole reason to exist. `enqueueValidatePlaceId` — a typed
  // helper — is itself an INSERT … SELECT … WHERE NOT EXISTS inserting one row.
  it('classifies INSERT … SELECT … WHERE NOT EXISTS as SINGLE-ROW, not fan-out', () => {
    const [site] = findOutboxInserts(
      tx(`INSERT INTO job_outbox (id, topic, aggregate_id)
          SELECT \${id}, \${QUEUE_NAMES.SEND_NOTIFICATION}, \${responseId}
          WHERE NOT EXISTS (
            SELECT 1 FROM job_outbox jo WHERE jo.aggregate_id = \${responseId}
          )`),
    );
    expect(site?.shape).toBe('single-row');
  });

  it('classifies INSERT … SELECT … FROM as set-based fan-out', () => {
    const [site] = findOutboxInserts(
      tx(`INSERT INTO job_outbox (id, topic, aggregate_id)
          SELECT gen_random_uuid(), \${QUEUE_NAMES.WEEKLY_SUMMARY}, b.id
          FROM businesses b WHERE b.archived_at IS NULL`),
    );
    expect(site?.shape).toBe('set-based');
  });

  it('treats a multi-tuple VALUES list as set-based', () => {
    const [site] = findOutboxInserts(
      tx(`INSERT INTO job_outbox (id, topic)
          VALUES (\${a}, \${QUEUE_NAMES.NOTIFY_ADMIN}), (\${b}, \${QUEUE_NAMES.NOTIFY_ADMIN})`),
    );
    expect(site?.shape).toBe('set-based');
  });

  // ON CONFLICT (topic, aggregate_id) opens a top-level paren group after the
  // VALUES tuple; counting it would misread a single-row insert as multi-tuple.
  it('does not mistake an ON CONFLICT paren group for a second VALUES tuple', () => {
    const [site] = findOutboxInserts(
      tx(`INSERT INTO job_outbox (id, topic, aggregate_id)
          VALUES (\${id}, \${QUEUE_NAMES.PUBLISH_RESPONSE}, \${responseId})
          ON CONFLICT (topic, aggregate_id)
          WHERE topic = 'publish_response' AND status IN ('pending')
          DO NOTHING`),
    );
    expect(site?.shape).toBe('single-row');
  });

  // The topic is read by column position, so a reordered column list still
  // resolves correctly — a "first quoted literal" heuristic would return
  // 'response' here.
  it('reads the topic positionally, not as the first literal in the row source', () => {
    const [site] = findOutboxInserts(
      tx(`INSERT INTO job_outbox (id, aggregate_type, topic, aggregate_id)
          VALUES (\${id}, 'response', 'notify_owner_reconnect', \${responseId})`),
    );
    expect(site?.topic).toEqual({ kind: 'literal', value: 'notify_owner_reconnect' });
  });

  it('finds every INSERT when one template holds several', () => {
    const sites = findOutboxInserts(
      tx(`INSERT INTO job_outbox (id, topic) VALUES (\${a}, \${QUEUE_NAMES.NOTIFY_ADMIN});
          INSERT INTO job_outbox (id, topic) VALUES (\${b}, \${QUEUE_NAMES.SEND_NOTIFICATION})`),
    );
    expect(sites.map((site) => site.topic)).toEqual([
      { kind: 'queue-names', key: 'NOTIFY_ADMIN' },
      { kind: 'queue-names', key: 'SEND_NOTIFICATION' },
    ]);
  });

  it('drops a site preceded by a standalone ignore-pragma comment line', () => {
    const sites = findOutboxInserts(
      tx(`
          -- outbox-seam-ignore: reason
          INSERT INTO job_outbox (id, topic) VALUES (\${a}, \${QUEUE_NAMES.SEND_NOTIFICATION})`),
    );
    expect(sites).toEqual([]);
  });

  // lineHasPragma is deliberately fail-closed: a CODE line carrying a trailing
  // pragma must not blanket the line below it, or one reviewed exemption would
  // silently cover a different, unreviewed INSERT.
  it('does not let a pragma on a code line exempt the INSERT below it', () => {
    const sites = findOutboxInserts(
      tx(`INSERT INTO job_outbox (id, topic) -- outbox-seam-ignore: reason
          VALUES (\${a}, \${QUEUE_NAMES.SEND_NOTIFICATION});
          INSERT INTO job_outbox (id, topic) VALUES (\${b}, \${QUEUE_NAMES.SEND_NOTIFICATION})`),
    );
    expect(sites).toHaveLength(1);
  });

  it('ignores SQL that does not write job_outbox', () => {
    expect(findOutboxInserts(tx('INSERT INTO responses (id) VALUES (${a})'))).toEqual([]);
  });

  it('reports an unreadable topic rather than skipping it', () => {
    const [site] = findOutboxInserts(
      tx('INSERT INTO job_outbox (id, aggregate_id) VALUES (${a}, ${b})'),
    );
    expect(site?.topic).toBeNull();
  });
});

describe('outbox-seam-audit / deriveHelperTopicKeys', () => {
  const helperSource = `
    export async function enqueueSendNotification(tx: TxClient): Promise<void> {
      await tx\`INSERT INTO job_outbox (id, topic) VALUES (\${id}, \${QUEUE_NAMES.SEND_NOTIFICATION})\`;
    }
    async function enqueueNotExported(tx: TxClient): Promise<void> {
      await tx\`INSERT INTO job_outbox (id, topic) VALUES (\${id}, \${QUEUE_NAMES.NOTIFY_ADMIN})\`;
    }
    export async function markSomethingElse(tx: TxClient): Promise<void> {
      await tx\`INSERT INTO job_outbox (id, topic) VALUES (\${id}, \${QUEUE_NAMES.TRACK_RANKING})\`;
    }
  `;

  it('derives coverage from exported enqueue* functions only', () => {
    expect([...deriveHelperTopicKeys(helperSource)]).toEqual(['SEND_NOTIFICATION']);
  });

  // The real module is the input in production; an empty result would silently
  // legalize every raw INSERT, so main() treats it as fatal.
  it('returns empty for a module with no enqueue helpers', () => {
    expect(deriveHelperTopicKeys('export const x = 1;').size).toBe(0);
  });
});

describe('outbox-seam-audit / evaluateFindings', () => {
  const helperKeys = new Set(['SEND_NOTIFICATION', 'PUBLISH_RESPONSE']);
  const site = (over: Record<string, unknown>) => ({ line: 0, ...over }) as never;

  it('flags a single-row raw INSERT for a helper-owned topic', () => {
    const findings = evaluateFindings(
      [{
        file: 'worker/jobs/x.ts',
        sites: [site({ shape: 'single-row', topic: { kind: 'queue-names', key: 'SEND_NOTIFICATION' } })],
      }],
      helperKeys,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('worker/jobs/x.ts:1');
    expect(findings[0]).toContain('has a typed helper');
  });

  it('allows set-based fan-out even for a helper-owned topic', () => {
    expect(
      evaluateFindings(
        [{
          file: 'worker/jobs/DrainOwnerConnectWorker.ts',
          sites: [site({ shape: 'set-based', topic: { kind: 'queue-names', key: 'PUBLISH_RESPONSE' } })],
        }],
        helperKeys,
      ),
    ).toEqual([]);
  });

  it('allows any shape for a topic with no helper', () => {
    expect(
      evaluateFindings(
        [{
          file: 'worker/jobs/x.ts',
          sites: [site({ shape: 'single-row', topic: { kind: 'queue-names', key: 'NOTIFY_ADMIN' } })],
        }],
        helperKeys,
      ),
    ).toEqual([]);
  });

  // A literal and a QUEUE_NAMES reference naming the same topic must be judged
  // identically, or the raw-literal spelling becomes a silent bypass.
  it('resolves a raw literal topic back through QUEUE_NAMES', () => {
    expect(
      evaluateFindings(
        [{
          file: 'worker/jobs/x.ts',
          sites: [site({ shape: 'single-row', topic: { kind: 'literal', value: 'send_notification' } })],
        }],
        helperKeys,
      ),
    ).toHaveLength(1);
  });

  it('leaves a literal topic that is no queue name alone', () => {
    expect(
      evaluateFindings(
        [{
          file: 'worker/jobs/x.ts',
          sites: [site({ shape: 'single-row', topic: { kind: 'literal', value: 'notify_owner_reconnect' } })],
        }],
        helperKeys,
      ),
    ).toEqual([]);
  });

  it('reports rather than passes an INSERT it could not read', () => {
    const findings = evaluateFindings(
      [{ file: 'worker/jobs/x.ts', sites: [site({ shape: 'unknown', topic: null })] }],
      helperKeys,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('could not classify');
  });

  it('self-excludes the helper module, which holds these INSERTs by definition', () => {
    expect(
      evaluateFindings(
        [{
          file: HELPER_MODULE,
          sites: [site({ shape: 'single-row', topic: { kind: 'queue-names', key: 'SEND_NOTIFICATION' } })],
        }],
        helperKeys,
      ),
    ).toEqual([]);
  });
});
