'use client';

import { useAuth } from '@/providers/auth-provider';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/** Placeholder. The real dashboard lands in step 3. */
export default function DashboardPage() {
  const { principal } = useAuth();

  return (
    <div className="p-4">
      <header className="mb-4">
        <h1 className="text-base font-semibold tracking-tight">Dashboard</h1>
        <p className="text-xs text-ink-muted">
          Signed in as {principal?.email} ({principal?.role})
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Estate overview</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-ink-muted">
          Inventory and run-history views arrive in the next step.
        </CardContent>
      </Card>
    </div>
  );
}
