import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';

export const metadata: Metadata = {
  title: 'NexusPuppet',
  description: 'Puppet estate console — inventory, reports, and node classification',
};

/**
 * Dense ops-console shell, dark-first, per the intake's design inputs.
 * Theme follows the system preference and is overridable via data-theme.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-slate-950 text-slate-100 antialiased">{children}</body>
    </html>
  );
}
