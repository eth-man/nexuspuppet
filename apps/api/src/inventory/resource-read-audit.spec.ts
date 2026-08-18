import type { AuditRecord, ResourceFilter } from '@nexuspuppet/contracts';
import { ResourceReadAudit } from './resource-read-audit';
import type { AuthenticatedRequest } from '../auth/auth.guard';

/*
 * The trail behind a privileged read (ADR-0025 §6).
 *
 * `resources:read` can read managed file contents and credentials passed as
 * class parameters. Without these rows, "senior operators and auditors only"
 * is a policy with no evidence behind it — nobody can afterwards ask who
 * looked at what.
 *
 * The assertion that matters most is a NEGATIVE one: no parameter value may
 * ever reach the audit log. Recording what was read would copy the estate's
 * secrets into the trail and then forward them to a SIEM, turning the control
 * into a second, wider copy of what it exists to protect.
 */

const request = (): AuthenticatedRequest =>
  ({
    principal: { userId: 'u1', email: 'ops@example.com' },
    ip: '10.0.0.9',
    headers: { 'user-agent': 'jest' },
  }) as unknown as AuthenticatedRequest;

function sink() {
  const written: AuditRecord[] = [];
  return {
    written,
    audit: new ResourceReadAudit({
      record: async (entry: AuditRecord) => {
        written.push(entry);
        return 'id';
      },
    } as never),
  };
}

describe('ResourceReadAudit', () => {
  it('records an expansion, naming the resource and the nodes', async () => {
    const { audit, written } = sink();

    await audit.parametersRead(request(), 'File', '/etc/ssh/sshd_config', ['app18', 'cache35']);

    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      action: 'resource.parameters.read',
      entityType: 'Resource',
      entityId: 'File[/etc/ssh/sshd_config]',
      entityLabel: 'app18, cache35',
      actorEmail: 'ops@example.com',
      ipAddress: '10.0.0.9',
    });
  });

  /*
   * §6 AND THE ADR-0005 AMENDMENT. A read has no prior state and no new state,
   * so it cannot take the shape of a change. Anything consuming AuditLog —
   * SIEM forwarding included — has to tolerate this.
   */
  it('writes null before and after, because a read changes nothing', async () => {
    const { audit, written } = sink();

    await audit.parametersRead(request(), 'File', '/etc/motd', ['app18']);

    expect(written[0]?.before).toBeNull();
    expect(written[0]?.after).toBeNull();
  });

  /*
   * THE ONE THAT MUST NEVER REGRESS. The row records the QUESTION, never the
   * answer — a trail containing the file contents somebody read would be a
   * second copy of the secret, in a table that gets forwarded off-box.
   */
  it('never writes a parameter value into the row', async () => {
    const { audit, written } = sink();

    await audit.parametersRead(request(), 'File', '/etc/ssh/sshd_config', ['cache35']);

    const serialised = JSON.stringify(written[0]);
    expect(serialised).not.toContain('PermitRootLogin');
    expect(serialised).not.toContain('0666');
  });

  /*
   * The oracle (§5). The value recorded here is the operator's own GUESS, not
   * something read out of a catalog — and "they queried password = hunter2
   * eleven times" is exactly the sequence this trail exists to surface.
   */
  it('records a parameter-value query, including what was tested', async () => {
    const { audit, written } = sink();
    const filter: ResourceFilter = {
      type: 'File',
      parameters: [{ path: 'mode', operator: 'EQUALS', value: '0666' }],
    };

    await audit.parameterQuery(request(), filter);

    expect(written[0]).toMatchObject({
      action: 'resource.parameters.query',
      entityType: 'Resource',
      entityId: 'File',
      entityLabel: 'mode EQUALS 0666',
    });
  });

  /*
   * `entityLabel` is VarChar(200). A long list must truncate visibly rather
   * than make the write fail — losing the row entirely is far worse than
   * losing the tail of a list.
   */
  it('truncates a long node list rather than failing the write', async () => {
    const { audit, written } = sink();
    const many = Array.from(
      { length: 40 },
      (_, i) => `some-long-node-name-${String(i)}.example.com`,
    );

    await audit.parametersRead(request(), 'File', '/etc/motd', many);

    const label = written[0]?.entityLabel ?? '';
    expect(label.length).toBeLessThanOrEqual(200);
    expect(label.endsWith('…')).toBe(true);
  });

  /*
   * Bootstrap, background workers and an unauthenticated edge case all write
   * rows with no principal. Null is the honest value; inventing an actor would
   * put a name on an action nobody took.
   */
  it('records a null actor rather than inventing one', async () => {
    const { audit, written } = sink();

    await audit.parametersRead({ headers: {} } as unknown as AuthenticatedRequest, 'File', '/x', [
      'a',
    ]);

    expect(written[0]?.actorUserId).toBeNull();
    expect(written[0]?.actorEmail).toBeNull();
  });
});
