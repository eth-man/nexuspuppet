# NexusPuppet API. Built from the monorepo root:
#   docker build -f apps/api/Dockerfile .
# EDITION selects what goes in the image: `core` (default) or `enterprise`.
#
# Declared before the first FROM so it can be interpolated into stage NAMES
# below — which is how a Dockerfile does a conditional at all. It replaces four
# hand edits that had to be made together; making three of them produced an
# image that built, started, and silently ran core.
#
#   docker compose build api                      # core
#   EDITION=enterprise docker compose build api   # enterprise
#
# The enterprise layer must already be fetched and `npm install` run on the
# host: `npm ci` needs the lockfile to carry @nexuspuppet/enterprise, and this
# argument cannot conjure that.
ARG EDITION=core

FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/tls-grant/package.json packages/tls-grant/
COPY apps/api/package.json apps/api/
# The enterprise layer is absent here by design (ADR-0002).
#
# A PRIVATE BUILD NEEDS FOUR EDITS, NOT ONE. This comment used to name only the
# COPY below, and that is not enough: the build succeeds, the API starts, and
# the loader reports "No enterprise layer installed — running core edition".
# It fails SILENTLY INTO CORE, which is the worst available outcome — an
# operator who paid for SSO gets a working console with local auth and no error
# anywhere. Verified on a clean VM: `node_modules/@nexuspuppet/` in the runtime
# image held only `api` and `contracts`.
#
#   1. COPY packages/enterprise packages/enterprise      (below, before npm ci)
#   2. add --workspace @nexuspuppet/enterprise to the npm ci line, or the
#      workspace is never linked into node_modules
#   3. in the build stage, `npm run build --workspace @nexuspuppet/enterprise`
#      after contracts and before api — package.json main is ./dist/index.js
#   4. in the runtime stage, copy packages/enterprise/dist and its package.json,
#      or the node_modules symlink copied from build points at nothing
#
# Run `npm run enterprise:fetch` AND `npm install` on the host first. `npm ci`
# fails outright without the second — the committed lock file has no entry for
# @nexuspuppet/enterprise:
#   npm error Missing: @nexuspuppet/enterprise@0.1.0 from lock file
#
# For LDAP, also `npm install ldapts --workspace @nexuspuppet/enterprise`. It is
# an optional peer dependency so an OIDC-only deployment does not pull an LDAP
# client; without it the layer loads and every login fails at runtime.
#
# RE-RUN THAT ON EVERY REBUILD, not only the first install. It does not stick
# the way a normal dependency does, and the reason is worth knowing:
#
#   - `npm install ldapts --workspace @nexuspuppet/enterprise` does NOT add it to
#     that package's `dependencies`. ldapts is already declared as an optional
#     PEER dependency, so npm treats the install as satisfying the peer and
#     writes no dependency entry.
#   - It survives in package-lock.json alone. Replace packages/enterprise — a
#     fresh clone, a new tag, re-running enterprise:fetch — and the next
#     `npm install` reconciles the tree, finds nothing that requires an optional
#     peer, and removes it.
#
# So a rebuild that worked yesterday produces an image where the enterprise
# layer loads, reports directory.ldap, and fails every LDAP login at runtime.
# Found doing exactly that: rebuilding a working enterprise deployment from a
# clean checkout of main.
#
# The failure is at least loud and self-explaining — the provider says "The
# `ldapts` package is not installed" and names the fix — but it happens after
# deploy rather than during build, which is the expensive place to find it.
# --- edition selection: manifests -------------------------------------------
FROM deps AS manifests-core
# Nothing extra. Core is the absence of the layer, not a flag it reads.

FROM deps AS manifests-enterprise
# The whole package, not just its manifest: every later stage descends from
# this one, so the source arrives with the decision instead of needing a
# second conditional that could disagree with it.
COPY packages/enterprise packages/enterprise

FROM manifests-${EDITION} AS manifests

# --- edition selection: install ---------------------------------------------
FROM manifests AS install-core
RUN npm ci --workspace @nexuspuppet/contracts --workspace @nexuspuppet/tls-grant --workspace @nexuspuppet/api --include-workspace-root

