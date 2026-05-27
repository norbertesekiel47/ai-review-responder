import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ANALYTICS_EVENT_NAMES } from '../../src/lib/analytics/events';

export interface AnalyticsAuditFinding {
  event: string;
  reason: string;
}

const DOC_PATH = 'docs/analytics/events.md';

/** Parse `### \`event_name\`` headings and their `**Status:**` line. */
export function parseDocumentedEvents(docText: string): Map<string, string> {
  const documented = new Map<string, string>();
  const blocks = docText.split(/^###\s+/m).slice(1);
  for (const block of blocks) {
    const nameMatch = /^`([a-z0-9_]+)`/.exec(block.trim());
    if (!nameMatch) continue;
    const statusMatch = /\*\*Status:\*\*\s*([a-z_]+)/i.exec(block);
    documented.set(nameMatch[1]!, (statusMatch?.[1] ?? 'live').toLowerCase());
  }
  return documented;
}

export function auditAnalyticsEvents(
  codeEvents: readonly string[],
  docText: string,
): AnalyticsAuditFinding[] {
  const documented = parseDocumentedEvents(docText);
  const findings: AnalyticsAuditFinding[] = [];

  for (const event of codeEvents) {
    if (!documented.has(event)) {
      findings.push({ event, reason: 'event in code allowlist is undocumented' });
    }
  }
  for (const [event, status] of documented) {
    if (status === 'live' && !codeEvents.includes(event)) {
      findings.push({ event, reason: 'documented live event missing from code allowlist' });
    }
  }
  return findings;
}

async function main(): Promise<void> {
  const docText = await readFile(DOC_PATH, 'utf8');
  const findings = auditAnalyticsEvents(ANALYTICS_EVENT_NAMES, docText);

  if (findings.length > 0) {
    console.error('analytics-events-audit: failed');
    for (const finding of findings) {
      console.error(`${finding.event}: ${finding.reason}`);
    }
    process.exit(1);
  }
  console.log('analytics-events-audit: passed');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().catch((err) => {
    console.error('analytics-events-audit: fatal error');
    console.error(err);
    process.exit(1);
  });
}
