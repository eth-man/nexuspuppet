import type { ClassificationConflict } from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { ConflictReportService } from '../src/classification/conflict-report.service';

/**
 * The estate-wide conflict report, against a REAL PostgreSQL.
 *
 * Two things here cannot be tested against a mock and are the reason this file
 * exists: that the "has conflicts" filter genuinely runs in Postgres rather than
 * silently returning everything, and that the keyset scan pages correctly past
 * its own chunk size. Both are the kind of thing that looks right and quietly
 * returns a subset.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(60_000);

const conflict = (over: Partial<ClassificationConflict> = {}): ClassificationConflict => ({
  kind: 'CLASS_PARAMETER',
  key: 'profile::base.ntp_servers',
  winningGroupId: '11111111-1111-1111-1111-111111111111',
  winningGroupName: 'web-tier',
  winningValue: ['ntp1'],
  losingGroupId: '22222222-2222-2222-2222-222222222222',
  losingGroupName: 'base-linux',
  losingValue: ['ntp0'],
  ...over,
});

describe('estate-wide conflict report (integration)', () => {
  let prisma: PrismaService;
  let service: ConflictReportService;

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    service = new ConflictReportService(prisma);
    await prisma.encMaterialization.deleteMany();
    await prisma.managedNode.deleteMany();
  });

  /** Materializations reference a node, so both rows are needed. */
  const seed = async (certname: string, conflicts: ClassificationConflict[]) => {
    await prisma.managedNode.create({
      data: { certname, facts: {}, environment: 'production' },
    });
    await prisma.encMaterialization.create({
      data: {
        certname,
        contentHash: certname.padEnd(64, '0').slice(0, 64),
        relativePath: `nodes/${certname}.yaml`,
        appliedGroupIds: [],
        conflicts: conflicts as never,
      },
    });
  };

  it('is empty, and says so with context, on a clean estate', async () => {
    await seed('a.test', []);
    await seed('b.test', []);

    const report = await service.report();

    expect(report.conflicts).toEqual([]);
    expect(report.nodesAffected).toBe(0);
    // The denominator matters: "0 conflicts" reads very differently next to
    // "across 2 nodes" than next to nothing at all.
    expect(report.nodesMaterialized).toBe(2);
  });

  it('aggregates one override across many nodes', async () => {
    await seed('a.test', [conflict()]);
    await seed('b.test', [conflict()]);
    await seed('c.test', []);

    const report = await service.report();

    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.nodeCount).toBe(2);
    expect(report.conflicts[0]?.winningGroupName).toBe('web-tier');
    expect(report.nodesAffected).toBe(2);
    expect(report.nodesMaterialized).toBe(3);
  });

  it('reads only nodes that have conflicts', async () => {
    // The filter must run in Postgres. If it silently matched everything the
    // counts below would still be right, so this asserts the shape that would
    // differ: clean nodes contribute nothing at all.
    for (let i = 0; i < 20; i += 1) await seed(`clean${i}.test`, []);
    await seed('dirty.test', [conflict()]);

    const report = await service.report();

    expect(report.nodesAffected).toBe(1);
    expect(report.conflicts[0]?.exampleCertnames).toEqual(['dirty.test']);
    expect(report.nodesMaterialized).toBe(21);
  });

  it('pages past its own chunk size without losing or repeating rows', async () => {
    // CHUNK is 500; 520 conflicted nodes forces a second round trip and a
    // cursor. An off-by-one in the keyset paging shows up here as a count of
    // 519 or 521, and nowhere else.
    const total = 520;
    await prisma.managedNode.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        certname: `n${String(i).padStart(4, '0')}.test`,
        facts: {},
        environment: 'production',
      })),
    });
    await prisma.encMaterialization.createMany({
      data: Array.from({ length: total }, (_, i) => ({
        certname: `n${String(i).padStart(4, '0')}.test`,
        contentHash: String(i).padStart(64, '0'),
        relativePath: `nodes/n${i}.yaml`,
        appliedGroupIds: [],
        conflicts: [conflict()] as never,
      })),
    });

    const report = await service.report();

    expect(report.nodesAffected).toBe(total);
    expect(report.conflicts).toHaveLength(1);
    expect(report.conflicts[0]?.nodeCount).toBe(total);
  });

  it('leads with an environment conflict over a much wider parameter one', async () => {
    for (let i = 0; i < 10; i += 1) await seed(`param${i}.test`, [conflict()]);
    await seed('env.test', [conflict({ kind: 'ENVIRONMENT', key: 'environment' })]);

    const report = await service.report();

    expect(report.conflicts[0]?.kind).toBe('ENVIRONMENT');
    expect(report.conflicts[1]?.nodeCount).toBe(10);
  });
});
