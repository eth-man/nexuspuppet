'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useAuth } from '@/providers/auth-provider';
import { SETTINGS_TABS } from '@/app/(app)/settings/tabs';
import { cn } from '@/lib/utils';

/**
 * The Settings tab bar.
 *
 * Links, not buttons with state. A tab is an address: it survives a reload,
 * it can be sent to a colleague, and the browser's back button does what the
 * operator expects. A `useState` tab bar loses all three, and the loss only
 * becomes obvious once someone is trying to describe where a setting lives.
 *
 * Aligned with the content column rather than spanning the sidebar, so the
 * tabs read as belonging to the page and not to the application.
 */
export function SettingsTabs() {
  const pathname = usePathname();
  const { can } = useAuth();

  const visible = SETTINGS_TABS.filter(
    (tab) => tab.permission === undefined || can(tab.permission),
  );

  // Nothing to switch between is not a tab bar. A viewer sees only General.
  if (visible.length < 2) return null;

  return (
    <nav aria-label="Settings sections" className="border-b border-line-soft">
      <ul className="flex flex-wrap gap-x-1">
        {visible.map((tab) => {
          const href = `/settings/${tab.slug}`;
          const active = pathname === href;

          return (
            <li key={tab.slug}>
              <Link
                href={href}
                // aria-current is what tells a screen reader which section is
                // open. The underline is only visible to people who can see it.
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-block border-b-2 px-3 py-2 text-xs transition-colors',
                  active
                    ? 'border-accent font-semibold text-ink'
                    : 'border-transparent text-ink-muted hover:border-line hover:text-ink',
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
