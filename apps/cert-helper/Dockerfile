# NexusPuppet console TLS installer. Built from the monorepo root:
#   docker build -f apps/cert-helper/Dockerfile .
#
# THIS IS THE ONLY IMAGE IN THE STACK THAT WRITES PRIVATE KEY MATERIAL
# (ADR-0017). It is deliberately small and deliberately dull: no framework, no
# database client, no HTTP client beyond node's own. Everything added here
# widens the surface of the one component that can replace the console's
# identity, so additions want a reason.
FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/tls-grant/package.json packages/tls-grant/
COPY apps/cert-helper/package.json apps/cert-helper/
RUN npm ci --workspace @nexuspuppet/contracts --workspace @nexuspuppet/tls-grant --workspace @nexuspuppet/cert-helper \
    --include-workspace-root

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/contracts packages/contracts
COPY packages/tls-grant packages/tls-grant
COPY apps/cert-helper apps/cert-helper
RUN npm run build --workspace @nexuspuppet/contracts \
 && npm run build --workspace @nexuspuppet/tls-grant \
 && npm run build --workspace @nexuspuppet/cert-helper

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# uid 100 / gid 101 PINNED, matching apps/api. The TLS directory is chowned to
# uid 100 by the install guide, and this process must be able to write it — a
# base-image bump that shifted the number would leave certificate installation
# failing with a permission error nobody had changed anything to cause.
# openssl, for the self-signed fallback on an empty first run (ADR-0013).
#
# Node has no certificate-signing API. The alternative was a JavaScript X.509
# library inside the one component whose whole job is handling private keys; a
# binary from the distribution, invoked through execFile with a fixed argument
# list and never a shell, is the smaller thing to trust.
RUN apk add --no-cache openssl

RUN addgroup -S -g 101 app && adduser -S -u 100 -G app app

# node_modules comes from the build stage. Worth noting what is NOT here: this
# package declares no dependencies at all, so the tree carried across is the
# workspace's dev tooling, contracts and tls-grant. The helper's own code
# imports only node: builtins and those two workspaces.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/packages/contracts/dist ./packages/contracts/dist
COPY --from=build /repo/packages/contracts/package.json ./packages/contracts/
COPY --from=build /repo/packages/tls-grant/dist ./packages/tls-grant/dist
COPY --from=build /repo/packages/tls-grant/package.json ./packages/tls-grant/
COPY --from=build /repo/apps/cert-helper/dist ./dist
COPY --from=build /repo/apps/cert-helper/package.json ./

USER app
EXPOSE 8099
# No HEALTHCHECK hitting an endpoint: every route here either changes the
# console's certificate or reports on one, and none of them should be reachable
# by a probe loop. Compose treats the process exiting as the failure signal,
# which for a component this small is the signal that matters.
CMD ["node", "dist/main.js"]
