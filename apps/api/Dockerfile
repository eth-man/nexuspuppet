# NexusPuppet API. Built from the monorepo root:
#   docker build -f apps/api/Dockerfile .
FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/api/package.json apps/api/
# The enterprise layer is absent here by design (ADR-0002). For a private
# build, run `npm run enterprise:fetch` before docker build and add
# `COPY packages/enterprise packages/enterprise` above this line.
RUN npm ci --workspace @nexuspuppet/contracts --workspace @nexuspuppet/api --include-workspace-root

FROM deps AS build
# Prisma 7 resolves DATABASE_URL through prisma.config.ts even for `generate`,
# which never contacts a database. A dummy value is correct at build time; the
# real connection string is injected at runtime.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/unused
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/api apps/api
RUN npm run build --workspace @nexuspuppet/contracts \
 && npm run db:generate --workspace @nexuspuppet/api \
 && npm run build --workspace @nexuspuppet/api

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN addgroup -S app && adduser -S app -G app
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /repo/packages/contracts/package.json ./packages/contracts/
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/prisma ./prisma
COPY --from=build /repo/apps/api/package.json ./
# The ENC volume is mounted here read-write; it is the only path this service writes.
RUN mkdir -p /srv/nexuspuppet/enc && chown -R app:app /srv/nexuspuppet
USER app
EXPOSE 3001
CMD ["node", "dist/main.js"]
