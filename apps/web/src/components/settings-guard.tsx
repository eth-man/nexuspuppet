'use client';

import type { ReactNode } from 'react';
import type { Permission } from '@nexuspuppet/contracts';
import { useAuth } from '@/providers/auth-provider';

/**
 * Renders a Settings section only for someone whose role permits it.
 *
 * The tab bar already hides what an operator cannot use, so reaching this
 * message means a typed URL, a stale bookmark, or a link from someone with more
 * access. Saying so is better than an empty page, which reads as a bug, and
 * better than a redirect, which loses the address they were trying to reach.
 *
 * This is an affordance. The API refuses independently (ADR-0006) — nothing
 * here is what keeps the data safe.
 */
export function SettingsGuard({
  permission,
  section,
  children,
}: {
  permission: Permission;
  section: string;
  children: ReactNode;
}) {
  const { can } = useAuth();

  if (!can(permission)) {
    return (
      <div className="rounded border border-line-soft bg-panel p-6 text-center">
        <p className="text-xs text-ink-muted">
          {section} needs the <span className="font-mono text-ink">{permission}</span> permission,
          which your role does not have.
        </p>
      </div>
    );
  }

  return <>{children}</>;
}

/** An area of Settings that exists but has nothing in it yet. */
export function SettingsEmpty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded border border-line-soft bg-panel p-6">
      <p className="text-xs font-semibold text-ink">{title}</p>
      <p className="mt-1 max-w-prose text-xs text-ink-muted">{children}</p>
    </div>
  );
}
