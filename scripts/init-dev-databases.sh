#!/bin/sh
# Runs once on first container start, alongside the main database.
#
#   nexuspuppet_test    integration tests. They TRUNCATE tables, so they must
#                       never point at a database anyone is using.
#   nexuspuppet_shadow  `prisma migrate diff --from-migrations`, which Prisma
#                       may drop and recreate.
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-SQL
    CREATE DATABASE nexuspuppet_test OWNER $POSTGRES_USER;
    CREATE DATABASE nexuspuppet_shadow OWNER $POSTGRES_USER;
SQL
