import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/providers/auth-provider';
import { QueryProvider } from '@/providers/query-provider';
import './globals.css';

export const metadata: Metadata = {
  title: 'NexusPuppet',
  description: 'Puppet estate console — inventory, run reports, and node classification',
};

/**
 * Dark-only. This is an ops tool that lives on a wall display or a second
 * monitor in a dim room; a light theme would be a second surface vocabulary to
 * maintain for no operator benefit.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-surface font-sans text-ink antialiased">
        <QueryProvider>
          <AuthProvider>{children}</AuthProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
