import type { Metadata } from 'next';
import { MfaChallengeScreen } from './MfaChallengeForm';

export const metadata: Metadata = { title: 'Verify your identity | RepWorth' };

export default function MfaChallengePage() {
  return <MfaChallengeScreen />;
}
