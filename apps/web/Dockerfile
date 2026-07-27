# NexusPuppet web console. Built from the monorepo root:
#   docker build -f apps/web/Dockerfile .
#
# This image holds NO database credentials and NO PuppetDB certificate
# (C4 L2, ADR-0008). It reaches the API over the internal network only.
FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @nexuspuppet/contracts --workspace @nexuspuppet/web --include-workspace-root

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY apps/web apps/web
RUN npm run build --workspace @nexuspuppet/contracts \
 && npm run build --workspace @nexuspuppet/web

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000
RUN addgroup -S app && adduser -S app -G app
COPY --from=build --chown=app:app /repo/apps/web/.next/standalone ./
COPY --from=build --chown=app:app /repo/apps/web/.next/static ./apps/web/.next/static
USER app
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
