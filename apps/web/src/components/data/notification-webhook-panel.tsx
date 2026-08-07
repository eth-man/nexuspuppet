'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import type { NotificationWebhookSettings } from '@nexuspuppet/contracts';
import { useNotificationWebhook } from '@/lib/queries';
import {
  useClearNotificationWebhook,
  useSaveNotificationWebhook,
  useTestNotificationWebhook,
} from '@/lib/mutations';
import { ApiError } from '@/lib/client';
import { useAuth } from '@/providers/auth-provider';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardHeading,
  CardTitle,
} from '@/components/ui/card';
import { Field, FieldRow } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { LoadingRows, QueryError } from '@/components/states';

/**
 * Where operational notifications are POSTed (ADR-0021 §4).
 *
 * NOT capability-gated, and not the audit webhook. That one lives under
 * `audit.export` and carries audit records; this is core and carries
 * conditions. Two destinations, so the boundary is enforced by which transport
 * is used rather than by remembering.
 */
export function NotificationWebhookPanel() {
  const { can } = useAuth();
  const manages = can('settings:manage');

  const stored = useNotificationWebhook(manages);
  const save = useSaveNotificationWebhook();
  const clear = useClearNotificationWebhook();
  const test = useTestNotificationWebhook();

  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ ok: boolean; error: string | null } | null>(null);

  useEffect(() => {
    setUrl(stored.data?.config?.url ?? '');
  }, [stored.data?.config?.url]);

  if (!manages) return null;
  if (stored.isError) return <QueryError error={stored.error} />;
  if (stored.isPending) return <LoadingRows rows={2} columns={2} />;

  const configured = stored.data.config !== null;
  const holdsToken = stored.data.secretsHeld.includes('token');
  const blocked = url === '';
  const fail = (caught: unknown) =>
    setError(caught instanceof ApiError ? caught.message : String(caught));

  const submission = (): NotificationWebhookSettings => ({
    url,
    timeoutMs: stored.data.config?.timeoutMs ?? 10_000,
    ...(token === '' ? {} : { token }),
  });

  return (
    <div className="space-y-3">
      {error !== null && (
        <div role="alert" className="rounded border border-state-failed/40 bg-state-failed/10 p-2">
          <p className="text-xs text-state-failed">{error}</p>
        </div>
      )}

      <fieldset disabled={!editing} className="min-w-0">
        <Card>
          <CardHeader>
            <CardHeading>
              <CardTitle>Notification webhook</CardTitle>
              <CardDescription>
                POSTed when an operational condition opens and when it resolves. Carries conditions
                only — never audit records.
              </CardDescription>
            </CardHeading>
          </CardHeader>

          <CardContent className="space-y-3">
            <FieldRow>
              <Field className="min-w-64 flex-[3]" required label="Notification endpoint">
                {(id) => (
                  <Input
                    id={id}
                    value={url}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      setResult(null);
                    }}
                    placeholder="https://alerts.example.com/hooks/nexuspuppet"
                    className="font-mono text-[11px]"
                  />
                )}
              </Field>
            </FieldRow>

            <FieldRow>
              <Field
                className="min-w-64 flex-[3]"
                label="Bearer token"
                hint={
                  holdsToken
                    ? 'A token is stored. Leave blank to keep it.'
                    : 'Optional. Sent as an Authorization header.'
                }
              >
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    value={token}
                    onChange={(e) => {
                      setToken(e.target.value);
                      setResult(null);
                    }}
                    placeholder={holdsToken ? '••••••••' : ''}
                    className="font-mono text-[11px]"
                  />
                )}
              </Field>
            </FieldRow>
          </CardContent>
        </Card>
      </fieldset>

      {result !== null && (
        <p
          role="status"
          className={
            result.ok
              ? 'flex items-center gap-1.5 text-[11px] text-state-unchanged'
              : 'flex items-start gap-1.5 text-[11px] text-state-failed'
          }
        >
          {result.ok ? (
            <>
              <CheckCircle2 className="size-3.5 shrink-0" aria-hidden />
              The endpoint accepted a test notification.
            </>
          ) : (
            <>
              <XCircle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              <span>{result.error ?? 'The endpoint did not accept it.'}</span>
            </>
          )}
        </p>
      )}

      <div className="flex justify-end gap-2">
        {editing ? (
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditing(false);
                setToken('');
                setResult(null);
                setError(null);
                setUrl(stored.data.config?.url ?? '');
              }}
            >
              Cancel
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={blocked || test.isPending}
              onClick={() => {
                setError(null);
                test.mutate(submission(), { onSuccess: setResult, onError: fail });
              }}
            >
              Send test
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={blocked || save.isPending}
              onClick={() => {
                setError(null);
                save.mutate(submission(), {
                  onSuccess: () => {
                    setEditing(false);
                    setToken('');
                  },
                  onError: fail,
                });
              }}
            >
              Save
            </Button>
          </>
        ) : (
          <>
            {configured && (
              <Button
                variant="ghost"
                size="sm"
                disabled={clear.isPending}
                onClick={() => {
                  setError(null);
                  clear.mutate(undefined, { onError: fail });
                }}
              >
                Stop sending
              </Button>
            )}
            <Button variant="primary" size="sm" onClick={() => setEditing(true)}>
              Edit webhook
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
