import { RestraintContent } from '@/components/dashboard/restraint/RestraintContent';
import './restraint.css';

/**
 * `/dashboard/analytics/restraint` — the **Restraint tab**.
 *
 * A thin server page: it mounts the client orchestrator and imports the
 * route-colocated stylesheet, so the whole surface is one deletable folder.
 * `force-dynamic` because the payload is per-owner and per-window.
 */
export const dynamic = 'force-dynamic';

export default function RestraintPage() {
  return <RestraintContent />;
}
