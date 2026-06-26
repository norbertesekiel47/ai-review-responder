import { DemoStatusIsland } from './DemoStatusIsland';
import { selfServeSignupEnabled } from '@/lib/auth/flags';

export default function DemoNotFound() {
  const selfServeEnabled = selfServeSignupEnabled();
  return <DemoStatusIsland variant="expired" selfServeEnabled={selfServeEnabled} />;
}
