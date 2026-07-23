import { notFound } from 'next/navigation';
import { Suspense } from 'react';
import { SolicitationPrototype } from './SolicitationPrototype';

// PROTOTYPE — ticket #537 (wayfinder map #528). Throwaway route; lives only on
// branch prototype/537-watch-mode-batch-screen. Three variants of the
// watch-mode batch screen, switchable via ?variant=A|B|C; ?state=empty shows
// the pre-CSV-upload empty state. Never ships: production 404s.
export const dynamic = 'force-dynamic';

export default function SolicitationPrototypePage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return (
    <Suspense fallback={null}>
      <SolicitationPrototype />
    </Suspense>
  );
}
