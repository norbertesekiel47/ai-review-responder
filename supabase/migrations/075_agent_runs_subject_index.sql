-- 075_agent_runs_subject_index.sql
-- WS5: the run-timeline page looks up ALL runs (any status) for a subject.
-- 071's agent_runs_one_active_per_subject is partial (status='running');
-- the other 071 indexes lead on business_id/account_id. This covers the
-- completed-run lookup: WHERE subject_type=? AND subject_id=? ORDER BY started_at DESC.
CREATE INDEX idx_agent_runs_subject
  ON agent_runs (subject_type, subject_id, started_at DESC);
