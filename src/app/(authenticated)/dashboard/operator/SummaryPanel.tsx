'use client';

import type { OwnerConversationSummary } from '@/lib/agents/operator/reads';
import './operator.css';

export interface SummaryPanelProps {
  summary: OwnerConversationSummary | null;
  /** Shown instead of the blocks when the scope is `all` and nothing is chosen. */
  hint: string | null;
}

/** T5 owns the body. */
export function SummaryPanel({ summary, hint }: SummaryPanelProps) {
  if (summary === null) return <aside className="op-panel">{hint}</aside>;
  return <aside className="op-panel" />;
}
