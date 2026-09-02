import { MfaChallengeScreen } from './MfaChallengeForm';

// Title + noindex live on `../layout.tsx` (one owner for the /mfa subtree);
// a page-level override here produced a second, differently-punctuated title.
export default function MfaChallengePage() {
  return <MfaChallengeScreen />;
}
