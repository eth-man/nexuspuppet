import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AuthProvider } from '@/providers/auth-provider';
import { QueryProvider } from '@/providers/query-provider';
import { ThemeProvider, THEME_BOOTSTRAP } from '@/providers/theme-provider';
import './globals.css';

export const metadata: Metadata = {
  title: 'NexusPuppet',
  description: 'Puppet estate console — inventory, run reports, and node classification',
};

/**
 * Dark by default. This is an ops tool that often lives on a wall display or a
 * second monitor in a dim room, so dark is what it opens as unless somebody has
 * said otherwise — but "otherwise" is now sayable (issue #72 slice 1).
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        {/*
          Runs BEFORE first paint, which is the whole point.

          Resolving the theme in React means the page has already painted in
          whatever the server assumed by the time the client corrects it — a
          white flash on every load for anyone who chose dark, or the reverse.
          The server cannot know which to send: the preference lives in
          localStorage and in the OS, and neither travels with the request.

          `suppressHydrationWarning` is required on <html> precisely because
          this script mutates the attribute React rendered.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body className="min-h-screen bg-surface font-sans text-ink antialiased">
        <QueryProvider>
          <ThemeProvider>
            <AuthProvider>{children}</AuthProvider>
          </ThemeProvider>
        </QueryProvider>
      </body>
    </html>
  );
}