FROM manifests AS install-enterprise
# `ldapts` is an optional PEER dependency, so npm writes it to the lockfile and
# to no package's `dependencies`. Installing it here means the image cannot be
# built without it — which is the failure this used to have at runtime, on
# every LDAP login, long after the build went green.
RUN npm ci --workspace @nexuspuppet/contracts --workspace @nexuspuppet/tls-grant --workspace @nexuspuppet/enterprise --workspace @nexuspuppet/api --include-workspace-root \
 && npm install ldapts --workspace @nexuspuppet/enterprise

FROM install-${EDITION} AS installed

FROM installed AS build
# Prisma 7 resolves DATABASE_URL through prisma.config.ts even for `generate`,
# which never contacts a database. A dummy value is correct at build time; the
# real connection string is injected at runtime.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/unused
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/tls-grant packages/tls-grant
COPY apps/api apps/api

# Built before the api, and only when present. A shell test rather than another
# stage: the directory's existence already encodes the edition.
RUN if [ -d packages/enterprise ]; then npm run build --workspace @nexuspuppet/enterprise; fi

RUN npm run build --workspace @nexuspuppet/contracts \
 && npm run build --workspace @nexuspuppet/tls-grant \
 && npm run db:generate --workspace @nexuspuppet/api \
 && npm run build --workspace @nexuspuppet/api

# The version the console reports. Read from the manifest at BUILD time,
# where it is present, and carried into the image as an environment
# variable so nothing has to find a JSON file at runtime.
FROM node:22-alpine AS assembled
WORKDIR /app
ENV NODE_ENV=production
# uid 100 / gid 101 PINNED, not inherited. DEPLOYMENT.md §3 tells operators to
# chown the certificate directory to uid 100, and until now that number was
# whatever Alpine's next system uid happened to be. A base-image bump that
# shifted it would make every documented install produce an unreadable key, with
# the only symptom being "PuppetDB unreachable".
RUN addgroup -S -g 101 app && adduser -S -u 100 -G app app
# The FULL node_modules, devDependencies included — deliberately, for now.
#
# `prisma` (the CLI) is a devDependency, and DEPLOYMENT.md §5 has operators run
# `docker compose run --rm api npx prisma migrate deploy` against this image. It
# works only because nothing has been pruned. Anyone slimming this image with
# `npm ci --omit=dev` must first move `prisma` into dependencies, or the
# documented migration step stops working in a way no test here would notice.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /repo/packages/contracts/package.json ./packages/contracts/
COPY --from=build /repo/packages/tls-grant/dist ./packages/tls-grant/dist
COPY --from=build /repo/packages/tls-grant/package.json ./packages/tls-grant/
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/prisma ./prisma
# prisma.config.ts, not just prisma/. Prisma 7 keeps the connection string out
# of schema.prisma and resolves it through this file, so without it
# `prisma migrate deploy` fails with "The datasource.url property is required in
# your Prisma config file" — which made the documented migration step impossible
# with the shipped image. The CLI loads the TypeScript config directly; nothing
# needs transpiling.
COPY --from=build /repo/apps/api/prisma.config.ts ./
COPY --from=build /repo/apps/api/package.json ./

# --- edition selection: the built layer -------------------------------------
FROM assembled AS runtime-core
# Nothing. EnterpriseLoader finds no package and logs "running core edition".

FROM assembled AS runtime-enterprise
# Both, or neither works: node_modules holds a symlink into this path, and a
# dist without its package.json is a link pointing at nothing.
COPY --from=build /repo/packages/enterprise/dist ./packages/enterprise/dist
COPY --from=build /repo/packages/enterprise/package.json ./packages/enterprise/

FROM runtime-${EDITION} AS final
# The commissioning check, so it can run FROM the container:
#   docker compose run --rm api node scripts/test-puppetdb.mjs
# DEPLOYMENT.md recommends this check, but §0 asks only for Docker — on a
# Docker-only host there is no Node to run it with. In here there is, and it
# tests from the uid, network position and certificate mounts the real client
# uses rather than approximating them from the host.
#
# From the BUILD CONTEXT, not --from=build. The build stage only ever receives
# tsconfig.base.json, packages/contracts and apps/api, so /repo/scripts does not
# exist in it and copying from there fails the whole image build. This file is
# plain ESM that runs as-is; there is nothing for a build stage to do to it.
COPY scripts/test-puppetdb.mjs ./scripts/
# The ENC volume is mounted here read-write; it is the only path this service writes.
RUN mkdir -p /srv/nexuspuppet/enc && chown -R app:app /srv/nexuspuppet
USER app
EXPOSE 3001
CMD ["node", "dist/main.js"]
