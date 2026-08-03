'use client';

import { UsersPanel } from '@/components/data/users-panel';
import { RolesPanel } from '@/components/data/roles-panel';
import { SettingsGuard } from '@/components/settings-guard';

/** Accounts today; custom roles once ADR-0018 lands its editing slice. */
export default function UsersSettingsPage() {
  return (
    <SettingsGuard permission="users:manage" section="User administration">
      <div className="space-y-3">
        <UsersPanel />
        <RolesPanel />
      </div>
    </SettingsGuard>
  );
}
