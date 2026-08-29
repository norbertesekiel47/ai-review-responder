import { RestraintContent } from '@/components/dashboard/restraint/RestraintContent';
import './restraint.css';

export const dynamic = 'force-dynamic';

/**
 * `/dashboard/analytics/restraint` — the **Restraint tab** (CONTEXT.md, LOCKED):
 * the window's total refusal count and its breakdown by **Refusal category**.
 * Display only — this surface records no refusal, changes no gate, and writes
 * nothing.
 *
 * A route leaf, and nothing more (`analytics/page.tsx` is the same two lines):
 * the scope, the window and the fetch live in `RestraintContent`, which needs
 * to be a client component for all three. T6 shipped this file as a standing
 * shell so its only blocking edge stayed T0; T7 replaced that shell with the
 * real screen, and the loading branch moved into the orchestrator where the
 * other branches are.
 *
 * The stylesheet stays imported HERE, colocated with the route, so the whole
 * surface remains one deletable folder — matching requests.css / contacts.css.
 */
export default function RestraintPage() {
  return <RestraintContent />;
}
