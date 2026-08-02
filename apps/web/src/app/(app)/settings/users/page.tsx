'use client';

import { UsersPanel } from '@/components/data/users-panel';
import { SettingsGuard } from '@/components/settings-guard';

/** Accounts today; custom roles once ADR-0018 lands its editing slice. */
export default function UsersSettingsPage() {
  return (
    <SettingsGuard permission="users:manage" section="User administration">
      <UsersPanel />
    </SettingsGuard>
  );
}
