import type { AuthenticatedPrincipal } from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { MaterializationService } from '../src/materialization/materialization.service';
import { PrismaAuditSink } from '../src/auth/core-capabilities';
import { ClassificationService } from '../src/classification/classification.service';

/**
 * Classification write path, against a REAL PostgreSQL.
 *
 * The one-transaction rule cannot be verified against a mock: the whole point
 * is what survives a rollback. These assert on the DATABASE after the fact,
 * not on which methods were called.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  process.env['DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet?schema=public';

const ACTOR: AuthenticatedPrincipal = {
  userId: '00000000-0000-0000-0000-0000000000aa',
  email: 'ops@example.com',
  displayName: 'Ops',
  role: 'OPERATOR',
  authSource: 'local',
};

const CTX = { ipAddress: '10.0.0.1', userAgent: 'jest' };

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
      process.env['PUPPETDB_PROJECTED_FACTS'] = 'os,networking';
      const group = (await create('rules')).group;

      const result = await service.replaceRules(
        group.id,
        { rules: [{ factPath: 'custom_fact.value', operator: 'EQUALS', value: 'x' }] },
        ACTOR,
        CTX,
      );

      expect(result.warnings.join(' ')).toContain('can never match');
      delete process.env['PUPPETDB_PROJECTED_FACTS'];
    });

    it('does not warn for a projected fact', async () => {
      process.env['PUPPETDB_PROJECTED_FACTS'] = 'os,networking';
      const group = (await create('rules')).group;

      const result = await service.replaceRules(
        group.id,
        { rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'RedHat' }] },
        ACTOR,
        CTX,
      );

      expect(result.warnings).toEqual([]);
      delete process.env['PUPPETDB_PROJECTED_FACTS'];
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
});
