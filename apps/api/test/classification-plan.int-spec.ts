import { EncDocumentReader } from '../src/materialization/enc-document-reader';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthenticatedPrincipal } from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { PosixEncStorage } from '../src/materialization/posix-enc-storage';
import { MaterializerService } from '../src/materialization/materializer.service';
import { MaterializationService } from '../src/materialization/materialization.service';
import { PrismaAuditSink } from '../src/auth/core-capabilities';
import { ClassificationService } from '../src/classification/classification.service';
import { ClassificationPlanner } from '../src/classification/plan/classification-planner.service';
import { roleIdFor } from './support/roles';

/**
 * "Plan before apply", against a REAL PostgreSQL.
 *
 * The property everything rests on: **a plan predicts the apply exactly**. The
 * planner runs the same matchGroups → mergeGroups → renderEncDocument pipeline
 * the materializer runs, so for the estate as it stands the forecast is not an
 * approximation — it is the outcome.
 *
 * Several tests assert that by planning a change, applying it for real, and
 * comparing the two. A preview that drifts from the write is worse than no
 * preview, because it is trusted.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

const ACTOR: AuthenticatedPrincipal = {
  userId: '00000000-0000-0000-0000-0000000000aa',
  email: 'ops@example.com',
  displayName: 'Ops',
  role: 'ADMIN',
  authSource: 'local',
};
const CTX = { ipAddress: '10.0.0.1', userAgent: 'jest' };
const PROJECTED = ['os', 'kernel', 'networking'];

jest.setTimeout(60_000);

describe('classification plan (integration)', () => {
  let prisma: PrismaService;
  let planner: ClassificationPlanner;
  let classification: ClassificationService;
  let materializer: MaterializerService;

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    const encDir = await mkdtemp(join(tmpdir(), 'nexuspuppet-plan-'));
    const writer = new PosixEncStorage(encDir);
    await writer.ensureLayout();

    materializer = new MaterializerService(prisma, writer, 5, 'production');
    planner = new ClassificationPlanner(prisma, materializer);
    classification = new ClassificationService(
      prisma,
      new MaterializationService(),
      new PrismaAuditSink(prisma),
      PROJECTED,
      new EncDocumentReader(ENC_DIR_FOR_TESTS),
    );

    await prisma.encMaterializationJob.deleteMany();
    await prisma.encMaterialization.deleteMany();
    await prisma.nodeGroupPin.deleteMany();
    await prisma.nodeGroupClass.deleteMany();
    await prisma.nodeGroupParameter.deleteMany();
    await prisma.nodeGroupRule.deleteMany();
    await prisma.nodeGroup.deleteMany();
    await prisma.managedNode.deleteMany();
    await prisma.auditLog.deleteMany();
    await prisma.user.deleteMany();

    await prisma.user.create({
      data: {
        id: ACTOR.userId,
        email: ACTOR.email,
        displayName: ACTOR.displayName,
        role: 'ADMIN',
        roleId: await roleIdFor(prisma, 'ADMIN'),
        passwordHash: 'x',
        isActive: true,
      },
    });
  });

  const seedNode = (certname: string, facts: Record<string, unknown>) =>
    prisma.managedNode.create({
      data: { certname, facts: facts as never, environment: 'production' },
    });

  const linux = (n: number) => ({
    kernel: 'Linux',
    os: { family: n % 2 === 0 ? 'Debian' : 'RedHat' },
  });

  const createGroup = async (name: string, rank = 100) => {
    const result = await classification.create(
      {
        name,
        rank,
        strategy: 'ALL_RULES',
        environment: null,
        isEnabled: true,
        parentId: null,
      } as Parameters<ClassificationService['create']>[0],
      ACTOR,
      CTX,
    );
    return result.group.id;
  };

  describe('predicting a rule change', () => {
    it('reports which nodes a new rule would newly classify', async () => {
      for (let i = 0; i < 6; i += 1) await seedNode(`node${i}.test`, linux(i));
      const id = await createGroup('base-linux');
      await classification.assignClass(id, { className: 'profile::base', params: {} }, ACTOR, CTX);

      const plan = await planner.plan({
        operation: 'replace-rules',
        groupId: id,
        rules: [{ factPath: 'kernel', operator: 'EQUALS', value: 'Linux' }],
      });

      // Every node is Linux, and none had any classification before.
      expect(plan.counts.total).toBe(6);
      expect(plan.counts.added).toBe(6);
      expect(plan.counts.unchanged).toBe(0);
      expect(plan.shapes).toHaveLength(1);
      expect(plan.shapes[0]?.diff.classesAdded).toEqual(['profile::base']);
    });

    it('narrows to the nodes a selective rule matches', async () => {
      for (let i = 0; i < 6; i += 1) await seedNode(`node${i}.test`, linux(i));
      const id = await createGroup('debian-only');
      await classification.assignClass(id, { className: 'profile::apt', params: {} }, ACTOR, CTX);

      const plan = await planner.plan({
        operation: 'replace-rules',
        groupId: id,
        rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'Debian' }],
      });

      expect(plan.counts.total).toBe(3);
      // The reassuring number: most of the estate is untouched.
      expect(plan.counts.unchanged).toBe(3);
    });

    /**
     * The dangerous direction, and the reason `removed` is counted separately:
     * a node quietly LOSING classification is the outcome nobody expects.
     */
    it('reports nodes that would stop being classified', async () => {
      for (let i = 0; i < 4; i += 1) await seedNode(`node${i}.test`, linux(i));
      const id = await createGroup('base-linux');
      await classification.replaceRules(
        id,
        { rules: [{ factPath: 'kernel', operator: 'EQUALS', value: 'Linux' }] },
        ACTOR,
        CTX,
      );
      await classification.assignClass(id, { className: 'profile::base', params: {} }, ACTOR, CTX);

      const plan = await planner.plan({
        operation: 'replace-rules',
        groupId: id,
        rules: [{ factPath: 'kernel', operator: 'EQUALS', value: 'Darwin' }],
      });

      expect(plan.counts.removed).toBe(4);
      expect(plan.shapes[0]?.kind).toBe('removed');
      expect(plan.shapes[0]?.diff.classesRemoved).toEqual(['profile::base']);
    });

    it('warns that a rule-based group with no rules matches nothing', async () => {
      await seedNode('node0.test', linux(0));
      const id = await createGroup('empty');

      const plan = await planner.plan({ operation: 'replace-rules', groupId: id, rules: [] });

      expect(plan.warnings.join(' ')).toContain('no rules matches no nodes');
    });
  });

  describe('the forecast matches the apply', () => {
    /**
     * The property the whole feature is worth having for. Plan, then apply for
     * real, then compare: the nodes the plan named must be exactly the nodes
     * whose materialized document changed.
     */
    it('predicts exactly which nodes change', async () => {
      for (let i = 0; i < 6; i += 1) await seedNode(`node${i}.test`, linux(i));
      const id = await createGroup('base-linux');
      await classification.replaceRules(
        id,
        { rules: [{ factPath: 'kernel', operator: 'EQUALS', value: 'Linux' }] },
        ACTOR,
        CTX,
      );
      await materializer.drain();
      const before = await prisma.encMaterialization.findMany({
        select: { certname: true, contentHash: true },
      });

      const plan = await planner.plan({
        operation: 'assign-class',
        groupId: id,
        className: 'profile::base',
        params: { ntp: ['a'] },
      });

      // Now really do it.
      await classification.assignClass(
        id,
        { className: 'profile::base', params: { ntp: ['a'] } },
        ACTOR,
        CTX,
      );
      await materializer.drain();

      const after = await prisma.encMaterialization.findMany({
        select: { certname: true, contentHash: true },
      });
      const beforeByName = new Map(before.map((m) => [m.certname, m.contentHash]));
      const reallyChanged = after
        .filter((m) => beforeByName.get(m.certname) !== m.contentHash)
        .map((m) => m.certname)
        .sort();

      const predicted = plan.shapes.flatMap((s) => s.certnames).sort();

      expect(predicted).toEqual(reallyChanged);
      expect(plan.counts.total).toBe(reallyChanged.length);
    });

    it('predicts a no-op as a no-op', async () => {
      for (let i = 0; i < 4; i += 1) await seedNode(`node${i}.test`, linux(i));
      const id = await createGroup('base-linux');
      await classification.replaceRules(
        id,
        { rules: [{ factPath: 'kernel', operator: 'EQUALS', value: 'Linux' }] },
        ACTOR,
        CTX,
      );
      await classification.assignClass(id, { className: 'profile::base', params: {} }, ACTOR, CTX);
      await materializer.drain();

      // Assigning the same class with the same parameters changes nothing.
      const plan = await planner.plan({
        operation: 'assign-class',
        groupId: id,
        className: 'profile::base',
        params: {},
      });

      expect(plan.counts.total).toBe(0);
      expect(plan.shapes).toEqual([]);
      expect(plan.counts.unchanged).toBe(4);
    });
  });

  describe('shapes explain why they are separate', () => {
    /**
     * Shapes are keyed on before AND after state, so nodes with different
     * existing group sets are separate even when the change applied to them is
     * identical. Reported by someone using the preview: four boxes each showing
     * the same one-line diff read as repetition rather than as distinct
     * populations, because the thing that made them separate was not displayed.
     */
    it('names the groups each population already matches', async () => {
      await seedNode('linux0.test', linux(0));
      await seedNode('linux1.test', linux(1));

      const base = await createGroup('base', 100);
      await classification.replaceRules(
        base,
        { rules: [{ factPath: 'kernel', operator: 'EQUALS', value: 'Linux' }] },
        ACTOR,
        CTX,
      );

      // Matches only half the estate, so two populations exist: nodes with the
      // base group alone, and nodes with base plus this one.
      const extra = await createGroup('debian-only', 200);
      await classification.replaceRules(
        extra,
        { rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'Debian' }] },
        ACTOR,
        CTX,
      );
      await classification.assignClass(
        extra,
        { className: 'profile::debian', params: {} },
        ACTOR,
        CTX,
      );

      const target = await createGroup('rollout', 300);
      await classification.replaceRules(
        target,
        { rules: [{ factPath: 'kernel', operator: 'EQUALS', value: 'Linux' }] },
        ACTOR,
        CTX,
      );

      const plan = await planner.plan({
        operation: 'assign-class',
        groupId: target,
        className: 'profile::monitoring',
        params: {},
      });

      expect(plan.shapes.length).toBeGreaterThan(0);
      for (const shape of plan.shapes) {
        // Never empty for an already-classified node: without this the UI has
        // nothing to distinguish one shape from another.
        expect(shape.currentGroups.length).toBeGreaterThan(0);
        expect(shape.currentGroups).toContain('base');
      }

      // The populations differ by exactly the group that matches half of them.
      const withDebian = plan.shapes.filter((s) => s.currentGroups.includes('debian-only'));
      expect(withDebian.length).toBeGreaterThan(0);
      expect(withDebian.length).toBeLessThan(plan.shapes.length);
    });
  });

  describe('shapes', () => {
    /**
     * The design decision that makes this usable. Many nodes, few distinct
     * outcomes — listing every node's diff would be a wall nobody reads.
     */
    it('collapses many nodes into the few distinct outcomes they share', async () => {
      for (let i = 0; i < 10; i += 1) await seedNode(`node${i}.test`, linux(i));

      const base = await createGroup('base', 100);
      await classification.replaceRules(
        base,
        { rules: [{ factPath: 'kernel', operator: 'EQUALS', value: 'Linux' }] },
        ACTOR,
        CTX,
      );
      await classification.assignClass(
        base,
        { className: 'profile::base', params: {} },
        ACTOR,
        CTX,
      );

      const debian = await createGroup('debian', 200);
      await classification.assignClass(
        debian,
        { className: 'profile::apt', params: {} },
        ACTOR,
        CTX,
      );

      const plan = await planner.plan({
        operation: 'replace-rules',
        groupId: debian,
        rules: [{ factPath: 'os.family', operator: 'EQUALS', value: 'Debian' }],
      });

      // Five Debian nodes, all reaching the same outcome from the same start.
      expect(plan.shapes).toHaveLength(1);
      expect(plan.shapes[0]?.count).toBe(5);
      expect(plan.shapes[0]?.exemplar).toMatch(/node\d\.test/);
      expect(plan.counts.unchanged).toBe(5);
    });

    it('names the parameter that changed rather than diffing text', async () => {
      await seedNode('node0.test', linux(0));
      const id = await createGroup('base');
      await classification.replaceRules(
        id,
        { rules: [{ factPath: 'kernel', operator: 'EQUALS', value: 'Linux' }] },
        ACTOR,
        CTX,
      );
      await classification.assignClass(
        id,
        { className: 'profile::base', params: { ntp: ['a'] } },
        ACTOR,
        CTX,
      );

      const plan = await planner.plan({
        operation: 'assign-class',
        groupId: id,
        className: 'profile::base',
        params: { ntp: ['a', 'b'] },
      });

      const change = plan.shapes[0]?.diff.classParameters[0];
      expect(change?.className).toBe('profile::base');
      expect(change?.key).toBe('ntp');
      expect(change?.before).toEqual(['a']);
      expect(change?.after).toEqual(['a', 'b']);
    });
  });

  describe('conflicts', () => {
    /**
     * Only NEW conflicts. An estate accumulates them — overriding a base group
     * is a legitimate pattern — and reporting all of them every time would
     * train an operator to scroll past the section meant to stop them.
     */
    it('reports a conflict the change introduces', async () => {
      await seedNode('node0.test', linux(0));

      const base = await createGroup('base', 100);
      await classification.replaceRules(
        base,
        { rules: [{ factPath: 'kernel', operator: 'EQUALS', value: 'Linux' }] },
        ACTOR,
        CTX,
      );
      await classification.assignClass(
        base,
        { className: 'profile::base', params: { ntp: ['a'] } },
        ACTOR,
        CTX,
      );

      const override = await createGroup('override', 500);
      await classification.replaceRules(
        override,
        { rules: [{ factPath: 'kernel', operator: 'EQUALS', value: 'Linux' }] },
        ACTOR,
        CTX,
      );

      const plan = await planner.plan({
        operation: 'assign-class',
        groupId: override,
        className: 'profile::base',
        params: { ntp: ['z'] },
      });

      expect(plan.conflictsIntroduced.length).toBeGreaterThan(0);
      expect(plan.conflictsIntroduced[0]?.key).toContain('ntp');
    });
  });

  /**
   * The plan and the write must agree about what is inert.
   *
   * A preview that promised a quieter outcome than the write delivers would be
   * worse than no preview: the operator would have looked, seen nothing, and
   * proceeded. Both call the same pure function; these prove they are wired to
   * it.
   */
  describe('warnings about inert configuration', () => {
    const createWithStrategy = async (name: string, strategy: 'PINNED' | 'ANY_RULE') => {
      const result = await classification.create(
        {
          name,
          rank: 100,
          strategy,
          environment: null,
          isEnabled: true,
          parentId: null,
        } as Parameters<ClassificationService['create']>[0],
        ACTOR,
        CTX,
      );
      return result.group.id;
    };

    it('predicts that pinning to a rule-based group decides nothing', async () => {
      await seedNode('node0.test', linux(0));
      const id = await createGroup('rule-based');

      const plan = await planner.plan({
        operation: 'pin',
        groupId: id,
        certnames: ['node0.test'],
      });

      expect(plan.warnings.join(' ')).toContain('strategy is ALL_RULES');
    });

    it('does not warn when the pin lands on a PINNED group', async () => {
      await seedNode('node0.test', linux(0));
      const id = await createWithStrategy('pinned', 'PINNED');

      const plan = await planner.plan({
        operation: 'pin',
        groupId: id,
        certnames: ['node0.test'],
      });

      expect(plan.warnings.join(' ')).not.toContain('decide nothing');
      expect(plan.warnings.join(' ')).not.toContain('no rules matches no nodes');
    });

    it('does not claim a PINNED group with no rules matches nothing', async () => {
      // The rule-emptiness warning previously fired on any replace-rules with an
      // empty list, regardless of strategy — which is exactly backwards for a
      // PINNED group, where having no rules is the normal state.
      await seedNode('node0.test', linux(0));
      const id = await createWithStrategy('pinned-empty', 'PINNED');

      const plan = await planner.plan({ operation: 'replace-rules', groupId: id, rules: [] });

      expect(plan.warnings.join(' ')).not.toContain('no rules matches no nodes');
    });

    it('predicts the same warnings the write then emits', async () => {
      await seedNode('node0.test', linux(0));
      const id = await createGroup('rule-based-pin');

      const plan = await planner.plan({
        operation: 'pin',
        groupId: id,
        certnames: ['node0.test'],
      });
      const applied = await classification.addPins(id, ['node0.test'], ACTOR, CTX);

      const inert = (list: readonly string[]) =>
        list.filter((w) => w.includes('decide nothing') || w.includes('matches no nodes'));

      expect(inert(plan.warnings)).toEqual(inert(applied.warnings));
      expect(inert(plan.warnings)).not.toEqual([]);
    });
  });

  describe('other operations', () => {
    it('plans enabling a disabled group', async () => {
      for (let i = 0; i < 4; i += 1) await seedNode(`node${i}.test`, linux(i));
      const id = await createGroup('dormant');
      await classification.replaceRules(
        id,
        { rules: [{ factPath: 'kernel', operator: 'EQUALS', value: 'Linux' }] },
        ACTOR,
        CTX,
      );
      await classification.assignClass(id, { className: 'profile::base', params: {} }, ACTOR, CTX);
      await classification.update(id, { isEnabled: false } as never, ACTOR, CTX);

      // A disabled group is excluded from the materializer's own group load, so
      // this only works because the planner asks for disabled ones too.
      const plan = await planner.plan({ operation: 'update-group', groupId: id, isEnabled: true });

      expect(plan.counts.added).toBe(4);
    });

    it('plans deleting a group', async () => {
      for (let i = 0; i < 3; i += 1) await seedNode(`node${i}.test`, linux(i));
      const id = await createGroup('doomed');
      await classification.replaceRules(
        id,
        { rules: [{ factPath: 'kernel', operator: 'EQUALS', value: 'Linux' }] },
        ACTOR,
        CTX,
      );
      await classification.assignClass(id, { className: 'profile::base', params: {} }, ACTOR, CTX);

      const plan = await planner.plan({ operation: 'delete-group', groupId: id });

      expect(plan.counts.removed).toBe(3);
    });

    it('plans a pin', async () => {
      await seedNode('pinned.test', linux(0));
      await seedNode('other.test', linux(1));
      const id = await createGroup('canary');
      await classification.assignClass(
        id,
        { className: 'profile::canary', params: {} },
        ACTOR,
        CTX,
      );

      const plan = await planner.plan({
        operation: 'pin',
        groupId: id,
        certnames: ['pinned.test'],
      });

      // PINNED membership requires the strategy; with ALL_RULES and no rules the
      // group still matches nothing, so this plan correctly shows no change.
      expect(plan.counts.total).toBe(0);
    });

    it('refuses to plan against a group that does not exist', async () => {
      await expect(
        planner.plan({
          operation: 'delete-group',
          groupId: '11111111-1111-1111-1111-111111111111',
        }),
      ).rejects.toThrow(/No node group/);
    });
  });

  describe('bounding', () => {
    /**
     * A plan that times out is worse than no plan; a plan that silently sampled
     * is worse still. When the bound bites it must say so.
     */
    it('says so when it evaluated less than the estate', async () => {
      for (let i = 0; i < 12; i += 1)
        await seedNode(`node${String(i).padStart(2, '0')}.test`, linux(i));
      const id = await createGroup('base');

      const small = new ClassificationPlanner(prisma, materializer, {
        maxNodes: 5,
        maxCertnamesPerShape: 50,
      });
      const plan = await small.plan({
        operation: 'replace-rules',
        groupId: id,
        rules: [{ factPath: 'kernel', operator: 'EQUALS', value: 'Linux' }],
      });

      expect(plan.truncated).toBe(true);
      expect(plan.evaluated).toBe(5);
      expect(plan.estateSize).toBe(12);
      expect(plan.warnings.join(' ')).toContain('may affect nodes not shown');
    });

    it('is not truncated when it saw the whole estate', async () => {
      for (let i = 0; i < 3; i += 1) await seedNode(`node${i}.test`, linux(i));
      const id = await createGroup('base');

      const plan = await planner.plan({
        operation: 'replace-rules',
        groupId: id,
        rules: [{ factPath: 'kernel', operator: 'EQUALS', value: 'Linux' }],
      });

      expect(plan.truncated).toBe(false);
      expect(plan.warnings).toEqual([]);
    });
  });

  describe('a plan writes nothing', () => {
    /** The only property that makes a preview safe to offer at all. */
    it('leaves the classification, the queue and the ENC records untouched', async () => {
      for (let i = 0; i < 4; i += 1) await seedNode(`node${i}.test`, linux(i));
      const id = await createGroup('base');
      await prisma.encMaterializationJob.deleteMany();

      const before = {
        groups: await prisma.nodeGroup.count(),
        rules: await prisma.nodeGroupRule.count(),
        classes: await prisma.nodeGroupClass.count(),
        jobs: await prisma.encMaterializationJob.count(),
        materializations: await prisma.encMaterialization.count(),
        audit: await prisma.auditLog.count(),
      };

      await planner.plan({
        operation: 'replace-rules',
        groupId: id,
        rules: [{ factPath: 'kernel', operator: 'EQUALS', value: 'Linux' }],
      });
      await planner.plan({ operation: 'delete-group', groupId: id });

      expect({
        groups: await prisma.nodeGroup.count(),
        rules: await prisma.nodeGroupRule.count(),
        classes: await prisma.nodeGroupClass.count(),
        jobs: await prisma.encMaterializationJob.count(),
        materializations: await prisma.encMaterialization.count(),
        audit: await prisma.auditLog.count(),
      }).toEqual(before);
    });
  });
});

/**
 * Deliberately absent: these tests assert classification, not file contents,
 * so readNode() returns null and the node reads as falling back to default.yaml.
 */
const ENC_DIR_FOR_TESTS = '/nonexistent/enc-output-for-tests';
