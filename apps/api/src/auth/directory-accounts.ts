import { Logger } from '@nestjs/common';
import type {
  DirectoryAccounts,
  DirectoryUser,
  FirstSignInAccount,
  IAuditSink,
} from '@nexuspuppet/contracts';
import type { PrismaService } from '../prisma/prisma.service';
import { normalizeEmail } from './local-auth.provider';

/** How an account came to be created or linked, in its audit row. */
export const DIRECTORY_SIGN_IN_VIA = 'directory-sign-in';

/**
 * The audit actor for what a directory sign-in writes (ADR-0031).
 *
 * No user did this: the person had no account — or no link — until this
 * write, and the administrator who configured the directory did so earlier,
 * in a row of its own. A marker no address can be — `directory:ldap` — in the
 * same shape as the CLI's `cli:deploy.sh@host`, with `actorUserId` null.
 */
export function directoryActor(source: string): string {
  return `directory:${source}`;
}

/** What the request looked like, for the audit row. */
export interface SignInContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

/**
 * What a directory sign-in may write to accounts (ADR-0031): link an account
 * to its directory entry, or create one. Bound to one source and one request
 * by `forSignIn`, which is what the resolver hands the provider.
 *
 * EVERY WRITE LANDS WITH ITS AUDIT ROW IN ONE TRANSACTION, as for every other
 * write that changes users (UsersService). A link decides which person a
 * directory password opens the account of, and a creation decides that a
 * person has an account at all; neither may exist without a record of how.
 *
 * `role` and `roleId` are written together, as UsersService.create and
 * recordLogin write them: the console shows the name while every guard counts
 * by the key, and the two drifting apart is a defect this codebase has
 * already had once.
 */
export class DirectoryAccountWriter {
  private readonly logger = new Logger(DirectoryAccountWriter.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: IAuditSink,
  ) {}

  /** The writer one directory sign-in gets: one source, one request. */
  forSignIn(
    source: string,
    identifierHasAccount: boolean,
    context: SignInContext = {},
  ): DirectoryAccounts {
    // A local account has a password held here, set by an administrator.
    // Nothing a directory says may create one or link one (ADR-0015 §1).
    if (source === 'local') {
      throw new Error('A directory sign-in never writes a local account.');
    }
    return {
      identifierHasAccount,
      link: (userId, directoryId) => this.link(source, userId, directoryId, context),
      create: (account) => this.create(source, account, context),
    };
  }

