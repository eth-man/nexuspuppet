import { EncDocumentReader } from '../src/materialization/enc-document-reader';
import type { AuditRecord, AuditTransaction, AuthenticatedPrincipal } from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { MaterializationService } from '../src/materialization/materialization.service';
import { PrismaAuditSink } from '../src/auth/core-capabilities';
import { ClassificationService } from '../src/classification/classification.service';
import { roleIdFor } from './support/roles';

/**
 * Classification write path, against a REAL PostgreSQL.
 *
 * The one-transaction rule cannot be verified against a mock: the whole point
 * is what survives a rollback. These assert on the DATABASE after the fact,
 * not on which methods were called.
 */

/**
 * These tests TRUNCATE tables. They must never point at a database anyone is
 * using: a leftover fixture row once blocked admin bootstrap on the dev stack
 * and made login impossible. `npm run test:int` supplies TEST_DATABASE_URL;
 * the fallback is the dedicated test database, never the dev one.
 */
const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

const ACTOR: AuthenticatedPrincipal = {
  userId: '00000000-0000-0000-0000-0000000000aa',
  email: 'ops@example.com',
  displayName: 'Ops',
  role: 'OPERATOR',
  authSource: 'local',
};

const CTX = { ipAddress: '10.0.0.1', userAgent: 'jest' };

/**
 * The projected fact allow-list these tests classify against.
 *
 * Passed EXPLICITLY to the constructor rather than set in process.env. The
 * service used to read the environment itself, which meant the unprojected-fact
 * warning silently disabled itself whenever an operator relied on the config
 * default — the default deployment. Tests that configured it through the
 * environment could not have caught that, because they always set it.
 */
const PROJECTED = ['os', 'networking', 'kernel'];

jest.setTimeout(30_000);

