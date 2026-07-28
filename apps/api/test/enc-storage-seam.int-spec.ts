import type { IEncFileWriter } from '@nexuspuppet/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { MaterializerService } from '../src/materialization/materializer.service';
import { MaterializationService } from '../src/materialization/materialization.service';
import { ReconcilerService } from '../src/materialization/reconciler.service';

/**
 * The ENC storage seam (ADR-0002).
 *
 * The token and the interface existed before this suite did, and were
 * decorative: every consumer injected the concrete PosixEncStorage, so the
 * enterprise layer could replace ENC_FILE_WRITER and nothing that writes ENC
 * files would have noticed.
 *
 * These tests substitute an in-memory implementation and assert it is actually
 * used. They would all have failed against the previous wiring, which is the
 * point of writing them.
 */

const DATABASE_URL =
  process.env['TEST_DATABASE_URL'] ??
  'postgresql://nexuspuppet:nexuspuppet@localhost:5432/nexuspuppet_test?schema=public';

jest.setTimeout(120_000);

/**
 * Storage with no filesystem anywhere in it.
 *
 * If a consumer still reached for PosixEncStorage, these maps would stay empty
 * and files would appear on disk instead — so the assertions below are about
 * WHICH implementation ran, not merely that something worked.
 */
class InMemoryEncStorage implements IEncFileWriter {
  nodes = new Map<string, string>();
  hashes = new Map<string, string>();
  defaultDocument: string | null = null;
  layoutEnsured = false;
  writable = true;

  async ensureLayout(): Promise<void> {
    this.layoutEnsured = true;
  }

  async writeNode(certname: string, yaml: string, contentHash: string): Promise<boolean> {
    // Same contract as the POSIX one: unchanged content is not a write.
    if (this.hashes.get(certname) === contentHash) return false;
    this.nodes.set(certname, yaml);
    this.hashes.set(certname, contentHash);
    return true;
  }

  async removeNode(certname: string): Promise<void> {
    // Validation is the implementation's job — what is dangerous depends on
    // the medium, and this one has no paths to traverse.
    if (certname.includes('/')) throw new Error(`unsafe identifier: ${certname}`);
    this.nodes.delete(certname);
    this.hashes.delete(certname);
  }

  async writeDefault(yaml: string): Promise<void> {
    this.defaultDocument = yaml;
  }

  async listMaterializedCertnames(): Promise<string[]> {
    return [...this.nodes.keys()];
  }

  async isWritable(): Promise<boolean> {
    return this.writable;
  }
}

describe('ENC storage seam (integration)', () => {
  let prisma: PrismaService;
  let storage: InMemoryEncStorage;
  let materializer: MaterializerService;
  let enqueue: MaterializationService;

  beforeAll(async () => {
    prisma = new PrismaService(DATABASE_URL);
    await prisma.onModuleInit();
  });

  afterAll(async () => {
    await prisma.onModuleDestroy();
  });

  beforeEach(async () => {
    storage = new InMemoryEncStorage();
    materializer = new MaterializerService(prisma, storage, 5, 'production');
    enqueue = new MaterializationService();

    await prisma.encMaterializationJob.deleteMany();
    await prisma.encMaterialization.deleteMany();
    await prisma.managedNode.deleteMany();
  });

  const seed = (certname: string) =>
    prisma.managedNode.create({ data: { certname, facts: {}, environment: 'production' } });

  describe('substitution', () => {
    it('materializes through the injected implementation, not the filesystem', async () => {
      await seed('web01.example.com');

      await materializer.materializeNode('web01.example.com');

      expect(storage.nodes.has('web01.example.com')).toBe(true);
      expect(storage.nodes.get('web01.example.com')).toContain('Managed by NexusPuppet');
    });

    it('writes the default document through it', async () => {
      await materializer.ensureDefaultDocument();

      expect(storage.layoutEnsured).toBe(true);
      expect(storage.defaultDocument).toContain('environment: production');
    });

    it('drains the outbox through it', async () => {
      await seed('web01.example.com');
      await prisma.$transaction((tx) => enqueue.enqueueNode(tx, 'web01.example.com', 'test'));

      const result = await materializer.drain();

      expect(result.filesChanged).toBe(1);
      expect(storage.nodes.has('web01.example.com')).toBe(true);
    });

    it('deletes through it', async () => {
      await seed('gone.example.com');
      await materializer.materializeNode('gone.example.com');
      await prisma.managedNode.delete({ where: { certname: 'gone.example.com' } });
      await prisma.$transaction((tx) =>
        enqueue.enqueueNodeDeletion(tx, 'gone.example.com', 'node-purged'),
      );

      await materializer.drain();

      expect(storage.nodes.has('gone.example.com')).toBe(false);
    });

    it('reconciles orphans through it', async () => {
      // Present in storage, absent from the projection: an orphan.
      await storage.writeNode('orphan.example.com', 'classes: {}\n', 'hash');

      const reconciler = new ReconcilerService(prisma, materializer, storage, 0, 0);
      const removed = await reconciler.reconcile('test');

      expect(removed).toBe(1);
      expect(storage.nodes.has('orphan.example.com')).toBe(false);
    });
  });

  describe('the contract the interface implies', () => {
    /**
     * Content-hash gating is what keeps a no-op from becoming estate-wide file
     * churn. An implementation that always reported a write would defeat it,
     * so it belongs to the contract rather than to one implementation.
     */
    it('reports no change when content is identical', async () => {
      await seed('web01.example.com');

      const first = await materializer.materializeNode('web01.example.com');
      const second = await materializer.materializeNode('web01.example.com');

      expect(first.changed).toBe(true);
      expect(second.changed).toBe(false);
    });

    it('leaves the revision alone when nothing changed', async () => {
      await seed('web01.example.com');
      await materializer.materializeNode('web01.example.com');
      await materializer.materializeNode('web01.example.com');

      const row = await prisma.encMaterialization.findUniqueOrThrow({
        where: { certname: 'web01.example.com' },
      });
      // Bumping on every pass would make the revision meaningless as a change
      // signal, whatever the storage medium.
      expect(row.revision).toBe(1);
    });

    /**
     * The certname originates in a certificate, so it is untrusted. Rejecting
     * it is the implementation's responsibility because what is dangerous
     * depends on the medium — nothing above this interface validates for it.
     */
    it('lets the implementation reject an unsafe identifier', async () => {
      await expect(storage.removeNode('../../etc/passwd')).rejects.toThrow(/unsafe identifier/);
    });
  });
});

