import type { Metadata } from 'next';
import { selfServeSignupEnabled } from '@/lib/auth/flags';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { FinishSignupClient } from '@/components/auth/FinishSignupClient';
import { noindexRobots } from '@/lib/seo';

export const metadata: Metadata = { title: 'Finish signup · RepWorth', robots: noindexRobots };

export default async function FinishSignupPage() {
  if (!selfServeSignupEnabled()) redirect('/signup');

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
          // through the proxy.
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
