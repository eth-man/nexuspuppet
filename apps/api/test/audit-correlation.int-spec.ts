import type { AuditRecord } from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { PrismaAuditSink } from '../src/auth/core-capabilities';
import { runWithRequestId } from '../src/common/request-context';

/**
 * Audit correlation, against a REAL PostgreSQL (#229).
 *
 * Against the database rather than a mock, because the claims are about what
 * is STORED and queryable: an id that groups rows, and a label that survives
 * the thing it names. A mock would prove only that we called the sink.
 *
 * WHAT THIS DOES NOT CLAIM. Today every operation writes exactly one audit
 * row, so grouping is not yet doing work in production — it is the guarantee
 * that holds automatically the first time an operation writes two. The
 * correlation that IS immediately useful is between the `x-request-id` header
 * an operator saw and the row it produced.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

const entry = (overrides: Partial<AuditRecord> = {}): AuditRecord => ({
  actorUserId: null,
  actorEmail: 'ops@example.com',
  action: 'node_group.update',
  entityType: 'node_group',
  entityId: '6e7969f8-d24e-4b80-8ab8-fc0b53ddec23',
  ...overrides,
});

jest.setTimeout(30_000);

describe('audit correlation (integration)', () => {
  let prisma: PrismaService;
  let sink: PrismaAuditSink;

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    sink = new PrismaAuditSink(prisma);
  });

  describe('requestId', () => {
    /*
     * THE GUARANTEE. Every row written while serving one request carries one
     * id, so "what else did that operation do?" is a single indexed lookup
     * rather than arithmetic on adjacent timestamps.
     */
    it('stamps every row written in one request with the same id', async () => {
      const requestId = await runWithRequestId(async (id) => {
        await sink.record(entry({ action: 'node_group.update' }));
        await sink.record(entry({ action: 'node_group.rules.replace' }));
        await sink.record(entry({ action: 'node_group.class.assign' }));
        return id;
      });

      const rows = await prisma.auditLog.findMany({ select: { requestId: true } });

      expect(rows).toHaveLength(3);
      expect(rows.every((r) => r.requestId === requestId)).toBe(true);
    });

    it('retrieves a whole operation by its id', async () => {
      const first = await runWithRequestId(async (id) => {
        await sink.record(entry({ action: 'a' }));
        await sink.record(entry({ action: 'b' }));
        return id;
      });
      await runWithRequestId(async () => {
        await sink.record(entry({ action: 'unrelated' }));
      });

      const operation = await prisma.auditLog.findMany({
        where: { requestId: first },
        select: { action: true },
      });

      expect(operation.map((r) => r.action).sort()).toEqual(['a', 'b']);
    });

    /*
     * Two requests sharing an id would merge two operations into one story.
     * That is worse than no correlation, because it looks correct.
     */
    it('gives separate requests separate ids', async () => {
      await runWithRequestId(async () => sink.record(entry()));
      await runWithRequestId(async () => sink.record(entry()));

      const ids = await prisma.auditLog.findMany({ select: { requestId: true } });

      expect(new Set(ids.map((r) => r.requestId)).size).toBe(2);
    });

    /*
     * NULL IS CORRECT HERE, not a gap. Bootstrap, the retention sweeper and
     * background workers belong to no request; an invented id would imply an
     * operation a reader could go and look for.
     */
    it('leaves rows written outside a request uncorrelated', async () => {
      await sink.record(entry({ action: 'bootstrap.seed' }));

      const [row] = await prisma.auditLog.findMany({ select: { requestId: true } });

      expect(row?.requestId).toBeNull();
    });

    it('lets a caller override the ambient id', async () => {
      const explicit = '11111111-2222-4333-8444-555555555555';

      await runWithRequestId(async () => {
        await sink.record(entry({ requestId: explicit }));
      });

      const [row] = await prisma.auditLog.findMany({ select: { requestId: true } });

      expect(row?.requestId).toBe(explicit);
    });
  });

  describe('entityLabel', () => {
    /*
     * THE CASE IT EXISTS FOR, and the one that pays off today. After the group
     * is gone its id resolves to nothing, and the trail would otherwise read
     * `node_group / 6e7969f8-…` and name nothing at all.
     */
    it('records what a deleted entity was called', async () => {
      await sink.record(
        entry({
          action: 'node_group.delete',
          before: { name: 'baseline-jump-access', rank: 10 },
        }),
      );

      const [row] = await prisma.auditLog.findMany({ select: { entityLabel: true } });

      expect(row?.entityLabel).toBe('baseline-jump-access');
    });

    it('records a rename under the new name', async () => {
      await sink.record(entry({ before: { name: 'old' }, after: { name: 'new' } }));

      const [row] = await prisma.auditLog.findMany({ select: { entityLabel: true } });

      expect(row?.entityLabel).toBe('new');
    });

    it('is null when the payload names nothing, rather than inventing one', async () => {
      await sink.record(entry({ after: { rank: 20 } }));

      const [row] = await prisma.auditLog.findMany({ select: { entityLabel: true } });

      expect(row?.entityLabel).toBeNull();
    });

    /*
     * The column is VARCHAR(200). A label longer than that must be truncated
     * before insert, or Postgres rejects the row — failing the transaction that
     * carries the CHANGE, not merely its label.
     */
    it('stores an over-long label instead of failing the write', async () => {
      await expect(sink.record(entry({ after: { name: 'z'.repeat(500) } }))).resolves.toEqual(
        expect.any(String),
      );

      const [row] = await prisma.auditLog.findMany({ select: { entityLabel: true } });

      expect(row?.entityLabel).toHaveLength(200);
    });
  });
});
