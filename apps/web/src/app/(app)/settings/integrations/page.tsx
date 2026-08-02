'use client';

import { SettingsEmpty, SettingsGuard } from '@/components/settings-guard';

/** Where audit forwarding will live (ADR-0016). */
export default function IntegrationsSettingsPage() {
  return (
    <SettingsGuard permission="settings:manage" section="Integrations">
      <SettingsEmpty title="Nothing to configure yet">
        Syslog and webhook forwarding for the audit trail are designed but not built (ADR-0016).
        Until they are, the audit trail is written to this deployment&rsquo;s own database and stays
        there.
      </SettingsEmpty>
    </SettingsGuard>
  );
}
