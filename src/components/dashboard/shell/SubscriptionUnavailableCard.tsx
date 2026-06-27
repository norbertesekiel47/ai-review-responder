import Link from 'next/link';
import { TopBar } from '@/components/dashboard/shell/TopBar';

interface Props {
  /** TopBar title for the surface (e.g. "Analytics", "Reviews"). */
  topBarTitle: string;
  heading: string;
  /** Sentence shown before the "Back to dashboard" link. */
  body: string;
}

/**
 * The "<surface> aren't available right now" state shown when an account has no
 * active subscription. Single owner of this card for the dashboard surfaces that
 * gate on subscription status.
 */
export function SubscriptionUnavailableCard({ topBarTitle, heading, body }: Props) {
  return (
    <>
      <TopBar title={topBarTitle} />
      <div className="content">
        <div className="card">
          <h2 className="card-h2">{heading}</h2>
          <p style={{ fontSize: 14, color: 'var(--rw-app-text-muted)', marginTop: 6, lineHeight: 1.5 }}>
            {body}{' '}
            <Link href="/dashboard" style={{ color: 'var(--rw-sage-deep)', fontWeight: 600 }}>
              Back to dashboard
            </Link>
          </p>
        </div>
      </div>
    </>
  );
}
