'use client';

import { useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Info,
  KeyRound,
  Pencil,
  Plus,
  Trash2,
  XCircle,
} from 'lucide-react';
import type { OidcSettings, ProviderVerification } from '@nexuspuppet/contracts';
import { useCapabilities, useOidcSettings, useRoles } from '@/lib/queries';
import { useClearOidcSettings, useSaveOidcSettings, useTestOidcSettings } from '@/lib/mutations';
import { ApiError } from '@/lib/client';
import { useAuth } from '@/providers/auth-provider';
import { absolute } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { CapabilityCard } from '@/components/ui/capability-card';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardHeading,
  CardTitle,
} from '@/components/ui/card';
import { InsetPanel } from '@/components/ui/inset-panel';
import { Field, FieldRow } from '@/components/ui/field';
import { InfoHint } from '@/components/ui/info-hint';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { LoadingRows, QueryError } from '@/components/states';

/** What the API fills in for an unset deployment; the form opens on this. */
const BLANK: OidcSettings = {
  issuer: '',
  clientId: '',
  redirectUri: '',
  scopes: ['profile', 'email'],
  emailClaim: 'email',
  displayNameClaim: 'name',
  groupsClaim: 'groups',
  roleMappings: [],
  timeoutMs: 10_000,
  clockSkewSeconds: 60,
};

/**
 * Configure OpenID Connect from the console (ADR-0016, issue #106).
 *
 * Same grammar as the directory card beside it, for the same reasons: locked
 * at rest, an explicit Edit, a stated delta before anything commits, and a
 * cancel that restores what is stored rather than what was typed. Two things
 * are specific to OIDC and worth knowing while reading it:
 *
 * **The client secret is never loaded.** The API does not return it, so the
 * field opens empty even when one is held and an empty field on save means
 * "keep it" — as with the LDAP bind password.
 *
 * **Test proves less here than it looks like it should.** A login happens in a
 * browser at another origin, so no button on this screen can prove somebody
 * will be able to sign in. What it establishes is that the issuer answers,
 * that its discovery document describes the issuer it was asked about rather
 * than a substituted one, and that its signing keys parse — the failures that
 * otherwise surface as an opaque refusal at the login page. The panel says so
 * rather than letting a green tick imply more.
 */
