import { describe, it, expect } from 'vitest';
import { fileHasRawOutboxTopicLiteral, evaluateFindings } from '../outbox-topics-audit';

describe('outbox-topics-audit', () => {
  it('flags a raw outbox topic literal in a job_outbox sql template', () => {
    const src =
      "await sql`INSERT INTO job_outbox (id, topic) VALUES (${id}, 'generate_response')`;";
    expect(fileHasRawOutboxTopicLiteral(src)).toBe(true);
  });

  it('honors the trailing SQL pragma on the offending line', () => {
    const src =
      "await sql`INSERT INTO job_outbox (id, topic) VALUES (${id}, 'generate_response') -- topic-audit-ignore`;";
    expect(fileHasRawOutboxTopicLiteral(src)).toBe(false);
  });

  it('ignores a non-outbox template that mentions the same word', () => {
    const src = "await sql`SELECT 1 FROM responses WHERE kind = 'generate_response'`;";
    expect(fileHasRawOutboxTopicLiteral(src)).toBe(false);
  });

  it('ignores an interpolated ${QUEUE_NAMES.X} template', () => {
    const src =
      'await sql`INSERT INTO job_outbox (id, topic) VALUES (${id}, ${QUEUE_NAMES.GENERATE_RESPONSE})`;';
    expect(fileHasRawOutboxTopicLiteral(src)).toBe(false);
  });

  // ── additional coverage beyond the minimal spec ──

  it('does NOT flag plain prose mentioning a queue name outside sql/tx templates', () => {
    expect(fileHasRawOutboxTopicLiteral(`const label = 'generate_response';`)).toBe(false);
  });

  it('detects a typed sql<Type[]> tagged template (Postgres.js type-argument form)', () => {
    const src =
      "const rows = sql<Row[]>`SELECT 1 FROM job_outbox WHERE topic = 'send_notification'`;";
    expect(fileHasRawOutboxTopicLiteral(src)).toBe(true);
  });

  it('detects a tx-tagged template (sql.begin transaction scope)', () => {
    const src =
      "await tx`INSERT INTO job_outbox (id, topic) VALUES (${id}, 'publish_response')`;";
    expect(fileHasRawOutboxTopicLiteral(src)).toBe(true);
  });

  it('detects a topic IN (...) predicate against the QUEUE_NAMES vocabulary', () => {
    const src =
      "await sql`UPDATE job_outbox SET status='completed' WHERE topic IN ('generate_response', 'send_notification')`;";
    expect(fileHasRawOutboxTopicLiteral(src)).toBe(true);
  });

  it('does NOT flag a job_outbox-mentioning template with no QUEUE_NAMES literal', () => {
    const src = 'await sql`SELECT id FROM job_outbox WHERE aggregate_id = ${id}`;';
    expect(fileHasRawOutboxTopicLiteral(src)).toBe(false);
  });

  it('honors the TS // topic-audit-ignore pragma on the preceding line', () => {
    const src =
      "// topic-audit-ignore: reason\nawait sql`INSERT INTO job_outbox (id, topic) VALUES (${id}, 'auto_post_notice')`;";
    expect(fileHasRawOutboxTopicLiteral(src)).toBe(false);
  });

  it('flags one un-pragma\'d literal even when another literal in the SAME template is pragma\'d', () => {
    // Mirrors the real ON CONFLICT shape: a converted INSERT value alongside a
    // sanctioned-but-un-pragma'd ON CONFLICT predicate literal must still fail.
    const src = `await sql\`
      INSERT INTO job_outbox (id, topic, aggregate_id, status)
      VALUES (\${id}, \${QUEUE_NAMES.PUBLISH_RESPONSE}, \${aggId}, 'pending')
      ON CONFLICT (topic, aggregate_id)
        WHERE topic = 'publish_response'
          AND status IN ('pending', 'dispatching', 'dispatched')
      DO NOTHING
    \`;`;
    expect(fileHasRawOutboxTopicLiteral(src)).toBe(true);
  });

  it('passes once every raw literal in a multi-literal template carries its own pragma', () => {
    const src = `await sql\`
      INSERT INTO job_outbox (id, topic, aggregate_id, status)
      VALUES (\${id}, \${QUEUE_NAMES.PUBLISH_RESPONSE}, \${aggId}, 'pending')
      ON CONFLICT (topic, aggregate_id)
        WHERE topic = 'publish_response' -- topic-audit-ignore
          AND status IN ('pending', 'dispatching', 'dispatched')
      DO NOTHING
    \`;`;
    expect(fileHasRawOutboxTopicLiteral(src)).toBe(false);
  });

  it('does NOT flag a non-sql/tx tagged template (e.g. a SqlExecutor param named db)', () => {
    const src =
      "await db`INSERT INTO job_outbox (id, topic) VALUES (${id}, 'generate_response')`;";
    expect(fileHasRawOutboxTopicLiteral(src)).toBe(false);
  });

  describe('evaluateFindings', () => {
    it('is STRICT — every matching file becomes a finding, no baseline exemption', () => {
      const findings = evaluateFindings(['worker/jobs/Example.ts']);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain('worker/jobs/Example.ts');
      expect(findings[0]).toContain('import QUEUE_NAMES from src/lib/shared/queue-names');
    });

    it('returns no findings for an empty match set', () => {
      expect(evaluateFindings([])).toEqual([]);
    });
  });
});
