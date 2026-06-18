import { DashboardContent } from '@/components/dashboard/DashboardContent';

// SetupChecklist removed (2026-05-04, PR #2 follow-up): the checklist's
// four items collapsed once the post-pay wizard learned to connect Zernio
// directly. "Connect Zernio" now happens in /onboarding/business StepConnect;
// "Approve first response" is a no-op for new businesses with no reviews
// yet; "Tune your voice" is optional and prompted in-wizard; notification
// preferences are deferred to a future in-app prompt. The component +
// client wrapper files are kept on disk in case we resurrect a tightened
// version later — the import + render are removed here.
//
// import { SetupChecklist } from './SetupChecklist';

export const dynamic = 'force-dynamic';

export default function DashboardPage() {
  // Server-authoritative flag (invariant #13): the reviews zone's "View all
  // replies" link only points to past-replies when the feature is enabled.
  const pastRepliesEnabled = process.env.PAST_REPLIES_VIEW_ENABLED === 'true';
  return <DashboardContent pastRepliesEnabled={pastRepliesEnabled} />;
}