  /**
   * Link an account of `source` that has no link yet to a directory entry.
   *
   * The UPDATE is conditional — this source, no link yet — so it cannot
   * re-link an account somebody linked a moment ago, nor touch one that was
   * moved to another source meanwhile. When it matches nothing, what is there
   * now decides: already linked to this entry (a concurrent sign-in of the
   * same person) is fine; anything else is refused.
   */
  async link(
    source: string,
    userId: string,
    directoryId: string,
    context: SignInContext = {},
  ): Promise<DirectoryUser | null> {
    let linked: UserRow | null;
    try {
      linked = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.user.updateMany({
          where: { id: userId, authSource: source, directoryId: null },
          data: { directoryId },
        });
        if (updated.count === 0) return null;

        const user = await tx.user.findUnique({ where: { id: userId } });
        if (user === null) return null;

        await this.audit.record(
          {
            actorUserId: null,
            actorEmail: directoryActor(source),
            action: 'user.directory.link',
            entityType: 'User',
            entityId: user.id,
            before: { email: user.email, directoryId: null },
            after: {
              email: user.email,
              authSource: user.authSource,
              directoryId,
              via: DIRECTORY_SIGN_IN_VIA,
            },
            ipAddress: context.ipAddress ?? null,
            userAgent: context.userAgent ?? null,
          },
          tx,
        );
        return user;
      });
    } catch (error) {
      // The entry was linked to ANOTHER account in the meantime: that one is
      // the person's account now.
      if (isUniqueViolation(error)) return this.linkedTo(source, directoryId);
      this.logger.error(
        `Could not link an account to directory entry ${directoryId}: ${describe(error)}. ` +
          'Nothing was changed.',
      );
      return null;
    }

    if (linked !== null) {
      this.logger.log(
        `Linked the account ${linked.email} to directory entry ${directoryId} at sign-in ` +
          `through ${source} (audited as user.directory.link by ${directoryActor(source)}).`,
      );
      return toDirectoryUser(linked);
    }

    const now = await this.prisma.user.findUnique({ where: { id: userId } });
    if (now !== null && now.authSource === source && now.directoryId === directoryId) {
      return toDirectoryUser(now);
    }
    this.logger.warn(
      `Sign-in refused: the account ${now?.email ?? userId} could not be linked to directory ` +
        `entry ${directoryId} — it was linked elsewhere, moved off ${source}, or deleted during ` +
        'the sign-in. Nothing was changed.',
    );
    return null;
  }

  /**
   * Create the account of somebody a directory has just authenticated and
   * authorised, linked to their entry from the start.
   *
   * - Created, with its audit row: the account.
   * - A concurrent first sign-in of the same person won (the unique email or
   *   directory id said so): the account linked to this entry.
   * - The email belongs to an account that is NOT linked to this entry — a
   *   local one, say: null. This sign-in must never open it; that would be
   *   the shadowing ADR-0015 §1 exists to prevent.
   * - The mapped role is not one this deployment defines, or the write fails:
   *   null, said in the log, nothing written.
   */
  async create(
    source: string,
    account: FirstSignInAccount,
    context: SignInContext = {},
  ): Promise<DirectoryUser | null> {
    if (source === 'local') {
      throw new Error('A local account is never created at sign-in.');
    }

    const email = normalizeEmail(account.email);

    let created: UserRow;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const role = await tx.role.findUnique({
          where: { name: account.role },
          select: { id: true },
        });
        if (role === null) throw new UndefinedRole(account.role);

        const user = await tx.user.create({
          data: {
            email,
            displayName: account.displayName,
            role: account.role,
            roleId: role.id,
            authSource: source,
            directoryId: account.directoryId,
            // The directory holds the credential. A hash here would be a way in
            // that outlives whatever the directory revokes.
            passwordHash: null,
            isActive: true,
          },
        });

        await this.audit.record(
          {
            actorUserId: null,
            actorEmail: directoryActor(source),
            action: 'user.create',
            entityType: 'User',
            entityId: user.id,
            before: null,
            after: {
              email: user.email,
              role: user.role,
              authSource: user.authSource,
              directoryId: account.directoryId,
              via: DIRECTORY_SIGN_IN_VIA,
            },
            ipAddress: context.ipAddress ?? null,
            userAgent: context.userAgent ?? null,
          },
          tx,
        );

        return user;
      });
    } catch (error) {
      if (error instanceof UndefinedRole) {
        this.logger.warn(
          `Sign-in refused for ${email}: authenticated through ${source}, and their group maps ` +
            `to the role "${error.role}", which this deployment does not define — no account ` +
            'created. Point the mapping at a role that exists, or create the role.',
        );
        return null;
      }
      if (isUniqueViolation(error)) {
        const winner = await this.linkedTo(source, account.directoryId);
        if (winner !== null) return winner;

        const holder = await this.prisma.user.findUnique({ where: { email } });
        this.logger.warn(
          `Sign-in refused: the directory entry ${account.directoryId} would get an account for ` +
            `${email}, but an account with that email already exists (authSource ` +
            `"${holder?.authSource ?? 'unknown'}") and is not linked to this entry. Nothing was ` +
            'created. Move that account to ldap to let it be linked, or delete it.',
        );
        return null;
      }

      this.logger.error(
        `Could not create an account for ${email} at first sign-in through ${source}: ` +
          `${describe(error)}. Nothing was created.`,
      );
      return null;
    }

    this.logger.log(
      `Created an account for ${email} at first sign-in through ${source}, with role ` +
        `${created.role}, linked to directory entry ${account.directoryId} (audited as ` +
        `user.create by ${directoryActor(source)}).`,
    );
    return toDirectoryUser(created);
  }

  /** The account of `source` linked to this entry, if any. */
  private async linkedTo(source: string, directoryId: string): Promise<DirectoryUser | null> {
    const linked = await this.prisma.user.findUnique({ where: { directoryId } });
    if (linked === null || linked.authSource !== source) return null;
    this.logger.log(
      `The account ${linked.email} was linked to directory entry ${directoryId} by a ` +
        'concurrent sign-in; this one uses it.',
    );
    return toDirectoryUser(linked);
  }
}

class UndefinedRole extends Error {
  constructor(readonly role: string) {
    super(`No role named "${role}" exists.`);
  }
}

/** Postgres refused the row because a unique value is taken (Prisma P2002). */
export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'P2002'
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface UserRow {
  id: string;
  email: string;
  displayName: string;
  role: string;
  authSource: string;
  isActive: boolean;
  directoryId: string | null;
}

function toDirectoryUser(user: UserRow): DirectoryUser {
  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role as DirectoryUser['role'],
    authSource: user.authSource,
    isActive: user.isActive,
    directoryId: user.directoryId,
  };
}
