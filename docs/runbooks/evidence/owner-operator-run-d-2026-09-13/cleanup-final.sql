-- Run D cleanup, staging kubdiqdhqbhwmqfditeg ONLY. Prepared; not executed by author.
-- Owner explicitly ended observation early; final capture 2026-09-14T17:36:31.857381Z.
-- Actual observation: 19h50m14.857381s; full_24_hours_elapsed=false.
-- Execute only AFTER retained recovery browser evidence, synthetic signout,
-- zero Auth sessions, and exact terminal queue-job removal/readback.
-- No Auth deletion here: use the exact email-checked Auth helper after SQL commit.
-- Unknown fixture references, drift, or any guard failure abort the whole transaction.
-- Section A is read-only preinventory. Retain its result before executing Section B.

-- SECTION A: READ-ONLY PREINVENTORY
SELECT 'account_audit_log' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.account_audit_log WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR actor_user_id::text='019f43d0-0000-7000-8000-000000000002' OR location_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'account_offboarding_tokens' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.account_offboarding_tokens WHERE consumed_by_user_id::text='019f43d0-0000-7000-8000-000000000002' OR created_by_user_id::text='019f43d0-0000-7000-8000-000000000002' OR revoked_by_user_id::text='019f43d0-0000-7000-8000-000000000002'
UNION ALL
SELECT 'account_offboardings' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.account_offboardings WHERE account_id='019f43d0-0000-7000-8000-000000000001'
UNION ALL
SELECT 'accounts' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.accounts WHERE owner_user_id::text='019f43d0-0000-7000-8000-000000000002'
UNION ALL
SELECT 'admin_audit_log' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.admin_audit_log WHERE actor_user_id::text='019f43d0-0000-7000-8000-000000000002'
UNION ALL
SELECT 'agent_conversations' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.agent_conversations WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR created_by_user_id::text='019f43d0-0000-7000-8000-000000000002'
UNION ALL
SELECT 'agent_outcomes' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.agent_outcomes WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR agent_run_id='01a09caf-81a2-70eb-8061-2c372a96dd78' OR business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'agent_proposals' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.agent_proposals WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR actor_user_id::text='019f43d0-0000-7000-8000-000000000002' OR decided_by_user_id::text='019f43d0-0000-7000-8000-000000000002' OR location_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'agent_run_steps' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.agent_run_steps WHERE agent_run_id='01a09caf-81a2-70eb-8061-2c372a96dd78'
UNION ALL
SELECT 'agent_runs' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.agent_runs WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'agent_turns' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.agent_turns WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR actor_user_id::text='019f43d0-0000-7000-8000-000000000002' OR location_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'agent_unsupported_requests' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.agent_unsupported_requests WHERE account_id='019f43d0-0000-7000-8000-000000000001'
UNION ALL
SELECT 'analytics_events' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.analytics_events WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012') OR user_id::text='019f43d0-0000-7000-8000-000000000002'
UNION ALL
SELECT 'api_costs' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.api_costs WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012') OR response_id='01a09caf-9893-76dd-8f8c-0a8f41f3d67d'
UNION ALL
SELECT 'api_costs_daily_rollups' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.api_costs_daily_rollups WHERE business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'approval_audit_log' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.approval_audit_log WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR actor_user_id::text='019f43d0-0000-7000-8000-000000000002' OR business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012') OR response_id='01a09caf-9893-76dd-8f8c-0a8f41f3d67d'
UNION ALL
SELECT 'approval_links' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.approval_links WHERE business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012') OR response_id='01a09caf-9893-76dd-8f8c-0a8f41f3d67d'
UNION ALL
SELECT 'auto_approval_policies' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.auto_approval_policies WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR location_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'businesses' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.businesses WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR onboarded_by::text='019f43d0-0000-7000-8000-000000000002'
UNION ALL
SELECT 'channel_enrollments' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.channel_enrollments WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012') OR location_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'competitor_snapshots' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.competitor_snapshots WHERE business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'contact_csv_uploads' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.contact_csv_uploads WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR attested_by_user_id::text='019f43d0-0000-7000-8000-000000000002' OR business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'flagged_responses' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.flagged_responses WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012') OR response_id='01a09caf-9893-76dd-8f8c-0a8f41f3d67d' OR review_id='01a09caf-8108-73db-8cd3-a5dcf3dc6dce' OR reviewed_by_user_id::text='019f43d0-0000-7000-8000-000000000002'
UNION ALL
SELECT 'google_connections' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.google_connections WHERE business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'impersonation_sessions' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.impersonation_sessions WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR actor_user_id::text='019f43d0-0000-7000-8000-000000000002' OR impersonated_user_id::text='019f43d0-0000-7000-8000-000000000002'
UNION ALL
SELECT 'judge_verdicts' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.judge_verdicts WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR agent_run_id='01a09caf-81a2-70eb-8061-2c372a96dd78' OR business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012') OR response_id='01a09caf-9893-76dd-8f8c-0a8f41f3d67d' OR review_id='01a09caf-8108-73db-8cd3-a5dcf3dc6dce'
UNION ALL
SELECT 'monthly_impact_emails' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.monthly_impact_emails WHERE business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'notification_deliveries' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.notification_deliveries WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012') OR response_id='01a09caf-9893-76dd-8f8c-0a8f41f3d67d'
UNION ALL
SELECT 'onboarding_demos' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.onboarding_demos WHERE business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012') OR user_id::text='019f43d0-0000-7000-8000-000000000002'
UNION ALL
SELECT 'onboarding_drip_log' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.onboarding_drip_log WHERE business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'prospect_demos' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.prospect_demos WHERE created_by::text='019f43d0-0000-7000-8000-000000000002'
UNION ALL
SELECT 'ranking_snapshots' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.ranking_snapshots WHERE business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'refusal_events' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.refusal_events WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'responses' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.responses WHERE business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012') OR review_id='01a09caf-8108-73db-8cd3-a5dcf3dc6dce'
UNION ALL
SELECT 'review_escalations' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.review_escalations WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR agent_run_id='01a09caf-81a2-70eb-8061-2c372a96dd78' OR business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012') OR review_id='01a09caf-8108-73db-8cd3-a5dcf3dc6dce'
UNION ALL
SELECT 'review_exceptions' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.review_exceptions WHERE business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012') OR response_id='01a09caf-9893-76dd-8f8c-0a8f41f3d67d' OR review_id='01a09caf-8108-73db-8cd3-a5dcf3dc6dce'
UNION ALL
SELECT 'reviews' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.reviews WHERE business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'satisfaction_responses' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.satisfaction_responses WHERE business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'solicitation_asks' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.solicitation_asks WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR agent_run_id='01a09caf-81a2-70eb-8061-2c372a96dd78' OR business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'solicitation_batches' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.solicitation_batches WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR approved_by_user_id::text='019f43d0-0000-7000-8000-000000000002' OR business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012') OR halted_by::text='019f43d0-0000-7000-8000-000000000002'
UNION ALL
SELECT 'solicitation_consent' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.solicitation_consent WHERE attested_by_user_id::text='019f43d0-0000-7000-8000-000000000002' OR business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'solicitation_contacts' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.solicitation_contacts WHERE business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'solicitation_outreach' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.solicitation_outreach WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR agent_run_id='01a09caf-81a2-70eb-8061-2c372a96dd78' OR business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'solicitation_send_breaker' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.solicitation_send_breaker WHERE reset_by::text='019f43d0-0000-7000-8000-000000000002'
UNION ALL
SELECT 'solicitation_suppression_corrections' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.solicitation_suppression_corrections WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR created_by_user_id::text='019f43d0-0000-7000-8000-000000000002'
UNION ALL
SELECT 'solicitation_suppressions' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.solicitation_suppressions WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR created_by_user_id::text='019f43d0-0000-7000-8000-000000000002'
UNION ALL
SELECT 'solicitation_unsubscribe_tokens' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.solicitation_unsubscribe_tokens WHERE account_id='019f43d0-0000-7000-8000-000000000001' OR business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'solicitation_visits' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.solicitation_visits WHERE business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'users' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.users WHERE account_id='019f43d0-0000-7000-8000-000000000001'
UNION ALL
SELECT 'weekly_summaries' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.weekly_summaries WHERE business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'zernio_backfill_runs' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.zernio_backfill_runs WHERE business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'zernio_connections' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.zernio_connections WHERE business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'zernio_finalize_incidents' AS table_name,count(*)::int AS count,COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb) AS ids FROM public.zernio_finalize_incidents WHERE business_id IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'job_outbox', count(*)::int, COALESCE(jsonb_agg(id::text ORDER BY id::text),'[]'::jsonb)
FROM public.job_outbox WHERE id IN ('01a09cac-52a2-773f-aba7-3e2ec11da07d','01a09caf-82ca-779c-b401-a49ce70f5ebd','01a09cb7-6f4c-7653-a6dc-e338e2f5b6cc','01a09cbd-9d1b-7429-8c18-c6c667fb9802','01a09cf3-8473-73bc-8236-53660f227a50','01a09d2a-63b2-752f-9b98-96addccb7a33','01a09d61-5b88-76cc-b494-8bdb351d18e1','01a09d98-3b7f-765a-8a04-c57d2c49a207','01a09dcf-327f-777f-8dcc-dac26092de0a','01a09e06-1aa7-730f-a0ba-8ca70b506e6a','01a09e3d-1544-7158-aaea-7ca51ab72640','01a09e74-2845-73ee-90ee-3a4bfb9f62e1','01a09e74-d64c-70fa-a0c5-9418790c5a69','01a09e76-f7ba-70df-b157-339d42992934','01a09e76-fa9e-77a1-8453-006473b7349e','01a09eaa-df0d-742f-85c4-abb0aef93eb7','01a09ee1-ea4d-7548-bb31-55c19f994a60','01a09f19-0b14-713d-95c1-6217249acaa7','01a09f4f-a1c2-708c-b264-9fa91546684d','01a09f86-a216-7218-8dce-a61962c09de5','01a09fbd-9f56-72b8-b4d2-38e1b465c5df','01a09ff4-897b-7259-af50-15552b372aa6','01a0a02b-92f8-77f3-be95-76fefc5d46f2','01a0a02b-95c8-7122-84b8-83c8c74d01fb','01a0a062-551f-731c-9b7f-ee01cfeda33c','01a0a099-4230-763b-9bc2-e718ea9613c2','01a0a0d0-39d8-76dc-bacd-fe09a4fc072e');

