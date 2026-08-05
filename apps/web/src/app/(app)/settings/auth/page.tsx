'use client';

import { AuthProviderPanel } from '@/components/data/auth-provider-panel';
import { LdapSettingsPanel } from '@/components/data/ldap-settings-panel';
import { OidcSettingsPanel } from '@/components/data/oidc-settings-panel';
import { SettingsGuard } from '@/components/settings-guard';

/** How people prove who they are, and what their directory groups grant them. */
export default function AuthSettingsPage() {
  return (
    <SettingsGuard permission="settings:manage" section="Directory settings">
      <div className="space-y-3">
        <LdapSettingsPanel />
        <OidcSettingsPanel />
        {/* Falls back to a read-only view for any provider with no editable
            card of its own. Renders nothing when one of the cards above
            already covers the configured source. */}
        <AuthProviderPanel />
      </div>
    </SettingsGuard>
  );
}