export function OidcSettingsPanel() {
  const { can } = useAuth();
  const manages = can('settings:manage');

  const capabilities = useCapabilities();
  const licensed = capabilities.data?.capabilities.includes('sso.oidc') === true;

  // Fetched in every edition: core owns this endpoint, and a disabled query
  // reports isPending forever — which rendered a skeleton that never resolved.
  const stored = useOidcSettings(manages);
  const roles = useRoles(manages);
  const knownRoles = (roles.data ?? []).map((role) => role.name);

  const save = useSaveOidcSettings();
  const clear = useClearOidcSettings();
  const test = useTestOidcSettings();

  const [form, setForm] = useState<OidcSettings>(BLANK);
  const [secret, setSecret] = useState('');
  const [result, setResult] = useState<ProviderVerification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const view = stored.data;

  useEffect(() => {
    if (view?.config !== null && view?.config !== undefined) setForm({ ...BLANK, ...view.config });
  }, [view?.config]);

  if (!manages) return null;
  if (stored.isError) return <QueryError error={stored.error} />;
  if (stored.isPending) return <LoadingRows rows={5} columns={2} />;

  const field = <K extends keyof OidcSettings>(key: K, value: OidcSettings[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
    // Any edit invalidates a previous test: the result described a
    // configuration that is no longer on screen.
    setResult(null);
  };

  const submission = (): OidcSettings => (secret === '' ? form : { ...form, clientSecret: secret });

  const fail = (caught: unknown) =>
    setError(caught instanceof ApiError ? caught.message : String(caught));

  const holdsSecret = view?.secretsHeld.includes('clientSecret') === true;
  const blocked = form.issuer === '' || form.clientId === '' || form.redirectUri === '';
  const changes = describeChanges(view?.config ?? null, form, secret !== '');

  /*
   * Header only without the capability. Every field below is unreachable — the
   * API answers 501 whatever is typed — so a full form of disabled inputs is
   * screen space spent on something this deployment cannot do.
   *
   * After the hooks, never before them: the hook order is identical in both
   * editions.
   */
  if (!licensed) {
    /*
     * WHY it is absent, which the generic card cannot know.
     *
     * This said the deployment "authenticates against LDAP, and one directory
     * provider is supported at a time — unset LDAP_URL to switch". True when
     * written; false as of ADR-0023, which lets both run at once. The
     * capability is now advertised exactly when OIDC is configured, so its
     * absence means one thing only: nobody has configured it.
     *
     * Worth saying, because "requires the sso.oidc capability" alone reads as
     * a licence problem and sends an operator to ask for a quote for something
     * they already have.
     */
    /*
     * "Set OIDC_ISSUER" is only true on ENTERPRISE, where the capability is a
     * configuration matter. In core there is no OIDC provider to configure at
     * all, and telling an operator to set an environment variable sends them
     * to edit a file that will change nothing.
     */
    const onEnterprise = capabilities.data?.edition === 'enterprise';

    return (
      <CapabilityCard
        title="Single sign-on (OIDC)"
        description="Authenticate against an OpenID Connect provider."
        capability="sso.oidc"
        note={
          onEnterprise
            ? 'Set OIDC_ISSUER to add it. A directory already configured keeps working alongside it, and so do local accounts.'
            : 'Local accounts keep working either way.'
        }
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* Licensed past this point — the unlicensed case returned above. */}
      <fieldset disabled={!editing} className="min-w-0 space-y-4">
        <StatusNotices source={view?.source} liveReload={view?.liveReload === true} />

        {error !== null && (
          <div
            role="alert"
            className="rounded border border-state-failed/40 bg-state-failed/10 p-2"
          >
            <p className="text-xs text-state-failed">{error}</p>
          </div>
        )}

        <Card>
          <CardHeader>
            <CardHeading>
              <CardTitle>Identity provider</CardTitle>
              <CardDescription>
                Which provider signs people in, and how this deployment identifies itself to it.
              </CardDescription>
            </CardHeading>
            {view !== undefined && (
              <div className="flex shrink-0 items-center gap-2">
                <Badge>{sourceLabel(view.source)}</Badge>
                {view.disabled && <Badge>disabled</Badge>}
              </div>
            )}
          </CardHeader>

          <CardContent className="space-y-4">
            <FieldRow>
              <Field
                className="min-w-64 flex-1"
                required
                label="Issuer"
                tooltip={
                  <InfoHint
                    label="About the issuer"
                    text="The base URL. Everything else — the authorization endpoint, the token endpoint, the signing keys — is discovered from it, so a rotated endpoint does not silently break."
                  />
                }
              >
                {(id) => (
                  <Input
                    id={id}
                    value={form.issuer}
                    onChange={(e) => field('issuer', e.target.value)}
                    placeholder="https://login.microsoftonline.com/<tenant>/v2.0"
                    className="font-mono text-[11px]"
                  />
                )}
              </Field>
            </FieldRow>

            <FieldRow>
              <Field className="min-w-64 flex-1" required label="Client ID">
                {(id) => (
                  <Input
                    id={id}
                    value={form.clientId}
                    onChange={(e) => field('clientId', e.target.value)}
                    className="font-mono text-[11px]"
                  />
                )}
              </Field>

              <Field
                className="min-w-64 flex-1"
                hint={holdsSecret ? 'A secret is stored. Leave blank to keep it.' : undefined}
                label="Client secret"
                tooltip={
                  <InfoHint
                    label="About the client secret"
                    text="Never sent back to the browser, so this is empty even when one is stored. Leaving it blank keeps the existing value; typing replaces it. A public client using PKCE alone needs none."
                  />
                }
              >
                {(id) => (
                  <Input
                    id={id}
                    type="password"
                    value={secret}
                    onChange={(e) => {
                      setSecret(e.target.value);
                      setResult(null);
                    }}
                    placeholder={
                      holdsSecret ? '•••••••• (unchanged)' : 'optional for a public client'
                    }
                  />
                )}
              </Field>
            </FieldRow>

            <Field
              required
              label="Redirect URI"
              hint="Must match what is registered at the provider, exactly."
              tooltip={
                <InfoHint
                  label="Why this must match"
                  text="The provider refuses a callback to a URI it does not know. Changing it here without changing it there breaks every login, and the error appears at the provider rather than in this console."
                />
              }
            >
              {(id) => (
                <Input
                  id={id}
                  value={form.redirectUri}
                  onChange={(e) => field('redirectUri', e.target.value)}
                  placeholder="https://nexuspuppet.example.com/api/auth/callback"
                  className="font-mono text-[11px]"
                />
              )}
            </Field>

            <Field
              label="Scopes"
              hint="Comma separated. openid is always requested and need not be listed."
            >
              {(id) => (
                <Input
                  id={id}
                  value={form.scopes.join(', ')}
                  onChange={(e) =>
                    field(
                      'scopes',
                      e.target.value
                        .split(',')
                        .map((s) => s.trim())
                        .filter((s) => s.length > 0),
                    )
                  }
                  placeholder="profile, email"
                  className="font-mono text-[11px]"
                />
              )}
            </Field>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardHeading>
              <CardTitle>Claims</CardTitle>
              <CardDescription>
                Which claims in the token carry the identity and the group membership.
              </CardDescription>
            </CardHeading>
          </CardHeader>

          <CardContent>
            <FieldRow>
              <Field className="min-w-48 flex-1" label="Email claim">
                {(id) => (
                  <Input
                    id={id}
                    value={form.emailClaim}
                    onChange={(e) => field('emailClaim', e.target.value)}
                    className="font-mono text-[11px]"
                  />
                )}
              </Field>
              <Field className="min-w-48 flex-1" label="Display name claim">
                {(id) => (
                  <Input
                    id={id}
                    value={form.displayNameClaim}
                    onChange={(e) => field('displayNameClaim', e.target.value)}
                    className="font-mono text-[11px]"
                  />
                )}
              </Field>
              <Field
                className="min-w-48 flex-1"
                label="Groups claim"
                tooltip={
                  <InfoHint
                    label="About the groups claim"
                    text="Conventional but not standard. Entra ID and Okta commonly use `groups`; Keycloak needs a mapper adding. A provider that names it otherwise must say so here, or nobody matches a mapping."
                  />
                }
              >
                {(id) => (
                  <Input
                    id={id}
                    value={form.groupsClaim}
                    onChange={(e) => field('groupsClaim', e.target.value)}
                    className="font-mono text-[11px]"
                  />
                )}
              </Field>
            </FieldRow>
          </CardContent>
        </Card>

        <RoleMappings
          mappings={form.roleMappings}
          onChange={(roleMappings) => field('roleMappings', roleMappings)}
          knownRoles={knownRoles}
          defaultRole={form.defaultRole}
          onDefaultRole={(role) =>
            setForm((current) => {
              const next = { ...current };
              if (role === '') delete next.defaultRole;
              else next.defaultRole = role;
              setResult(null);
              return next;
            })
          }
        />
      </fieldset>

      {/*
        Check, delta and actions in ONE card, titled with what they control —
        the same fix the directory card needed. Bare rows between two bordered
        cards belong, visually, to neither.
      */}
      <Card>
        <CardHeader>
          <CardHeading>
            <CardTitle>Apply single sign-on settings</CardTitle>
            <CardDescription>
              Check the settings above against the identity provider, then save them.
            </CardDescription>
          </CardHeading>
        </CardHeader>

        <CardContent className="space-y-3">
          <InsetPanel
            title="Check this configuration"
            description="Asks the identity provider for its discovery document and signing keys. It cannot prove somebody will be able to sign in — that happens in a browser at another origin."
          >
            {result !== null && <TestResult result={result} />}
          </InsetPanel>

          {editing && changes.length > 0 && (
            <div className="rounded border border-accent/40 bg-accent/10 px-2.5 py-2">
              <p className="text-[11px] font-semibold text-ink">Pending changes</p>
              <ul className="mt-1 space-y-0.5">
                {changes.map((line) => (
                  <li key={line} className="text-[11px] text-ink-muted">
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {licensed && (
            <div className="flex flex-wrap items-center gap-2 rounded border border-line-soft bg-panel-raised px-3 py-2">
              {view?.updatedAt !== null && view?.updatedAt !== undefined && (
                <span className="text-[11px] text-ink-faint">
                  Last changed {absolute(view.updatedAt)}
                  {view.updatedByEmail !== null && ` by ${view.updatedByEmail}`}
                </span>
              )}

              <div className="ml-auto flex items-center gap-2">
                {!editing ? (
                  <>
                    {/* Available while locked: checking that the issuer answers
                    writes nothing, and needing to unlock first inverts the
                    point of the check. */}
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={test.isPending || blocked}
                      onClick={() => {
                        setError(null);
                        test.mutate(submission(), { onSuccess: setResult, onError: fail });
                      }}
                    >
                      {test.isPending ? 'Checking…' : 'Check provider'}
                    </Button>
                    <Button variant="primary" size="sm" onClick={() => setEditing(true)}>
                      <Pencil className="mr-1 size-3.5" aria-hidden />
                      Edit settings
                    </Button>
                  </>
                ) : (
                  <>
                    {view?.source === 'database' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={clear.isPending}
                        onClick={() => {
                          setError(null);
                          clear.mutate(undefined, { onError: fail });
                        }}
                      >
                        Discard stored settings
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        // Back to what is stored, never to what was typed.
                        setForm(
                          view?.config === null || view?.config === undefined
                            ? BLANK
                            : { ...BLANK, ...view.config },
                        );
                        setSecret('');
                        setResult(null);
                        setError(null);
                        setEditing(false);
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={test.isPending || blocked}
                      onClick={() => {
                        setError(null);
                        test.mutate(submission(), { onSuccess: setResult, onError: fail });
                      }}
                    >
                      {test.isPending ? 'Checking…' : 'Check provider'}
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={save.isPending || blocked}
                      onClick={() => {
                        setError(null);
                        save.mutate(submission(), {
                          onSuccess: () => {
                            setSecret('');
                            setEditing(false);
                          },
                          onError: fail,
                        });
                      }}
                    >
                      {save.isPending ? 'Saving…' : 'Save'}
                    </Button>
                  </>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function StatusNotices({
  source,
  liveReload,
}: {
  source: 'database' | 'environment' | 'unset' | undefined;
  liveReload: boolean;
}) {
  if (source === undefined) return null;

  return (
    <>
      {(source === 'environment' || (source === 'unset' && liveReload)) && (
        <Notice tone="info">
          {'Configured from the environment. Saving here stores a configuration in the database, '}
          {'which then takes precedence. '}
          <InfoHint
            label="About environment precedence"
            text="The environment is left as it is, and is used again only if you discard the stored settings."
          />
        </Notice>
      )}

      {!liveReload && (
        <Notice tone="warn">
          {'No OIDC provider is running, so changes saved here will not take effect until the '}
          {'API restarts. '}
          <InfoHint
            label="Why a restart is needed"
            text="Providers register at boot. Set OIDC_ISSUER in the environment and restart once; after that this screen is enough."
          />
        </Notice>
      )}
    </>
  );
}

/**
 * Which claim values grant which role.
 *
 * The most consequential thing on this screen, as it is for the directory: a
 * group named here decides who can reclassify a thousand machines. An empty
 * list with no default REFUSES everybody who authenticates, which the empty
 * row says outright rather than leaving to be discovered at somebody's login.
 */
function RoleMappings({
  mappings,
  onChange,
  knownRoles,
  defaultRole,
  onDefaultRole,
}: {
  mappings: OidcSettings['roleMappings'];
  onChange: (next: OidcSettings['roleMappings']) => void;
  knownRoles: string[];
  defaultRole: string | undefined;
  onDefaultRole: (role: string) => void;
}) {
  const dangling = (role: string) =>
    knownRoles.length > 0 && role !== '' && !knownRoles.includes(role);
  const broken = mappings.filter((mapping) => dangling(mapping.role));

  return (
    <Card>
      <CardHeader>
        <CardHeading>
          <CardTitle>Role mappings</CardTitle>
          <CardDescription>
            Which claim values grant which role, recomputed at every sign-in.
          </CardDescription>
        </CardHeading>
        <div className="shrink-0">
          <InfoHint
            label="How several matches are resolved"
            text="Matching only built-in roles takes the first mapping listed, so the most privileged belongs first. Matching any custom role unions their permissions instead, because unranked roles cannot be ordered (ADR-0018)."
          />
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {broken.length > 0 && (
          <div
            role="alert"
            className="rounded border border-state-pending/40 bg-state-pending/10 p-2"
          >
            <p className="text-[11px] font-semibold text-ink">
              {broken.length === 1
                ? '1 mapping names a role that does not exist'
                : `${broken.length} mappings name roles that do not exist`}
            </p>
            <p className="mt-1 max-w-prose text-[11px] text-ink-muted">
              {'Anybody in '}
              {broken.map((m) => m.group).join(', ')}
              {' signs in successfully and is then denied everything. Point them at a role that '}
              {'exists, or create it under Users & Roles.'}
            </p>
          </div>
        )}

        {mappings.length === 0 ? (
          <p className="rounded border border-dashed border-line-soft px-3 py-4 text-center text-[11px] text-ink-muted">
            No mappings yet.{' '}
            {defaultRole === undefined
              ? 'Anybody who authenticates will be refused for matching no group.'
              : `Everybody who authenticates will get ${defaultRole}.`}
          </p>
        ) : (
          <div className="scroll-x">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line-soft text-left text-ink-faint">
                  <th className="py-1 pr-3 font-medium">Claim value</th>
                  <th className="w-44 py-1 pr-3 font-medium">Role</th>
                  <th className="w-9 py-1" />
                </tr>
              </thead>
              <tbody>
                {mappings.map((mapping, index) => (
                  <tr key={index} className="border-b border-line-soft/60">
                    <td className="py-1.5 pr-3">
                      <Input
                        value={mapping.group}
                        onChange={(e) =>
                          onChange(
                            mappings.map((m, i) =>
                              i === index ? { ...m, group: e.target.value } : m,
                            ),
                          )
                        }
                        placeholder="puppet-admins"
                        className="h-7 font-mono text-[11px]"
                        aria-label={`Claim value for mapping ${index + 1}`}
                      />
                    </td>
                    <td className="py-1.5 pr-3">
                      <Select
                        value={mapping.role}
                        onChange={(e) =>
                          onChange(
                            mappings.map((m, i) =>
                              i === index ? { ...m, role: e.target.value } : m,
                            ),
                          )
                        }
                        className="h-7 w-full text-xs"
                        aria-invalid={dangling(mapping.role)}
                        aria-label={`Role for mapping ${index + 1}`}
                      >
                        {/* A mapping may name a role that no longer exists.
                            Keeping it as an option means opening the form does
                            not silently rewrite it to whatever came first. */}
                        {dangling(mapping.role) && (
                          <option value={mapping.role}>{mapping.role} — no such role</option>
                        )}
                        {knownRoles.map((role) => (
                          <option key={role} value={role}>
                            {role}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="py-1.5">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => onChange(mappings.filter((_, i) => i !== index))}
                        aria-label={`Remove mapping for ${mapping.group || 'this claim value'}`}
                      >
                        <Trash2 aria-hidden />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex flex-wrap items-end gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onChange([...mappings, { group: '', role: 'VIEWER' }])}
          >
            <Plus aria-hidden />
            Add mapping
          </Button>

          <Field
            className="w-56"
            label="Role for everyone else"
            hint="Refused when unset — the safe default."
          >
            {(id) => (
              <Select
                id={id}
                value={defaultRole ?? ''}
                onChange={(e) => onDefaultRole(e.target.value)}
                className="h-7 w-full text-xs"
              >
                <option value="">Refuse them</option>
                {knownRoles.map((role) => (
                  <option key={role} value={role}>
                    {role}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>

        {defaultRole !== undefined && (
          <Notice tone="warn">
            {`Everybody the identity provider authenticates gets ${defaultRole}, whether or not `}
            {'they match a mapping — which for most providers is the whole company.'}
          </Notice>
        )}
      </CardContent>
    </Card>
  );
}

function Notice({ tone, children }: { tone: 'info' | 'warn'; children: React.ReactNode }) {
  const warn = tone === 'warn';
  return (
    <div
      className={
        warn
          ? 'flex items-start gap-2 rounded border border-state-pending/40 bg-state-pending/10 px-2.5 py-2'
          : 'flex items-start gap-2 rounded border border-line-soft bg-panel-raised px-2.5 py-2'
      }
    >
      {warn ? (
        <AlertTriangle className="mt-px size-3.5 shrink-0 text-state-pending" aria-hidden />
      ) : (
        <Info className="mt-px size-3.5 shrink-0 text-ink-faint" aria-hidden />
      )}
      <p className={warn ? 'text-[11px] text-state-pending' : 'text-[11px] text-ink-muted'}>
        {children}
      </p>
    </div>
  );
}

/** What the provider said. Rendered verbatim — core does not know what OIDC is. */
function TestResult({ result }: { result: ProviderVerification }) {
  return (
    <div
      role="status"
      className={
        result.ok
          ? 'rounded border border-state-unchanged/40 bg-state-unchanged/10 p-2'
          : 'rounded border border-state-failed/40 bg-state-failed/10 p-2'
      }
    >
      <div className="flex items-start gap-2">
        {result.ok ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-state-unchanged" aria-hidden />
        ) : (
          <XCircle className="mt-0.5 size-4 shrink-0 text-state-failed" aria-hidden />
        )}
        <div className="min-w-0">
          <p className={result.ok ? 'text-xs text-state-unchanged' : 'text-xs text-state-failed'}>
            {result.message}
          </p>
          {result.details !== undefined && result.details.length > 0 && (
            <dl className="mt-1 space-y-0.5">
              {result.details.map((detail) => (
                <div key={detail.label} className="flex gap-2 text-[11px]">
                  <dt className="text-ink-faint">{detail.label}</dt>
                  <dd className="min-w-0 truncate font-mono text-ink-muted">{detail.value}</dd>
                </div>
              ))}
            </dl>
          )}
          {result.ok && (
            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-faint">
              <KeyRound className="size-3 shrink-0" aria-hidden />
              The provider is reachable and consistent. Whether a person can sign in is only
              answered by signing in.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function sourceLabel(source: 'database' | 'environment' | 'unset'): string {
  if (source === 'database') return 'stored here';
  if (source === 'environment') return 'from the environment';
  return 'not configured';
}

/**
 * The difference between what is stored and what is on screen, in words.
 *
 * Only the fields whose change an operator would want confirmed. A changed
 * issuer or redirect URI breaks every login; a changed timeout does not, and
 * listing it would dilute the ones that matter.
 */
function describeChanges(
  before: OidcSettings | null,
  after: OidcSettings,
  secretTyped: boolean,
): string[] {
  if (before === null) return ['This will store an OIDC configuration for the first time.'];

  const lines: string[] = [];
  const field = (label: string, a: string | undefined, b: string | undefined) => {
    if ((a ?? '') !== (b ?? '')) lines.push(`${label}: ${a || '(none)'} → ${b || '(none)'}`);
  };

  field('Issuer', before.issuer, after.issuer);
  field('Client ID', before.clientId, after.clientId);
  if (before.redirectUri !== after.redirectUri) {
    lines.push(
      `Redirect URI: ${before.redirectUri} → ${after.redirectUri} — must also be changed at the provider`,
    );
  }
  field('Email claim', before.emailClaim, after.emailClaim);
  field('Display name claim', before.displayNameClaim, after.displayNameClaim);
  field('Groups claim', before.groupsClaim, after.groupsClaim);
  field('Scopes', before.scopes.join(', '), after.scopes.join(', '));

  if ((before.defaultRole ?? '') !== (after.defaultRole ?? '')) {
    lines.push(
      after.defaultRole === undefined
        ? 'Role for everyone else: removed — unmapped users are refused again'
        : `Role for everyone else: ${before.defaultRole ?? '(refused)'} → ${after.defaultRole} — everybody the provider authenticates gets it`,
    );
  }

  if (secretTyped) lines.push('Client secret: replaced');

  // Compared as a SET: reordering is not a change, and presenting it as one
  // would bury the additions among noise.
  const key = (m: { group: string; role: string }) => `${m.group}=${m.role}`;
  const was = new Set((before.roleMappings ?? []).map(key));
  const now = new Set(after.roleMappings.map(key));
  for (const m of now) if (!was.has(m)) lines.push(`Mapping added: ${m}`);
  for (const m of was) if (!now.has(m)) lines.push(`Mapping removed: ${m}`);

  return lines;
}
