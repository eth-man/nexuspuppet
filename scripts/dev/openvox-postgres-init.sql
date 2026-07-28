-- Extensions openvoxdb requires before it will start.
--
-- Discovered rather than anticipated: openvoxdb's first boot against a stock
-- postgres:17-alpine dies during migration with
--
--     PuppetDB requires the PostgreSQL `pg_trgm` extension.
--
-- and then shuts down cleanly, so the container merely looks unhealthy and the
-- reason is buried thirty lines above a Clojure stack trace.
--
-- CREATE EXTENSION needs superuser, which openvoxdb's own database role is not,
-- so this cannot be done by the application at runtime. It runs here from
-- /docker-entrypoint-initdb.d, which postgres executes as the superuser on
-- first initialisation only.
--
-- This is a real deployment requirement, not a fixture detail: an operator
-- pointing openvoxdb at an existing PostgreSQL has to do exactly this, and
-- DEPLOYMENT.md should say so.

-- Trigram indexes, used for PuppetDB's substring matching.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Not required by every version, and cheap to have present. Older PuppetDB
-- schemas use it for hashing; omitting it fails the same opaque way.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
