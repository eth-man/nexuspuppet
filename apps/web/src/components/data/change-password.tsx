'use client';

import { useState } from 'react';
import { useChangeOwnPassword } from '@/lib/mutations';
import { ApiError } from '@/lib/client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Self-service password change.
 *
 * Changing a password revokes every other session for the account, which the
 * form says up front — a password change is usually a response to a suspected
 * compromise, and someone doing it deliberately should know it takes effect
 * everywhere.
 *
 * "Every OTHER session" is now literally true. It was not: the API revoked the
 * caller's token along with the rest, so the person reading this sentence was
 * signed out too — silently, at their next refresh, up to one access-token
 * lifetime later. The copy was correct and the implementation disagreed with it.
 */
export function ChangePasswordCard() {
  const change = useChangeOwnPassword();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Change your password</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            setError(null);
            setDone(false);
            change.mutate(
              { currentPassword, newPassword },
              {
                onSuccess: () => {
                  setCurrent('');
                  setNew('');
                  setDone(true);
                },
                onError: (caught) =>
                  setError(caught instanceof ApiError ? caught.message : String(caught)),
              },
            );
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="currentPassword">Current password</Label>
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              value={currentPassword}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="newPassword2">New password</Label>
            <Input
              id="newPassword2"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNew(e.target.value)}
              aria-invalid={newPassword.length > 0 && newPassword.length < 12}
              required
            />
            <p className="text-2xs text-ink-faint">
              At least 12 characters. This signs you out of every other session.
            </p>
          </div>

          {error !== null && (
            <p role="alert" className="text-xs text-state-failed">
              {error}
            </p>
          )}
          {done && (
            <p role="status" className="text-xs text-state-unchanged">
              Password changed. Other sessions have been signed out.
            </p>
          )}

          <Button
            type="submit"
            variant="secondary"
            size="sm"
            disabled={change.isPending || newPassword.length < 12}
          >
            {change.isPending ? 'Changing…' : 'Change password'}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
