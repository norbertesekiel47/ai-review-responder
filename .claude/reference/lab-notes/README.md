# RepWorth — Lab Notes

Hard-won discoveries from production debugging and integration work.
Check the relevant section before implementing anything in these areas.

One subject per page, current rules first, dated history separated. Every page a pointer lands on is ≤ 3,000 words; history files ≤ 15,000.

## Topic index

Jump to the dated entries by subsystem (search the anchors below):
each topic page carries the index bullet verbatim under "Summary", the canonical entries, and pointers into `history/`.

| Topic | Page |
|---|---|
| Postgres.js / JSONB / PgBouncer | [postgres.md](postgres.md) |
| Indexes / migrations | [migrations.md](migrations.md) |
| Zernio | [zernio.md](zernio.md) |
| Stripe | [stripe.md](stripe.md) |
| Supabase auth | [supabase-auth.md](supabase-auth.md) |
| Billing / multi-location | [billing-multi-location.md](billing-multi-location.md) |
| Analytics / PostHog | [analytics-posthog.md](analytics-posthog.md) |
| Moderation / logging | [moderation-logging.md](moderation-logging.md) |
| Ingress / rate limiting | [ingress-rate-limiting.md](ingress-rate-limiting.md) |
| CI / tooling | [ci-tooling.md](ci-tooling.md) |
| Solicitation / CSV ingest | [solicitation-csv-ingest.md](solicitation-csv-ingest.md) |
| Worker startup / Sentry | [worker-startup-sentry.md](worker-startup-sentry.md) |
| Live-DB test suites | [live-db-test-suites.md](live-db-test-suites.md) |
| False coverage / mutation | [false-coverage-mutation.md](false-coverage-mutation.md) |
| Testing | [testing.md](testing.md) |
| Frontend / CSS / brand | [frontend-css-brand.md](frontend-css-brand.md) |
| Owner offboarding | [owner-offboarding.md](owner-offboarding.md) |
| Worker crash-net / cost-guard | [worker-crash-net-cost-guard.md](worker-crash-net-cost-guard.md) |
| Vercel BotID / WAF | [vercel-botid-waf.md](vercel-botid-waf.md) |

Each topic page has three sections: **Summary** (the one-bullet current rule, formerly the topic-index bullet), **Canonical entries** (the full-mechanics sections CLAUDE.md cites by heading, moved verbatim), and **History** (pointers `history/<range>.md § "<entry heading>"` to the dated entries about the topic).

## History files

Dated entries (`## YYYY-MM-DD — <title>`) in original order, verbatim. Where a canonical section was moved to a topic page the history file keeps its heading line plus a one-line pointer.

| File | Entries |
|---|---|
| [history/2026-04.md](history/2026-04.md) | 2026-04-09 … 2026-04-29 |
| [history/2026-05.md](history/2026-05.md) | 2026-05-02 … 2026-05-29 |
| [history/2026-06.md](history/2026-06.md) | 2026-06-04 … 2026-06-22 |
| [history/2026-07.md](history/2026-07.md) | 2026-07-02 … 2026-07-26 |
| [history/2026-08-01-to-07.md](history/2026-08-01-to-07.md) | 2026-08-01 … 2026-08-07 |
| [history/2026-08-08.md](history/2026-08-08.md) | the 2026-08-08 entries |
| [history/2026-08-09-to-12.md](history/2026-08-09-to-12.md) | 2026-08-09 … 2026-08-12 |
| [history/2026-08-13-to-21.md](history/2026-08-13-to-21.md) | 2026-08-13 … 2026-08-21 (Supabase MCP) |
| [history/2026-08-21-to-31.md](history/2026-08-21-to-31.md) | 2026-08-21 #898 … 2026-08-31 G.3 |
| [history/2026-09.md](history/2026-09.md) | 2026-09-01 … 2026-09-04 |

Historical documents cite `lab-notes "<heading>"`: search this directory for the quoted heading — canonical headings live on the topic page, dated ones in `history/`.

## How to add a lab note

1. Append a dated entry to the newest `history/` file. Format: `## YYYY-MM-DD — <title>`, then bullets `[DATE] WHAT FAILED → WHY → CORRECT APPROACH`.
2. If the finding changes a current rule, edit the topic page's Summary bullet or Canonical section (one owner per fact — the history entry keeps the story, the topic page keeps the rule) and keep the page under 3,000 words.
3. Start a new history file when the current one passes 15,000 words (`wc -w`); name it by date range and add its row to the table above.
4. Never delete history — archive. A superseded entry gets a `[SUPERSEDED <date>]` marker or a pointer to what replaced it, never a deletion.
