'use client';

import type { LogLevelSetting } from '@nexuspuppet/contracts';
import { useLogLevel } from '@/lib/queries';
import { useClearLogLevel, useSetLogLevel } from '@/lib/mutations';
import { useAuth } from '@/providers/auth-provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from '@/components/ui/select';
import { Field } from '@/components/ui/field';
import { LoadingRows, QueryError } from '@/components/states';

const LEVELS: Array<LogLevelSetting['level']> = ['debug', 'info', 'warn', 'error'];

/**
 * The API's log level, changeable without a restart.
 *
 * It previously took a restart, which is the one thing an operator cannot do
 * while diagnosing the incident that made them want debug logging.
 */
export function LogLevelCard() {
  const { can } = useAuth();
  const manages = can('settings:manage');

  const current = useLogLevel(manages);
  const set = useSetLogLevel();
  const clear = useClearLogLevel();

  if (!manages) return null;
  if (current.isError) return <QueryError error={current.error} />;
  if (current.isPending) return <LoadingRows rows={1} columns={2} />;

  const { level, source, locked } = current.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Log level</CardTitle>
      </CardHeader>

      <CardContent className="space-y-2">
        <Field label="Level">
          {(id) => (
            <Select
              id={id}
              value={level}
              // Inert under SETTINGS_SOURCE=env, and said out loud below. A
              // control that silently does nothing is worse than no control.
              disabled={locked || set.isPending}
              onChange={(e) => set.mutate(e.target.value as LogLevelSetting['level'])}
            >
              {LEVELS.map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </Select>
          )}
        </Field>

        {locked ? (
          <p className="text-[11px] text-state-pending">
            {'SETTINGS_SOURCE=env — the environment is authoritative and this control does '}
            {'nothing. Change LOG_LEVEL on the host instead.'}
          </p>
        ) : (
          <p className="text-[11px] text-ink-faint">
            {source === 'database'
              ? 'Saved here, overriding LOG_LEVEL. '
              : 'From LOG_LEVEL in the environment. '}
            {/* The delay is real and stated: other replicas poll for it. */}
            Applies immediately here, and within about fifteen seconds on other replicas.
          </p>
        )}

        {source === 'database' && !locked && (
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              disabled={clear.isPending}
              onClick={() => clear.mutate()}
            >
              Use the environment&rsquo;s value
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
