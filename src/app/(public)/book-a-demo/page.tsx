import { BookADemoContent } from './BookADemoContent';

export default function BookADemoPage() {
  const selfServeEnabled = process.env.SELF_SERVE_SIGNUP_ENABLED === 'true';
  return <BookADemoContent selfServeEnabled={selfServeEnabled} />;
}