/**
 * The wiring, as opposed to the constructors.
 *
 * The tests above prove the services ACCEPT any IEncFileWriter, because they
 * construct them directly. They would still pass if the module injected the
 * concrete class — which is exactly the defect this task fixed. This inspects
 * the module's own provider graph instead.
 */
describe('ENC storage wiring', () => {
  /**
   * AppModule.bootstrap() validates the whole environment before it builds
   * anything, so these need one that parses. Supplied explicitly rather than
   * inherited: relying on the developer's shell having sourced .env is how a
   * test passes locally and fails in CI, which is exactly what happened here.
   *
   * Values are placeholders — nothing is connected to, because only the
   * provider graph is inspected.
   */
  const REQUIRED_ENV: Record<string, string> = {
    JWT_SECRET: 'x'.repeat(48),
    DATABASE_URL,
    PUPPETDB_URL: 'https://puppetdb.invalid:8081',
    PUPPETDB_CERT_PATH: '/dev/null',
    PUPPETDB_KEY_PATH: '/dev/null',
    PUPPETDB_CA_PATH: '/dev/null',
    ENC_OUTPUT_DIR: '/tmp/nexuspuppet-wiring-test',
  };

  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const [key, value] of Object.entries(REQUIRED_ENV)) {
      saved[key] = process.env[key];
      process.env[key] = process.env[key] ?? value;
    }
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('registers ENC storage only under the contracts token', async () => {
    const { AppModule } = await import('../src/app.module');
    const { ENC_FILE_WRITER } = await import('@nexuspuppet/contracts');
    const { PosixEncStorage } = await import('../src/materialization/posix-enc-storage');

    const module = await AppModule.bootstrap();
    // Through unknown: a Provider union does not structurally overlap a plain
    // record, and this only reads the `provide`/`inject` keys that factory
    // providers carry.
    const providers = (module.providers ?? []) as unknown as Array<Record<string, unknown>>;

    const tokens = providers.map((p) => p['provide']);
    expect(tokens).toContain(ENC_FILE_WRITER);

    // The concrete class must NOT be obtainable from the container. If it is
    // not registered, nothing can inject it, and the token is the only route
    // to storage — which is what makes an enterprise override take effect.
    expect(tokens).not.toContain(PosixEncStorage);
  });

  it('has every ENC consumer inject the token rather than the class', async () => {
    const { AppModule } = await import('../src/app.module');
    const { ENC_FILE_WRITER } = await import('@nexuspuppet/contracts');
    const { PosixEncStorage } = await import('../src/materialization/posix-enc-storage');
    const { MaterializerService } = await import('../src/materialization/materializer.service');
    const { ReconcilerService } = await import('../src/materialization/reconciler.service');

    const module = await AppModule.bootstrap();
    // Through unknown: a Provider union does not structurally overlap a plain
    // record, and this only reads the `provide`/`inject` keys that factory
    // providers carry.
    const providers = (module.providers ?? []) as unknown as Array<Record<string, unknown>>;

    for (const service of [MaterializerService, ReconcilerService]) {
      const provider = providers.find((p) => p['provide'] === service);
      expect(provider).toBeDefined();

      const injected = (provider?.['inject'] ?? []) as unknown[];
      expect(injected).toContain(ENC_FILE_WRITER);
      expect(injected).not.toContain(PosixEncStorage);
    }
  });
});
