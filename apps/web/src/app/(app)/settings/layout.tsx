import type { ReactNode } from 'react';
import { SettingsTabs } from '@/components/settings-tabs';

/**
 * The Settings shell: heading and tab bar, shared by every section.
 *
 * A layout rather than a component each page renders, so switching tabs does
 * not remount the bar — the underline moves, nothing flickers, and scroll
 * position in the bar survives on a narrow screen.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="space-y-3 p-3">
      <header>
        <h1 className="text-sm font-semibold tracking-tight">Settings</h1>
        <p className="text-xs text-ink-muted">Deployment, directory, and users</p>
      </header>

      <SettingsTabs />

      {children}
    </div>
  );
}
