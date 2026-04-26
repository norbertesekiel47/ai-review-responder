import { notFound } from 'next/navigation';
import { PaymentSuccessClient } from './PaymentSuccessClient';

export default function PaymentSuccessPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') notFound();
  return <PaymentSuccessClient />;
}