-- SECTION B: ONE TRANSACTION. Run this section as a whole, never individual DELETEs.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
CREATE TEMP TABLE run_d_cleanup_manifest (table_name text NOT NULL, id text NOT NULL,
  PRIMARY KEY(table_name,id)) ON COMMIT DROP;
INSERT INTO run_d_cleanup_manifest
SELECT e.key, jsonb_array_elements_text(e.value)
FROM jsonb_each($manifest$
{
  "accounts": [
    "019f43d0-0000-7000-8000-000000000001"
  ],
  "agent_conversations": [
    "019f43d0-0000-7000-8000-000000000031",
    "2d4ae2aa-73df-40e9-8ac8-05a05ce7f8f4"
  ],
  "agent_outcomes": [
    "01a09caf-9adb-758a-a5f6-1fabf1f2dd0a"
  ],
  "agent_proposals": [
    "01a09cac-637e-72dc-8253-06ad15ccbba3",
    "01a09cb7-b9e3-72fc-9b59-7c2662e46d3f",
    "01a09cbd-b5dc-7408-aaf4-c38bfb4e9a30"
  ],
  "agent_run_steps": [
    "01a09caf-8288-702c-80d6-7a6a82e9ce15",
    "01a09caf-9a11-723e-a313-a1921046ee9d",
    "01a09caf-9aa8-75e2-891a-48522d3b44fb",
    "01a09caf-9b76-76bd-9164-2853376d73d8"
  ],
  "agent_runs": [
    "01a09caf-81a2-70eb-8061-2c372a96dd78"
  ],
  "agent_turns": [
    "019f43d0-0000-7000-8000-000000000032",
    "01a09cac-5183-7656-a8a4-1aa156cd2135",
    "01a09cb7-6e5a-746f-8140-467aaf458ddb",
    "01a09cbd-9c25-7079-8022-2f0474ae6d59",
    "01a09cf3-836c-71c3-b689-2eefd8778f72",
    "01a09d2a-62bb-7063-90d1-0d0022e9f059",
    "01a09d61-5a96-705d-9040-30c14aa9bf75",
    "01a09d98-3a79-7369-97af-5d7eb8694009",
    "01a09dcf-316d-73ee-8119-fa8c36d66966",
    "01a09e06-19b4-755f-b383-23addef5b2c7",
    "01a09e3d-1442-71ac-baf7-51478000553a",
    "01a09e74-2738-7037-880e-e3f565383a0e",
    "01a09e74-d531-75a5-9018-96bfa894380d",
    "01a09e76-f6b6-771c-94cd-1d6a0992ced7",
    "01a09e76-f98e-7327-952f-8c9ce71438d9",
    "01a09eaa-de01-727f-8db6-9d76bb6c3def",
    "01a09ee1-e92b-728b-8554-7f28fb21a6ad",
    "01a09f19-0a1d-71b8-9908-56aab64cbffa",
    "01a09f4f-a0bd-74e7-8a95-63bee25bb682",
    "01a09f86-a12a-716c-9bb6-10cdb724c296",
    "01a09fbd-9e48-7318-9515-43bfed47373a",
    "01a09ff4-8887-7199-808e-8d10a6acae15",
    "01a0a02b-91e3-7229-b476-8e7aa2768796",
    "01a0a02b-94c4-7640-9db7-2dbcc7cbf9d1",
    "01a0a062-542a-729c-97ba-ccfbc215c82e",
    "01a0a099-4132-777d-9681-01ad4b0e3614",
    "01a0a0d0-38c3-720c-acc4-66b56eb7b3de"
  ],
  "analytics_events": [
    "01a09caf-8358-75fe-ba5c-2eeace158ec6",
    "01a09caf-9bf9-7052-8a91-ba7d0ed975be"
  ],
  "api_costs": [
    "01a09cac-62f8-727c-acc4-92df4bd3f2be",
    "01a09caf-92d7-7104-a1ae-053b9c4e0453",
    "01a09cb7-b95f-7179-b757-7c4ab4d11cc7",
    "01a09cbd-b541-76e9-b290-b30318e99b3f",
    "01a09cf3-998c-746b-8b4a-10c960193d79",
    "01a09d2a-7839-7006-a134-e596de438b5c",
    "01a09d61-6bbd-72ae-9da5-ab49ee6525e0",
    "01a09d98-4ab3-74ec-8940-d5a426aba356",
    "01a09dcf-3ee6-778f-b3dd-b37e13785d7c",
    "01a09e06-3078-74c3-a3ae-c3c1c3b288e4",
    "01a09e3d-23f6-72fd-83a1-1e0e2cdcd8ba",
    "01a09e74-4036-7133-aa2a-297d69789d9a",
    "01a09e74-e897-70e0-860e-73059d0ebd02",
    "01a09e77-0d3e-71f3-8daa-5efb9a2cdf4f",
    "01a09e77-3784-7762-8f42-c61e4fa08d83",
    "01a09eaa-f71f-71dc-a85e-8c21bb4ff75e",
    "01a09ee1-fced-77f9-af45-faf65b6516bb",
    "01a09f19-2a33-7367-8a82-6764633f0346",
    "01a09f4f-bd3e-7019-88f5-99c2128fffb3",
    "01a09f86-b08e-7730-ae9e-3bff5fd56a16",
    "01a09fbd-b76f-73f9-81f4-ab9e900e8ee4",
    "01a09ff4-a8b0-7029-b0a9-9062845e4ad7",
    "01a0a02b-b0f1-716a-83c6-2aa2017902db",
    "01a0a02b-d49f-7561-a205-3a9882cfc000",
    "01a0a062-6a30-71f4-b3ef-39eca4062b2d",
    "01a0a099-5e45-7562-94d4-e63553226881",
    "01a0a0d0-5122-71cc-ba16-85113d101166"
  ],
  "businesses": [
    "019f43d0-0000-7000-8000-000000000011",
    "019f43d0-0000-7000-8000-000000000012"
  ],
  "channel_enrollments": [
    "01a09cae-0e25-720d-acda-a65698430a69"
  ],
  "responses": [
    "01a09caf-9893-76dd-8f8c-0a8f41f3d67d"
  ],
  "reviews": [
    "01a09caf-8108-73db-8cd3-a5dcf3dc6dce"
  ],
  "users": [
    "019f43d0-0000-7000-8000-000000000002"
  ],
  "job_outbox": [
    "01a09cac-52a2-773f-aba7-3e2ec11da07d",
    "01a09caf-82ca-779c-b401-a49ce70f5ebd",
    "01a09cb7-6f4c-7653-a6dc-e338e2f5b6cc",
    "01a09cbd-9d1b-7429-8c18-c6c667fb9802",
    "01a09cf3-8473-73bc-8236-53660f227a50",
    "01a09d2a-63b2-752f-9b98-96addccb7a33",
    "01a09d61-5b88-76cc-b494-8bdb351d18e1",
    "01a09d98-3b7f-765a-8a04-c57d2c49a207",
    "01a09dcf-327f-777f-8dcc-dac26092de0a",
    "01a09e06-1aa7-730f-a0ba-8ca70b506e6a",
    "01a09e3d-1544-7158-aaea-7ca51ab72640",
    "01a09e74-2845-73ee-90ee-3a4bfb9f62e1",
    "01a09e74-d64c-70fa-a0c5-9418790c5a69",
    "01a09e76-f7ba-70df-b157-339d42992934",
    "01a09e76-fa9e-77a1-8453-006473b7349e",
    "01a09eaa-df0d-742f-85c4-abb0aef93eb7",
    "01a09ee1-ea4d-7548-bb31-55c19f994a60",
    "01a09f19-0b14-713d-95c1-6217249acaa7",
    "01a09f4f-a1c2-708c-b264-9fa91546684d",
    "01a09f86-a216-7218-8dce-a61962c09de5",
    "01a09fbd-9f56-72b8-b4d2-38e1b465c5df",
    "01a09ff4-897b-7259-af50-15552b372aa6",
    "01a0a02b-92f8-77f3-be95-76fefc5d46f2",
    "01a0a02b-95c8-7122-84b8-83c8c74d01fb",
    "01a0a062-551f-731c-9b7f-ee01cfeda33c",
    "01a0a099-4230-763b-9bc2-e718ea9613c2",
    "01a0a0d0-39d8-76dc-bacd-fe09a4fc072e"
  ]
}
$manifest$::jsonb) e;
CREATE TEMP TABLE run_d_cleanup_scopes (table_name text PRIMARY KEY, predicate text NOT NULL) ON COMMIT DROP;
INSERT INTO run_d_cleanup_scopes VALUES
  ('account_audit_log', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR actor_user_id::text=''019f43d0-0000-7000-8000-000000000002'' OR location_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('account_offboarding_tokens', 'consumed_by_user_id::text=''019f43d0-0000-7000-8000-000000000002'' OR created_by_user_id::text=''019f43d0-0000-7000-8000-000000000002'' OR revoked_by_user_id::text=''019f43d0-0000-7000-8000-000000000002'''),
  ('account_offboardings', 'account_id=''019f43d0-0000-7000-8000-000000000001'''),
  ('accounts', 'owner_user_id::text=''019f43d0-0000-7000-8000-000000000002'''),
  ('admin_audit_log', 'actor_user_id::text=''019f43d0-0000-7000-8000-000000000002'''),
  ('agent_conversations', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR created_by_user_id::text=''019f43d0-0000-7000-8000-000000000002'''),
  ('agent_outcomes', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR agent_run_id=''01a09caf-81a2-70eb-8061-2c372a96dd78'' OR business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('agent_proposals', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR actor_user_id::text=''019f43d0-0000-7000-8000-000000000002'' OR decided_by_user_id::text=''019f43d0-0000-7000-8000-000000000002'' OR location_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('agent_run_steps', 'agent_run_id=''01a09caf-81a2-70eb-8061-2c372a96dd78'''),
  ('agent_runs', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('agent_turns', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR actor_user_id::text=''019f43d0-0000-7000-8000-000000000002'' OR location_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('agent_unsupported_requests', 'account_id=''019f43d0-0000-7000-8000-000000000001'''),
  ('analytics_events', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'') OR user_id::text=''019f43d0-0000-7000-8000-000000000002'''),
  ('api_costs', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'') OR response_id=''01a09caf-9893-76dd-8f8c-0a8f41f3d67d'''),
  ('api_costs_daily_rollups', 'business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('approval_audit_log', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR actor_user_id::text=''019f43d0-0000-7000-8000-000000000002'' OR business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'') OR response_id=''01a09caf-9893-76dd-8f8c-0a8f41f3d67d'''),
  ('approval_links', 'business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'') OR response_id=''01a09caf-9893-76dd-8f8c-0a8f41f3d67d'''),
  ('auto_approval_policies', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR location_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('businesses', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR onboarded_by::text=''019f43d0-0000-7000-8000-000000000002'''),
  ('channel_enrollments', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'') OR location_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('competitor_snapshots', 'business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('contact_csv_uploads', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR attested_by_user_id::text=''019f43d0-0000-7000-8000-000000000002'' OR business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('flagged_responses', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'') OR response_id=''01a09caf-9893-76dd-8f8c-0a8f41f3d67d'' OR review_id=''01a09caf-8108-73db-8cd3-a5dcf3dc6dce'' OR reviewed_by_user_id::text=''019f43d0-0000-7000-8000-000000000002'''),
  ('google_connections', 'business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('impersonation_sessions', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR actor_user_id::text=''019f43d0-0000-7000-8000-000000000002'' OR impersonated_user_id::text=''019f43d0-0000-7000-8000-000000000002'''),
  ('judge_verdicts', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR agent_run_id=''01a09caf-81a2-70eb-8061-2c372a96dd78'' OR business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'') OR response_id=''01a09caf-9893-76dd-8f8c-0a8f41f3d67d'' OR review_id=''01a09caf-8108-73db-8cd3-a5dcf3dc6dce'''),
  ('monthly_impact_emails', 'business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('notification_deliveries', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'') OR response_id=''01a09caf-9893-76dd-8f8c-0a8f41f3d67d'''),
  ('onboarding_demos', 'business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'') OR user_id::text=''019f43d0-0000-7000-8000-000000000002'''),
  ('onboarding_drip_log', 'business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('prospect_demos', 'created_by::text=''019f43d0-0000-7000-8000-000000000002'''),
  ('ranking_snapshots', 'business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('refusal_events', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('responses', 'business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'') OR review_id=''01a09caf-8108-73db-8cd3-a5dcf3dc6dce'''),
  ('review_escalations', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR agent_run_id=''01a09caf-81a2-70eb-8061-2c372a96dd78'' OR business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'') OR review_id=''01a09caf-8108-73db-8cd3-a5dcf3dc6dce'''),
  ('review_exceptions', 'business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'') OR response_id=''01a09caf-9893-76dd-8f8c-0a8f41f3d67d'' OR review_id=''01a09caf-8108-73db-8cd3-a5dcf3dc6dce'''),
  ('reviews', 'business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('satisfaction_responses', 'business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('solicitation_asks', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR agent_run_id=''01a09caf-81a2-70eb-8061-2c372a96dd78'' OR business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('solicitation_batches', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR approved_by_user_id::text=''019f43d0-0000-7000-8000-000000000002'' OR business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'') OR halted_by::text=''019f43d0-0000-7000-8000-000000000002'''),
  ('solicitation_consent', 'attested_by_user_id::text=''019f43d0-0000-7000-8000-000000000002'' OR business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('solicitation_contacts', 'business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('solicitation_outreach', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR agent_run_id=''01a09caf-81a2-70eb-8061-2c372a96dd78'' OR business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('solicitation_send_breaker', 'reset_by::text=''019f43d0-0000-7000-8000-000000000002'''),
  ('solicitation_suppression_corrections', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR created_by_user_id::text=''019f43d0-0000-7000-8000-000000000002'''),
  ('solicitation_suppressions', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR created_by_user_id::text=''019f43d0-0000-7000-8000-000000000002'''),
  ('solicitation_unsubscribe_tokens', 'account_id=''019f43d0-0000-7000-8000-000000000001'' OR business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('solicitation_visits', 'business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('users', 'account_id=''019f43d0-0000-7000-8000-000000000001'''),
  ('weekly_summaries', 'business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('zernio_backfill_runs', 'business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('zernio_connections', 'business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')'),
  ('zernio_finalize_incidents', 'business_id IN (''019f43d0-0000-7000-8000-000000000011'',''019f43d0-0000-7000-8000-000000000012'')');
CREATE TEMP TABLE run_d_cleanup_result (table_name text PRIMARY KEY, before_ids jsonb NOT NULL,
  deleted_count bigint NOT NULL DEFAULT 0, remaining_count bigint NOT NULL DEFAULT -1) ON COMMIT DROP;
INSERT INTO run_d_cleanup_result(table_name,before_ids)
SELECT table_name,jsonb_agg(id ORDER BY id) FROM run_d_cleanup_manifest GROUP BY table_name;

DO $guards$
DECLARE
  fixture_account constant uuid := '019f43d0-0000-7000-8000-000000000001';
  fixture_owner constant uuid := '019f43d0-0000-7000-8000-000000000002';
  fixture_auth constant uuid := '856a970a-45a9-43a4-a9a4-71261f7b4fb7';
  r record;
  n bigint;
  join_predicate text;
BEGIN
  IF clock_timestamp() < '2026-09-14T17:36:31.857381Z'::timestamptz THEN
    RAISE EXCEPTION 'Run D final observation capture has not elapsed';
  END IF;
  -- Lock every exact captured row before validating references and state.
  FOR r IN SELECT DISTINCT table_name FROM run_d_cleanup_manifest ORDER BY table_name LOOP
    EXECUTE format('SELECT t.id FROM public.%I t JOIN run_d_cleanup_manifest m ON m.table_name=%L AND m.id=t.id::text ORDER BY t.id FOR UPDATE OF t',r.table_name,r.table_name);
    EXECUTE format('SELECT count(*) FROM public.%I t JOIN run_d_cleanup_manifest m ON m.table_name=%L AND m.id=t.id::text',r.table_name,r.table_name) INTO n;
    IF n <> (SELECT count(*) FROM run_d_cleanup_manifest WHERE table_name=r.table_name) THEN
      RAISE EXCEPTION 'Run D missing or changed manifest rows in %',r.table_name;
    END IF;
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM public.accounts WHERE id=fixture_account
      AND owner_user_id=fixture_owner AND stripe_customer_id IS NULL
      AND stripe_subscription_id IS NULL AND checkout_session_id IS NULL
      AND checkout_attempt_id IS NULL) THEN
    RAISE EXCEPTION 'Run D account identity or external billing changed';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE id=fixture_owner
      AND account_id=fixture_account AND auth_id=fixture_auth::text
      AND email='run-d-c48bb6a6@e2e.repworth.net')
    OR NOT EXISTS (SELECT 1 FROM auth.users WHERE id=fixture_auth
      AND email='run-d-c48bb6a6@e2e.repworth.net') THEN
    RAISE EXCEPTION 'Run D owner/Auth/email mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.sessions WHERE user_id=fixture_auth) THEN
    RAISE EXCEPTION 'Run D synthetic owner must sign out before deletion';
  END IF;
  IF (SELECT count(*) FROM public.businesses WHERE account_id=fixture_account
    AND ((id='019f43d0-0000-7000-8000-000000000011' AND name='Salon')
      OR (id='019f43d0-0000-7000-8000-000000000012' AND name='Cafe'))
    AND stripe_customer_id IS NULL AND stripe_subscription_id IS NULL) <> 2 THEN
    RAISE EXCEPTION 'Run D location identity/billing mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM public.google_connections WHERE business_id IN
      (SELECT id::uuid FROM run_d_cleanup_manifest WHERE table_name='businesses'))
    OR EXISTS (SELECT 1 FROM public.zernio_connections WHERE business_id IN
      (SELECT id::uuid FROM run_d_cleanup_manifest WHERE table_name='businesses')) THEN
    RAISE EXCEPTION 'Run D posting connection present';
  END IF;
  IF EXISTS (SELECT 1 FROM public.responses WHERE id::text IN
      (SELECT id FROM run_d_cleanup_manifest WHERE table_name='responses')
      AND (status <> 'pending_approval' OR approved_at IS NOT NULL
        OR posted_at IS NOT NULL OR approval_method IS NOT NULL
        OR auto_post_scheduled_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'Run D response approved, posted, or scheduled';
  END IF;
  IF EXISTS (SELECT 1 FROM public.agent_turns WHERE account_id=fixture_account
      AND (status NOT IN ('completed','failed') OR
        (status='failed' AND (id <> '019f43d0-0000-7000-8000-000000000032'
          OR failure_reason IS DISTINCT FROM 'dispatch_exhausted')))) THEN
    RAISE EXCEPTION 'Run D active or unexpected failed turn';
  END IF;
  -- Complete current public ownership scopes must exactly equal the captured manifest.
  -- Undelivered synthetic analytics may be pending; an active dispatcher is forbidden.
  IF EXISTS (SELECT 1 FROM public.analytics_events WHERE id::text IN
      (SELECT id FROM run_d_cleanup_manifest WHERE table_name='analytics_events')
      AND locked_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Run D analytics dispatcher still holds a fixture row';
  END IF;
  -- Rows outside this manifest are never silently added to the deletion set.
  FOR r IN SELECT * FROM run_d_cleanup_scopes ORDER BY table_name LOOP
    EXECUTE format('SELECT count(*) FROM public.%I t WHERE (%s) AND NOT EXISTS (SELECT 1 FROM run_d_cleanup_manifest m WHERE m.table_name=%L AND m.id=to_jsonb(t)->>''id'')',r.table_name,r.predicate,r.table_name) INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'Run D unexpected scoped rows in %',r.table_name; END IF;
    EXECUTE format('SELECT count(*) FROM public.%I t WHERE (%s)',r.table_name,r.predicate) INTO n;
    IF n <> (SELECT count(*) FROM run_d_cleanup_manifest WHERE table_name=r.table_name) THEN
      RAISE EXCEPTION 'Run D captured row ownership changed in %',r.table_name;
    END IF;
  END LOOP;
  FOR r IN SELECT DISTINCT table_name FROM run_d_cleanup_manifest LOOP
    EXECUTE format('SELECT count(*) FROM public.%I t JOIN run_d_cleanup_manifest m ON m.table_name=%L AND m.id=t.id::text WHERE ((to_jsonb(t)->>''account_id'') IS NOT NULL AND (to_jsonb(t)->>''account_id'') <> %L) OR ((to_jsonb(t)->>''business_id'') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM run_d_cleanup_manifest b WHERE b.table_name=''businesses'' AND b.id=to_jsonb(t)->>''business_id'')) OR ((to_jsonb(t)->>''location_id'') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM run_d_cleanup_manifest b WHERE b.table_name=''businesses'' AND b.id=to_jsonb(t)->>''location_id''))',r.table_name,r.table_name,fixture_account::text) INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'Run D cross-tenant manifest binding in %',r.table_name; END IF;
  END LOOP;
  -- Check ALL current incoming foreign keys, including composite and SET NULL.
  -- Every referencing row must itself have an exact captured deletion identity.
  -- This prevents cascades or SET NULL from silently touching another tenant or
  -- an unreviewed relation. An unknown relation with fixture references aborts.
  FOR r IN
    SELECT c.oid,c.conrelid,c.confrelid,cn.nspname AS child_schema,
      cc.relname AS child_table,pn.nspname AS parent_schema,pc.relname AS parent_table
    FROM pg_constraint c JOIN pg_class cc ON cc.oid=c.conrelid
    JOIN pg_namespace cn ON cn.oid=cc.relnamespace
    JOIN pg_class pc ON pc.oid=c.confrelid JOIN pg_namespace pn ON pn.oid=pc.relnamespace
    WHERE c.contype='f' AND pn.nspname='public'
      AND pc.relname IN (SELECT table_name FROM run_d_cleanup_manifest)
  LOOP
    SELECT string_agg(format('child.%I=parent.%I',ca.attname,pa.attname),' AND ' ORDER BY k.ordinality)
      INTO join_predicate
    FROM pg_constraint c CROSS JOIN LATERAL unnest(c.conkey,c.confkey) WITH ORDINALITY k(child_att,parent_att,ordinality)
    JOIN pg_attribute ca ON ca.attrelid=c.conrelid AND ca.attnum=k.child_att
    JOIN pg_attribute pa ON pa.attrelid=c.confrelid AND pa.attnum=k.parent_att
    WHERE c.oid=r.oid;
    EXECUTE format('SELECT count(*) FROM %I.%I child JOIN %I.%I parent ON %s JOIN run_d_cleanup_manifest m ON m.table_name=%L AND m.id=parent.id::text WHERE NOT EXISTS (SELECT 1 FROM run_d_cleanup_manifest cm WHERE %L=''public'' AND cm.table_name=%L AND cm.id=to_jsonb(child)->>''id'')',
      r.child_schema,r.child_table,r.parent_schema,r.parent_table,join_predicate,
      r.parent_table,r.child_schema,r.child_table) INTO n;
    IF n <> 0 THEN RAISE EXCEPTION 'Run D unreviewed incoming references in %.% to %',r.child_schema,r.child_table,r.parent_table; END IF;
  END LOOP;
  -- Outbox authority comes from aggregate + relational tenant + exact payload.
  IF EXISTS (SELECT 1 FROM public.job_outbox o JOIN run_d_cleanup_manifest m
      ON m.table_name='job_outbox' AND m.id=o.id::text
      WHERE o.status <> 'completed' OR o.attempts <> 1 OR (
        (o.topic='agent_turn' AND o.aggregate_type='agent_turn' AND EXISTS (
          SELECT 1 FROM public.agent_turns t WHERE t.id=o.aggregate_id
            AND t.account_id=fixture_account
            AND o.payload->>'turn_id'=t.id::text
            AND o.payload->>'account_id'=fixture_account::text
            AND o.payload->>'conversation_id'=t.conversation_id::text))
        OR (o.topic='generate_response' AND o.aggregate_type='review' AND EXISTS (
          SELECT 1 FROM public.reviews v JOIN public.businesses b ON b.id=v.business_id
          WHERE v.id=o.aggregate_id AND b.account_id=fixture_account
            AND v.id='01a09caf-8108-73db-8cd3-a5dcf3dc6dce'
            AND o.payload->>'review_id'=v.id::text
            AND o.payload->>'business_id'=b.id::text))) IS NOT TRUE) THEN
    RAISE EXCEPTION 'Run D outbox terminal state or binding mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM public.job_outbox o WHERE
      (o.aggregate_id::text IN (SELECT id FROM run_d_cleanup_manifest)
       OR EXISTS (SELECT 1 FROM jsonb_each_text(o.payload) kv
         WHERE kv.key IN ('account_id','business_id','location_id','turn_id','review_id','response_id','conversation_id')
           AND kv.value IN (SELECT id FROM run_d_cleanup_manifest)))
      AND NOT EXISTS (SELECT 1 FROM run_d_cleanup_manifest m
        WHERE m.table_name='job_outbox' AND m.id=o.id::text)) THEN
    RAISE EXCEPTION 'Run D unexpected outbox binding/topic';
  END IF;
END;
$guards$;

DO $delete$
DECLARE r text; n bigint;
BEGIN
  -- Children precede parents. Owner/account FKs are initially deferred, remain enabled.
  FOREACH r IN ARRAY ARRAY['job_outbox','analytics_events','api_costs',
    'channel_enrollments','agent_proposals','agent_turns','agent_conversations',
    'agent_outcomes','agent_run_steps','agent_runs','responses','reviews',
    'businesses','users','accounts']
  LOOP
    EXECUTE format('DELETE FROM public.%I t USING run_d_cleanup_manifest m WHERE m.table_name=%L AND m.id=t.id::text',r,r);
    GET DIAGNOSTICS n=ROW_COUNT;
    IF n <> (SELECT count(*) FROM run_d_cleanup_manifest WHERE table_name=r) THEN
      RAISE EXCEPTION 'Run D deletion count drift in %',r;
    END IF;
    UPDATE run_d_cleanup_result SET deleted_count=n WHERE table_name=r;
  END LOOP;
  FOR r IN SELECT DISTINCT table_name FROM run_d_cleanup_manifest LOOP
    EXECUTE format('SELECT count(*) FROM public.%I t JOIN run_d_cleanup_manifest m ON m.table_name=%L AND m.id=t.id::text',r,r) INTO n;
    UPDATE run_d_cleanup_result SET remaining_count=n WHERE table_name=r;
    IF n <> 0 THEN RAISE EXCEPTION 'Run D remaining captured IDs in %',r; END IF;
  END LOOP;
END;
$delete$;
-- Force deferred ownership FKs to validate before the final report.
SET CONSTRAINTS ALL IMMEDIATE;
SELECT clock_timestamp()::text AS verified_at,
  jsonb_agg(to_jsonb(r) ORDER BY table_name) AS deletion_readback
FROM run_d_cleanup_result r;
COMMIT;

-- SECTION C: INDEPENDENT POST-COMMIT READBACK
-- Exact captured IDs remain addressable even after their tenant parents are gone.
SELECT 'accounts' AS table_name,count(*) AS remaining_ids FROM public.accounts WHERE id::text IN ('019f43d0-0000-7000-8000-000000000001')
UNION ALL
SELECT 'agent_conversations' AS table_name,count(*) AS remaining_ids FROM public.agent_conversations WHERE id::text IN ('019f43d0-0000-7000-8000-000000000031','2d4ae2aa-73df-40e9-8ac8-05a05ce7f8f4')
UNION ALL
SELECT 'agent_outcomes' AS table_name,count(*) AS remaining_ids FROM public.agent_outcomes WHERE id::text IN ('01a09caf-9adb-758a-a5f6-1fabf1f2dd0a')
UNION ALL
SELECT 'agent_proposals' AS table_name,count(*) AS remaining_ids FROM public.agent_proposals WHERE id::text IN ('01a09cac-637e-72dc-8253-06ad15ccbba3','01a09cb7-b9e3-72fc-9b59-7c2662e46d3f','01a09cbd-b5dc-7408-aaf4-c38bfb4e9a30')
UNION ALL
SELECT 'agent_run_steps' AS table_name,count(*) AS remaining_ids FROM public.agent_run_steps WHERE id::text IN ('01a09caf-8288-702c-80d6-7a6a82e9ce15','01a09caf-9a11-723e-a313-a1921046ee9d','01a09caf-9aa8-75e2-891a-48522d3b44fb','01a09caf-9b76-76bd-9164-2853376d73d8')
UNION ALL
SELECT 'agent_runs' AS table_name,count(*) AS remaining_ids FROM public.agent_runs WHERE id::text IN ('01a09caf-81a2-70eb-8061-2c372a96dd78')
UNION ALL
SELECT 'agent_turns' AS table_name,count(*) AS remaining_ids FROM public.agent_turns WHERE id::text IN ('019f43d0-0000-7000-8000-000000000032','01a09cac-5183-7656-a8a4-1aa156cd2135','01a09cb7-6e5a-746f-8140-467aaf458ddb','01a09cbd-9c25-7079-8022-2f0474ae6d59','01a09cf3-836c-71c3-b689-2eefd8778f72','01a09d2a-62bb-7063-90d1-0d0022e9f059','01a09d61-5a96-705d-9040-30c14aa9bf75','01a09d98-3a79-7369-97af-5d7eb8694009','01a09dcf-316d-73ee-8119-fa8c36d66966','01a09e06-19b4-755f-b383-23addef5b2c7','01a09e3d-1442-71ac-baf7-51478000553a','01a09e74-2738-7037-880e-e3f565383a0e','01a09e74-d531-75a5-9018-96bfa894380d','01a09e76-f6b6-771c-94cd-1d6a0992ced7','01a09e76-f98e-7327-952f-8c9ce71438d9','01a09eaa-de01-727f-8db6-9d76bb6c3def','01a09ee1-e92b-728b-8554-7f28fb21a6ad','01a09f19-0a1d-71b8-9908-56aab64cbffa','01a09f4f-a0bd-74e7-8a95-63bee25bb682','01a09f86-a12a-716c-9bb6-10cdb724c296','01a09fbd-9e48-7318-9515-43bfed47373a','01a09ff4-8887-7199-808e-8d10a6acae15','01a0a02b-91e3-7229-b476-8e7aa2768796','01a0a02b-94c4-7640-9db7-2dbcc7cbf9d1','01a0a062-542a-729c-97ba-ccfbc215c82e','01a0a099-4132-777d-9681-01ad4b0e3614','01a0a0d0-38c3-720c-acc4-66b56eb7b3de')
UNION ALL
SELECT 'analytics_events' AS table_name,count(*) AS remaining_ids FROM public.analytics_events WHERE id::text IN ('01a09caf-8358-75fe-ba5c-2eeace158ec6','01a09caf-9bf9-7052-8a91-ba7d0ed975be')
UNION ALL
SELECT 'api_costs' AS table_name,count(*) AS remaining_ids FROM public.api_costs WHERE id::text IN ('01a09cac-62f8-727c-acc4-92df4bd3f2be','01a09caf-92d7-7104-a1ae-053b9c4e0453','01a09cb7-b95f-7179-b757-7c4ab4d11cc7','01a09cbd-b541-76e9-b290-b30318e99b3f','01a09cf3-998c-746b-8b4a-10c960193d79','01a09d2a-7839-7006-a134-e596de438b5c','01a09d61-6bbd-72ae-9da5-ab49ee6525e0','01a09d98-4ab3-74ec-8940-d5a426aba356','01a09dcf-3ee6-778f-b3dd-b37e13785d7c','01a09e06-3078-74c3-a3ae-c3c1c3b288e4','01a09e3d-23f6-72fd-83a1-1e0e2cdcd8ba','01a09e74-4036-7133-aa2a-297d69789d9a','01a09e74-e897-70e0-860e-73059d0ebd02','01a09e77-0d3e-71f3-8daa-5efb9a2cdf4f','01a09e77-3784-7762-8f42-c61e4fa08d83','01a09eaa-f71f-71dc-a85e-8c21bb4ff75e','01a09ee1-fced-77f9-af45-faf65b6516bb','01a09f19-2a33-7367-8a82-6764633f0346','01a09f4f-bd3e-7019-88f5-99c2128fffb3','01a09f86-b08e-7730-ae9e-3bff5fd56a16','01a09fbd-b76f-73f9-81f4-ab9e900e8ee4','01a09ff4-a8b0-7029-b0a9-9062845e4ad7','01a0a02b-b0f1-716a-83c6-2aa2017902db','01a0a02b-d49f-7561-a205-3a9882cfc000','01a0a062-6a30-71f4-b3ef-39eca4062b2d','01a0a099-5e45-7562-94d4-e63553226881','01a0a0d0-5122-71cc-ba16-85113d101166')
UNION ALL
SELECT 'businesses' AS table_name,count(*) AS remaining_ids FROM public.businesses WHERE id::text IN ('019f43d0-0000-7000-8000-000000000011','019f43d0-0000-7000-8000-000000000012')
UNION ALL
SELECT 'channel_enrollments' AS table_name,count(*) AS remaining_ids FROM public.channel_enrollments WHERE id::text IN ('01a09cae-0e25-720d-acda-a65698430a69')
UNION ALL
SELECT 'responses' AS table_name,count(*) AS remaining_ids FROM public.responses WHERE id::text IN ('01a09caf-9893-76dd-8f8c-0a8f41f3d67d')
UNION ALL
SELECT 'reviews' AS table_name,count(*) AS remaining_ids FROM public.reviews WHERE id::text IN ('01a09caf-8108-73db-8cd3-a5dcf3dc6dce')
UNION ALL
SELECT 'users' AS table_name,count(*) AS remaining_ids FROM public.users WHERE id::text IN ('019f43d0-0000-7000-8000-000000000002')
UNION ALL
SELECT 'job_outbox' AS table_name,count(*) AS remaining_ids FROM public.job_outbox WHERE id::text IN ('01a09cac-52a2-773f-aba7-3e2ec11da07d','01a09caf-82ca-779c-b401-a49ce70f5ebd','01a09cb7-6f4c-7653-a6dc-e338e2f5b6cc','01a09cbd-9d1b-7429-8c18-c6c667fb9802','01a09cf3-8473-73bc-8236-53660f227a50','01a09d2a-63b2-752f-9b98-96addccb7a33','01a09d61-5b88-76cc-b494-8bdb351d18e1','01a09d98-3b7f-765a-8a04-c57d2c49a207','01a09dcf-327f-777f-8dcc-dac26092de0a','01a09e06-1aa7-730f-a0ba-8ca70b506e6a','01a09e3d-1544-7158-aaea-7ca51ab72640','01a09e74-2845-73ee-90ee-3a4bfb9f62e1','01a09e74-d64c-70fa-a0c5-9418790c5a69','01a09e76-f7ba-70df-b157-339d42992934','01a09e76-fa9e-77a1-8453-006473b7349e','01a09eaa-df0d-742f-85c4-abb0aef93eb7','01a09ee1-ea4d-7548-bb31-55c19f994a60','01a09f19-0b14-713d-95c1-6217249acaa7','01a09f4f-a1c2-708c-b264-9fa91546684d','01a09f86-a216-7218-8dce-a61962c09de5','01a09fbd-9f56-72b8-b4d2-38e1b465c5df','01a09ff4-897b-7259-af50-15552b372aa6','01a0a02b-92f8-77f3-be95-76fefc5d46f2','01a0a02b-95c8-7122-84b8-83c8c74d01fb','01a0a062-551f-731c-9b7f-ee01cfeda33c','01a0a099-4230-763b-9bc2-e718ea9613c2','01a0a0d0-39d8-76dc-bacd-fe09a4fc072e');
-- Re-run Section A: every count and ID array must be zero/empty.
-- Its retained preinventory contains every exact dependent ID, including steps/outboxes.
-- After the email-checked Auth helper deletes only the synthetic identity, run:
SELECT now()::text AS captured_at,
  (SELECT count(*) FROM auth.users WHERE id='856a970a-45a9-43a4-a9a4-71261f7b4fb7') AS auth_users,
  (SELECT count(*) FROM auth.identities WHERE user_id='856a970a-45a9-43a4-a9a4-71261f7b4fb7') AS auth_identities,
  (SELECT count(*) FROM auth.sessions WHERE user_id='856a970a-45a9-43a4-a9a4-71261f7b4fb7') AS auth_sessions,
  (SELECT count(*) FROM auth.refresh_tokens WHERE user_id='856a970a-45a9-43a4-a9a4-71261f7b4fb7') AS auth_refresh_tokens;
