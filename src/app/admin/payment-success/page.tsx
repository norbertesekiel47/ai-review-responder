import { PaymentSuccessContent } from './PaymentSuccessContent';

export default async function PaymentSuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { session_id } = await searchParams;
  return (
    <div className="min-h-screen bg-gray-50 flex items-center justify-center px-4">
      <PaymentSuccessContent sessionId={session_id ?? null} />
    </div>
  );
}