describe('classification writes (integration)', () => {
  let prisma: PrismaService;
  let service: ClassificationService;

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    service = new ClassificationService(
      prisma,
      new MaterializationService(),
      new PrismaAuditSink(prisma),
      PROJECTED,
      new EncDocumentReader(ENC_DIR_FOR_TESTS),
    );

    await prisma.encMaterializationJob.deleteMany();
    await prisma.encMaterialization.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.nodeGroupPin.deleteMany();
    await prisma.nodeGroupClass.deleteMany();
    await prisma.nodeGroupParameter.deleteMany();
    await prisma.nodeGroupRule.deleteMany();
    await prisma.nodeGroup.deleteMany();
    await prisma.managedNode.deleteMany();
    await prisma.user.deleteMany();

    await prisma.user.create({
      data: {
        id: ACTOR.userId,
        email: ACTOR.email,
        displayName: ACTOR.displayName,
        role: 'OPERATOR',
        roleId: await roleIdFor(prisma, 'OPERATOR'),
      },
    });
  });

  const seedNode = (certname: string) =>
    prisma.managedNode.create({ data: { certname, facts: {}, environment: 'production' } });

  const materializedAs = (certname: string, groupIds: string[]) =>
    prisma.encMaterialization.create({
      data: {
        certname,
        contentHash: 'x'.repeat(64),
        relativePath: `nodes/${certname}.yaml`,
        appliedGroupIds: groupIds,
      },
    });

  const create = (name: string, over: Record<string, unknown> = {}) =>
    service.create(
      {
        name,
        rank: 100,
        strategy: 'ALL_RULES',
        environment: null,
        isEnabled: true,
        parentId: null,
        ...over,
      } as Parameters<ClassificationService['create']>[0],
      ACTOR,
      CTX,
    );

  /**
   * Configuration a strategy makes inert.
   *
   * `groupMatches` reads pins only for PINNED groups and rules only for
   * rule-based ones. Everything below saves successfully, writes an audit row,
   * and moves no nodes — so the warning is the only thing standing between an
   * operator and a silent no-op.
   */
  describe('warns when the match strategy ignores what was just written', () => {
    it('tells you a pin on a rule-based group decides nothing', async () => {
      const group = await create('rule-based', { strategy: 'ALL_RULES' });
      await seedNode('web01.example.com');

      const result = await service.addPins(group.group.id, ['web01.example.com'], ACTOR, CTX);

      expect(result.warnings.some((w) => w.includes('strategy is ALL_RULES'))).toBe(true);
      expect(result.warnings.some((w) => w.includes('PINNED'))).toBe(true);
    });

    it('stays quiet when the pin lands on a PINNED group', async () => {
      const group = await create('pinned', { strategy: 'PINNED' });
      await seedNode('web01.example.com');

      const result = await service.addPins(group.group.id, ['web01.example.com'], ACTOR, CTX);

      expect(result.warnings).toEqual([]);
    });

    it('tells you a rule-based group left with no rules matches nothing', async () => {
      const group = await create('emptied', { strategy: 'ANY_RULE' });

      const result = await service.replaceRules(group.group.id, { rules: [] }, ACTOR, CTX);

      expect(result.warnings).toContain('A rule-based group with no rules matches no nodes.');
    });

    it('tells you rules on a PINNED group decide nothing', async () => {
      const group = await create('pinned-with-rules', { strategy: 'PINNED' });

      const result = await service.replaceRules(
        group.group.id,
        { rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'Debian' }] },
        ACTOR,
        CTX,
      );

      expect(result.warnings.some((w) => w.includes('strategy is PINNED'))).toBe(true);
    });

    it('tells you a strategy change has orphaned every pin', async () => {
      // The sharpest case: one field, and every pin on the group stops meaning
      // anything. Nothing else in the product mentions it.
      const group = await create('was-pinned', { strategy: 'PINNED' });
      await seedNode('web01.example.com');
      await seedNode('web02.example.com');
      await service.addPins(group.group.id, ['web01.example.com', 'web02.example.com'], ACTOR, CTX);

      const result = await service.update(group.group.id, { strategy: 'ALL_RULES' }, ACTOR, CTX);

      expect(result.warnings.some((w) => w.includes('2 pinned nodes'))).toBe(true);
      expect(result.warnings).toContain('A rule-based group with no rules matches no nodes.');
    });

    it('does not warn on an unrelated group edit', async () => {
      const group = await create('renamed', { strategy: 'PINNED' });

      const result = await service.update(group.group.id, { name: 'renamed-again' }, ACTOR, CTX);

      expect(result.warnings).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------

  /**
   * The rule the whole outbox design exists to enforce. Asserted by checking
   * the database, because "we called enqueue" is not the same claim as "the job
   * is committed alongside the change".
   */
  describe('the one-transaction rule', () => {
    it('writes the change, the audit row, and the outbox job together', async () => {
      await seedNode('web01');
      const group = (await create('base')).group;
      await materializedAs('web01', [group.id]);

      await prisma.encMaterializationJob.deleteMany();
      await prisma.auditLog.deleteMany();

      await service.assignClass(
        group.id,
        { className: 'profile::base', params: { ntp: 'a.pool' } },
        ACTOR,
        CTX,
      );

      expect(await prisma.nodeGroupClass.count({ where: { groupId: group.id } })).toBe(1);
      expect(await prisma.auditLog.count({ where: { action: 'node-group.class.assign' } })).toBe(1);
      expect(await prisma.encMaterializationJob.count({ where: { certname: 'web01' } })).toBe(1);
    });

    // If any part fails, none of it may land — otherwise an audit row or an
    // outbox job could describe a change that never happened.
    it('leaves NOTHING behind when the transaction fails', async () => {
      const group = (await create('base')).group;
      await prisma.encMaterializationJob.deleteMany();
      await prisma.auditLog.deleteMany();

      // A duplicate name fails after the audit and outbox writes would have run.
      await expect(create('base')).rejects.toThrow();

      expect(await prisma.nodeGroup.count()).toBe(1);
      expect(await prisma.auditLog.count()).toBe(0);
      expect(await prisma.encMaterializationJob.count()).toBe(0);

      // And the original is untouched.
      expect((await service.get(group.id)).name).toBe('base');
    });

    it('records the actor and the before/after on every write', async () => {
      const group = (await create('base')).group;
      await service.update(group.id, { description: 'now described' }, ACTOR, CTX);

      const entry = await prisma.auditLog.findFirst({
        where: { action: 'node-group.update' },
      });

      expect(entry?.actorUserId).toBe(ACTOR.userId);
      expect(entry?.actorEmail).toBe(ACTOR.email);
      expect(entry?.ipAddress).toBe('10.0.0.1');
      expect(entry?.before).not.toBeNull();
      expect(entry?.after).not.toBeNull();
    });
  });

  /**
   * The easiest thing here to get quietly wrong. Being wrong strands nodes on
   * stale configuration until the periodic reconcile notices.
   */
  describe('which nodes get queued', () => {
    it('a rule change triggers a FULL reconcile, because it can pull in new nodes', async () => {
      const group = (await create('rules')).group;
      await prisma.encMaterializationJob.deleteMany();

      const result = await service.replaceRules(
        group.id,
        { rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'RedHat' }] },
        ACTOR,
        CTX,
      );

      expect(result.materializationQueued.scope).toBe('full-reconcile');
      const job = await prisma.encMaterializationJob.findUnique({
        where: { dedupeKey: 'full-reconcile' },
      });
      expect(job?.certname).toBeNull();
    });

    it('a class change queues only the nodes matching now', async () => {
      await seedNode('web01');
      await seedNode('unrelated01');
      const group = (await create('base')).group;
      await materializedAs('web01', [group.id]);
      await materializedAs('unrelated01', []);
      await prisma.encMaterializationJob.deleteMany();

      const result = await service.assignClass(
        group.id,
        { className: 'profile::base', params: {} },
        ACTOR,
        CTX,
      );

      expect(result.materializationQueued.certnames).toEqual(['web01']);
      const jobs = await prisma.encMaterializationJob.findMany();
      expect(jobs.map((j) => j.certname)).toEqual(['web01']);
    });

    // Once the rows are gone there is no way to learn which nodes the group was
    // classifying, and their files would keep the old classification.
    it('DELETE captures affected nodes BEFORE the rows disappear', async () => {
      await seedNode('web01');
      await seedNode('web02');
      const group = (await create('doomed')).group;
      await materializedAs('web01', [group.id]);
      await materializedAs('web02', [group.id]);
      await prisma.encMaterializationJob.deleteMany();

      const result = await service.remove(group.id, ACTOR, CTX);

      expect(result.materializationQueued.certnames.sort()).toEqual(['web01', 'web02']);
      expect(await prisma.nodeGroup.count({ where: { id: group.id } })).toBe(0);

      const jobs = await prisma.encMaterializationJob.findMany();
      expect(jobs.map((j) => j.certname).sort()).toEqual(['web01', 'web02']);
    });

    // A deletion cannot make a node START matching, so a full reconcile is
    // unnecessary work over the whole estate.
    it('DELETE does not trigger a full reconcile', async () => {
      await seedNode('web01');
      const group = (await create('doomed')).group;
      await materializedAs('web01', [group.id]);
      await prisma.encMaterializationJob.deleteMany();

      await service.remove(group.id, ACTOR, CTX);

      expect(
        await prisma.encMaterializationJob.findUnique({ where: { dedupeKey: 'full-reconcile' } }),
      ).toBeNull();
    });

    it('unpinning queues the node that was removed', async () => {
      await seedNode('special01');
      const group = (await create('pinned', { strategy: 'PINNED' })).group;
      await service.addPins(group.id, ['special01'], ACTOR, CTX);
      await prisma.encMaterializationJob.deleteMany();

      const result = await service.removePin(group.id, 'special01', ACTOR, CTX);

      // It no longer matches, so its file must be rewritten without this group.
      expect(result.materializationQueued.certnames).toContain('special01');
    });

    it('rank and enablement changes trigger a full reconcile, because merge order moves', async () => {
      const group = (await create('base')).group;

      for (const change of [{ rank: 500 }, { isEnabled: false }]) {
        await prisma.encMaterializationJob.deleteMany();
        const result = await service.update(group.id, change, ACTOR, CTX);
        expect(result.materializationQueued.scope).toBe('full-reconcile');
      }
    });

    it('a rename queues nothing, because it changes no classification', async () => {
      const group = (await create('base')).group;
      await prisma.encMaterializationJob.deleteMany();

      const result = await service.update(group.id, { name: 'renamed' }, ACTOR, CTX);

      expect(result.materializationQueued.scope).toBe('nodes');
      expect(await prisma.encMaterializationJob.count()).toBe(0);
    });
  });

  describe('validation', () => {
    it('rejects a duplicate name', async () => {
      await create('base');
      await expect(create('base')).rejects.toThrow(/already exists/);
    });

    it('allows a group to keep its own name on update', async () => {
      const group = (await create('base')).group;
      await expect(
        service.update(group.id, { name: 'base', rank: 200 }, ACTOR, CTX),
      ).resolves.toBeDefined();
    });

    it('rejects a non-existent parent', async () => {
      await expect(
        create('child', { parentId: '00000000-0000-0000-0000-00000000ffff' }),
      ).rejects.toThrow(/does not exist/);
    });

    // A cycle makes evaluation order undefined and hangs any traversal. The
    // database cannot express this constraint.
    describe('hierarchy cycles', () => {
      it('rejects a group as its own parent', async () => {
        const group = (await create('base')).group;
        await expect(service.update(group.id, { parentId: group.id }, ACTOR, CTX)).rejects.toThrow(
          /own parent/,
        );
      });

      it('rejects a two-group cycle', async () => {
        const a = (await create('a')).group;
        const b = (await create('b', { parentId: a.id })).group;

        await expect(service.update(a.id, { parentId: b.id }, ACTOR, CTX)).rejects.toThrow(/cycle/);
      });

      it('rejects a deeper cycle', async () => {
        const a = (await create('a')).group;
        const b = (await create('b', { parentId: a.id })).group;
        const c = (await create('c', { parentId: b.id })).group;

        await expect(service.update(a.id, { parentId: c.id }, ACTOR, CTX)).rejects.toThrow(/cycle/);
      });

      it('permits a legitimate re-parent', async () => {
        const a = (await create('a')).group;
        await create('b', { parentId: a.id });
        const c = (await create('c')).group;

        await expect(service.update(c.id, { parentId: a.id }, ACTOR, CTX)).resolves.toBeDefined();
      });
    });

    // Cascading would reclassify every descendant's nodes in one unreviewable
    // step.
    it('refuses to delete a group that has children', async () => {
      const parent = (await create('parent')).group;
      await create('child', { parentId: parent.id });

      await expect(service.remove(parent.id, ACTOR, CTX)).rejects.toThrow(/child group/);
    });

    it('404s on an unknown group', async () => {
      await expect(service.get('00000000-0000-0000-0000-00000000ffff')).rejects.toThrow();
      await expect(
        service.removeClass('00000000-0000-0000-0000-00000000ffff', 'profile::x', ACTOR, CTX),
      ).rejects.toThrow();
    });

    it('404s when removing a class the group does not assign', async () => {
      const group = (await create('base')).group;
      await expect(service.removeClass(group.id, 'profile::never', ACTOR, CTX)).rejects.toThrow(
        /does not assign/,
      );
    });
  });

  describe('warnings', () => {
    // A rule on an unprojected fact can NEVER match. Silently never matching is
    // the worst outcome, so it must be surfaced (ADR-0004).
    it('warns when a rule references a fact outside the projection', async () => {
      const group = (await create('rules')).group;

      const result = await service.replaceRules(
        group.id,
        { rules: [{ factPath: 'custom_fact.value', operator: 'EQUALS', value: 'x' }] },
        ACTOR,
        CTX,
      );

      expect(result.warnings.join(' ')).toContain('can never match');
    });

    it('does not warn for a projected fact', async () => {
      const group = (await create('rules')).group;

      const result = await service.replaceRules(
        group.id,
        { rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'RedHat' }] },
        ACTOR,
        CTX,
      );

      expect(result.warnings).toEqual([]);
    });

    /**
     * The regression that prompted this change.
     *
     * The check read process.env directly, so with PUPPETDB_PROJECTED_FACTS
     * unset — the DEFAULT deployment, where Zod supplies the default further
     * down — it saw an empty list and returned no warnings at all. The safety
     * net switched itself off in exactly the configuration most people run.
     *
     * The variable is explicitly removed here, so this fails if the service
     * ever reaches for the environment again.
     */
    it('still warns when the environment variable is unset', async () => {
      const saved = process.env['PUPPETDB_PROJECTED_FACTS'];
      delete process.env['PUPPETDB_PROJECTED_FACTS'];
      try {
        const configured = new ClassificationService(
          prisma,
          new MaterializationService(),
          new PrismaAuditSink(prisma),
          PROJECTED,
          new EncDocumentReader(ENC_DIR_FOR_TESTS),
        );
        const group = (await create('rules')).group;

        const result = await configured.replaceRules(
          group.id,
          { rules: [{ factPath: 'role', operator: 'EQUALS', value: 'web' }] },
          ACTOR,
          CTX,
        );

        expect(result.warnings.join(' ')).toContain('can never match');
      } finally {
        if (saved === undefined) delete process.env['PUPPETDB_PROJECTED_FACTS'];
        else process.env['PUPPETDB_PROJECTED_FACTS'] = saved;
      }
    });

    /**
     * An empty list means projection is DISABLED, a legitimate deployment — a
     * replica that only serves HTTP. Warning on every rule there would be noise
     * about a system working as configured.
     */
    it('does not warn when projection is disabled', async () => {
      const disabled = new ClassificationService(
        prisma,
        new MaterializationService(),
        new PrismaAuditSink(prisma),
        [],
        new EncDocumentReader(ENC_DIR_FOR_TESTS),
      );
      const group = (await create('rules')).group;

      const result = await disabled.replaceRules(
        group.id,
        { rules: [{ factPath: 'anything.at.all', operator: 'EQUALS', value: 'x' }] },
        ACTOR,
        CTX,
      );

      expect(result.warnings).toEqual([]);
    });

    // Pinning a not-yet-provisioned node is legitimate, but it will not
    // materialize until the node appears.
    it('warns when pinning a node PuppetDB has never seen', async () => {
      const group = (await create('pinned', { strategy: 'PINNED' })).group;
      const result = await service.addPins(group.id, ['not-yet-built01'], ACTOR, CTX);

      expect(result.warnings.join(' ')).toContain('have not reported to PuppetDB yet');
    });
  });

  describe('rules are replaced as a set', () => {
    // Applying an add and a remove separately would briefly materialize an
    // intermediate classification nobody asked for.
    it('one call swaps the whole rule set', async () => {
      const group = (await create('rules')).group;

      await service.replaceRules(
        group.id,
        { rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'RedHat' }] },
        ACTOR,
        CTX,
      );
      await service.replaceRules(
        group.id,
        { rules: [{ factPath: 'kernel', operator: 'EQUALS', value: 'Linux' }] },
        ACTOR,
        CTX,
      );

      const detail = await service.get(group.id);
      expect(detail.rules).toHaveLength(1);
      expect(detail.rules[0]?.factPath).toBe('kernel');
    });

    it('an empty set clears the rules', async () => {
      const group = (await create('rules')).group;
      await service.replaceRules(
        group.id,
        { rules: [{ factPath: 'kernel', operator: 'EQUALS', value: 'Linux' }] },
        ACTOR,
        CTX,
      );

      await service.replaceRules(group.id, { rules: [] }, ACTOR, CTX);
      expect((await service.get(group.id)).rules).toEqual([]);
    });
  });

  /**
   * Rule authoring is where a typo fails silently: a misspelt fact path simply
   * never matches, and nothing tells the operator. These back the UI's picker.
   */
  describe('fact path discovery', () => {
    const seedNodeWithFacts = (certname: string, facts: Record<string, unknown>) =>
      prisma.managedNode.create({
        data: { certname, facts: facts as object, environment: 'production' },
      });

    it('lists dotted paths from the projection', async () => {
      await seedNodeWithFacts('a01', { os: { family: 'RedHat', release: { major: '9' } } });

      const index = await service.listFactPaths();
      const paths = index.paths.map((p) => p.path);

      expect(paths).toContain('os.family');
      expect(paths).toContain('os.release.major');
      // Containers are matchable too — EXISTS on `os` is a legitimate rule.
      expect(paths).toContain('os');
    });

    it('counts coverage, so a fact on 1 of 50 nodes is visibly rare', async () => {
      await seedNodeWithFacts('a01', { kernel: 'Linux', rare_fact: 'yes' });
      await seedNodeWithFacts('a02', { kernel: 'Linux' });
      await seedNodeWithFacts('a03', { kernel: 'Linux' });

      const index = await service.listFactPaths();
      const byPath = new Map(index.paths.map((p) => [p.path, p]));

      expect(byPath.get('kernel')?.nodeCount).toBe(3);
      expect(byPath.get('rare_fact')?.nodeCount).toBe(1);
      expect(index.nodesScanned).toBe(3);
    });

    it('offers distinct values for a low-cardinality path', async () => {
      await seedNodeWithFacts('a01', { os: { family: 'RedHat' } });
      await seedNodeWithFacts('a02', { os: { family: 'Debian' } });
      await seedNodeWithFacts('a03', { os: { family: 'RedHat' } });

      const family = (await service.listFactPaths()).paths.find((p) => p.path === 'os.family');
      expect(family?.values?.sort()).toEqual(['Debian', 'RedHat']);
    });

    // A dropdown of 1,000 IP addresses is noise, not help.
    it('omits values for a high-cardinality path', async () => {
      for (let i = 0; i < 30; i += 1) {
        await seedNodeWithFacts(`h${i}`, { ip: `10.0.0.${i}` });
      }

      const ip = (await service.listFactPaths()).paths.find((p) => p.path === 'ip');
      expect(ip?.nodeCount).toBe(30);
      expect(ip?.values).toBeUndefined();
    });

    // A container's value is a whole object, and the evaluator never equates an
    // object with a scalar — suggesting one would offer a rule that cannot match.
    it('offers no value picker for a container path', async () => {
      await seedNodeWithFacts('a01', { os: { family: 'RedHat' } });
      await seedNodeWithFacts('a02', { os: { family: 'Debian' } });

      const paths = (await service.listFactPaths()).paths;
      expect(paths.find((p) => p.path === 'os')?.values).toBeUndefined();
      // The leaf beneath it still gets one.
      expect(paths.find((p) => p.path === 'os.family')?.values?.sort()).toEqual([
        'Debian',
        'RedHat',
      ]);
    });

    // Arrays are matched whole by RuleEvaluator, never by index, so the picker
    // must not suggest paths the evaluator cannot resolve.
    it('treats arrays as leaves, matching the evaluator', async () => {
      await seedNodeWithFacts('a01', { processors: { models: ['a', 'b'] } });

      const paths = (await service.listFactPaths()).paths.map((p) => p.path);
      expect(paths).toContain('processors.models');
      expect(paths).not.toContain('processors.models.0');
    });

    it('returns an empty index rather than throwing on an empty projection', async () => {
      const index = await service.listFactPaths();
      expect(index).toEqual({ paths: [], nodesScanned: 0 });
    });
  });

  describe('explain', () => {
    it('returns applied groups in MERGE order, not database order', async () => {
      await seedNode('web01');
      const low = (await create('low', { rank: 100 })).group;
      const high = (await create('high', { rank: 900 })).group;

      // Merge order: low first, high last (and therefore winning).
      await materializedAs('web01', [low.id, high.id]);

      const explanation = await service.explain('web01');
      expect(explanation.appliedGroups.map((g) => g.name)).toEqual(['low', 'high']);
    });

    it('reports a queued change as pending, so stale data is not shown as current', async () => {
      await seedNode('web01');
      const group = (await create('base')).group;
      await materializedAs('web01', [group.id]);

      expect((await service.explain('web01')).pending).toBe(false);

      await service.assignClass(group.id, { className: 'profile::x', params: {} }, ACTOR, CTX);
      expect((await service.explain('web01')).pending).toBe(true);
    });

    it('handles a node that has never been materialized', async () => {
      await seedNode('fresh01');
      const explanation = await service.explain('fresh01');

      expect(explanation.materialization).toBeNull();
      expect(explanation.appliedGroups).toEqual([]);
      expect(explanation.factsAsOf).not.toBeNull();
    });

    it('handles an entirely unknown node without throwing', async () => {
      const explanation = await service.explain('never-heard-of-it');
      expect(explanation.materialization).toBeNull();
      expect(explanation.factsAsOf).toBeNull();
    });
  });

  /**
   * The AUDIT_SINK seam, end to end.
   *
   * The structural test in capability-wiring.spec.ts proves nothing INJECTS
   * PrismaAuditSink any more. This proves the consequence that actually
   * matters: a sink registered by the enterprise layer genuinely receives
   * classification events. Before the fix it would have been constructed,
   * held by the container, and never called — a SIEM reporting silence for an
   * estate that was being reclassified, which is worse than no SIEM at all
   * because silence reads as "no changes".
   */
  describe('the audit seam', () => {
    /** Records what it is given, and writes nothing. */
    class RecordingAuditSink {
      entries: Array<{ action: string; entityType: string; hadTransaction: boolean }> = [];

      async record(entry: AuditRecord, tx?: AuditTransaction): Promise<string> {
        this.entries.push({
          action: entry.action,
          entityType: entry.entityType,
          // ADR-0005: the audit row commits with the change. A sink that is
          // handed no transaction cannot honour that, so the handle arriving is
          // part of the contract rather than an implementation detail.
          hadTransaction: tx !== undefined,
        });
        // The contract returns the stored record's id so a composing sink can
        // reference it. This one stores nothing, so a stable stand-in will do.
        return `recorded-${this.entries.length}`;
      }
    }

    it('delivers classification events to a substituted sink', async () => {
      const sink = new RecordingAuditSink();
      const substituted = new ClassificationService(
        prisma,
        new MaterializationService(),
        sink,
        PROJECTED,
        new EncDocumentReader(ENC_DIR_FOR_TESTS),
      );

      await substituted.create(
        {
          name: 'audited-group',
          rank: 100,
          strategy: 'ALL_RULES',
          environment: null,
          isEnabled: true,
          parentId: null,
        } as Parameters<ClassificationService['create']>[0],
        ACTOR,
        CTX,
      );

      expect(sink.entries).toHaveLength(1);
      expect(sink.entries[0]?.entityType).toBe('NodeGroup');
      expect(sink.entries[0]?.hadTransaction).toBe(true);
    });

    /**
     * The substituted sink writes nothing to Postgres, so an empty AuditLog is
     * what proves the event went THERE rather than to the core sink as well.
     */
    it('routes the event to the substitute rather than to Postgres', async () => {
      const sink = new RecordingAuditSink();
      const substituted = new ClassificationService(
        prisma,
        new MaterializationService(),
        sink,
        PROJECTED,
        new EncDocumentReader(ENC_DIR_FOR_TESTS),
      );

      await substituted.create(
        {
          name: 'not-in-postgres',
          rank: 100,
          strategy: 'ALL_RULES',
          environment: null,
          isEnabled: true,
          parentId: null,
        } as Parameters<ClassificationService['create']>[0],
        ACTOR,
        CTX,
      );

      expect(sink.entries).toHaveLength(1);
      expect(await prisma.auditLog.count()).toBe(0);
      // The change itself still landed: substituting the sink must not make the
      // write a no-op.
      expect(await prisma.nodeGroup.count({ where: { name: 'not-in-postgres' } })).toBe(1);
    });
  });
});

/**
 * Deliberately absent: these tests assert classification, not file contents,
 * so readNode() returns null and the node reads as falling back to default.yaml.
 */
const ENC_DIR_FOR_TESTS = '/nonexistent/enc-output-for-tests';
