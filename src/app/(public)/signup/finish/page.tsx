import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { FinishSignupClient } from '@/components/auth/FinishSignupClient';

export default async function FinishSignupPage() {
  if (process.env.SELF_SERVE_SIGNUP_ENABLED !== 'true') redirect('/signup');

  const cookieStore = await cookies();
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // Read-only — page-level SSR never rewrites session cookies.
          // Any refresh the browser needs happens on the next navigation
          // through the middleware.
        },
      },
    },
  );
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/signup');

  const fullName =
    typeof user.user_metadata?.full_name === 'string'
      ? user.user_metadata.full_name
      : '';

  return (
    <FinishSignupClient
      defaultEmail={user.email ?? ''}
      defaultName={fullName}
    />
  );
}
