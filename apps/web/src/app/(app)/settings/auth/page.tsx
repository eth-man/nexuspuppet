'use client';

import { AuthProviderPanel } from '@/components/data/auth-provider-panel';
import { LdapSettingsPanel } from '@/components/data/ldap-settings-panel';
import { SettingsGuard } from '@/components/settings-guard';

/** How people prove who they are, and what their directory groups grant them. */
export default function AuthSettingsPage() {
  return (
    <SettingsGuard permission="settings:manage" section="Directory settings">
      <div className="space-y-3">
        <LdapSettingsPanel />
        {/* Falls back to a read-only view for a provider with no editable card
            — OIDC today. Renders nothing when the LDAP card already covers it. */}
        <AuthProviderPanel />
      </div>
    </SettingsGuard>
  );
}
