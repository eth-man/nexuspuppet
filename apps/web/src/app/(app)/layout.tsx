'use client';

import { useEffect, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { AppSidebar } from '@/components/app-sidebar';
import { useAuth } from '@/providers/auth-provider';

/**
 * Authenticated shell.
 *
 * The redirect here is UX, not security — the API rejects unauthenticated
 * requests regardless. Rendering nothing while `loading` avoids the flash of a
 * login screen for a user who is in fact signed in.
 */
export default function AppLayout({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (status === 'anonymous') router.replace('/login');
  }, [status, router]);

  if (status !== 'authenticated') {
    return (
      <div className="flex h-screen items-center justify-center text-sm text-ink-faint">
        {status === 'loading' ? 'Loading session…' : 'Redirecting to sign in…'}
      </div>
    );
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <AppSidebar />
      {/* Fluid width, never boxed: the inventory table must be free to use
          every available pixel. Scrolling is per-pane so the shell stays put. */}
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
    </div>
  );
}
