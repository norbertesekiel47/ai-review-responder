import { DemoStatusIsland } from './DemoStatusIsland';

export default function DemoNotFound() {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  return <DemoStatusIsland variant="expired" selfServeEnabled={selfServeEnabled} />;
}
