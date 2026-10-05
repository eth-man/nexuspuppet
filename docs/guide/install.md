# Install & upgrade

This is the short path. Every option, and the reasoning behind each step, is in [DEPLOYMENT.md](../../DEPLOYMENT.md).

## What you need

- A Linux host with Docker Engine 24 or later and the Compose plugin. 2 vCPU and 4 GB of RAM is plenty for a few thousand nodes.
- A PuppetDB (or OpenVoxDB) reachable from that host on port 8081.
- A **client certificate** for NexusPuppet, issued by your Puppet CA, and its certname added to PuppetDB's allowlist. See [Issuing a client certificate](../../DEPLOYMENT.md#3-puppetdb-certificates).

## Install

```bash
git clone https://github.com/eth-man/nexuspuppet.git /opt/nexuspuppet
cd /opt/nexuspuppet
git checkout v1.11.0                         # use the latest release tag

./scripts/deploy.sh --check --puppetdb https://puppetdb.example.com:8081
./scripts/deploy.sh --puppetdb https://puppetdb.example.com:8081
```

`--check` looks before anything is built: it confirms the certificate is present, readable and valid, and that PuppetDB answers it. Each problem it finds comes with its fix.

The second command generates the secrets, writes `.env`, builds, migrates and starts everything. At the end it prints the console address and the first administrator's password — once.

To reach the console from another machine over HTTPS, add `--tls console.example.com`. The certificate it creates is self-issued, so browsers will warn until you install a proper one ([DEPLOYMENT.md §7](../../DEPLOYMENT.md#7-put-tls-in-front-of-it)). Without `--tls`, the console listens on `127.0.0.1:3000` only; use an SSH tunnel (`ssh -L 3000:127.0.0.1:3000 <host>`).

## First sign-in

1. Open the console and sign in as `admin@example.com` with the password `deploy.sh` printed. (Lost it? It is `BOOTSTRAP_ADMIN_PASSWORD` in `.env` until you change it.)
2. Go to **Settings → General → Change your password** and choose a new one.
3. Remove the `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` lines from `.env`. They only ever create the first account, on an empty database.
4. Create accounts for everyone else — see [Sign-in & users](sign-in.md).

The inventory fills in after the first poll of PuppetDB, usually within a few minutes.

## Let Puppet use the classification

Until this step the console is read-only: you can see the estate, but nodes do not receive what you classify. To wire it up, turn the ENC listener on and redeploy:

```bash
cat >> .env <<'EOF'
ENC_REPLICATION_ENABLED=true
ENC_REPLICATION_ALLOWED_CERTNAMES=puppet.example.com   # your Puppet server's certname
EOF
./scripts/deploy.sh
```

`deploy.sh` then prints one command to run from your workstation, and offers to run it for you over SSH:

```bash
./scripts/setup-enc.sh --remote you@puppet.example.com \
    --origin https://nexuspuppet.example.com:8443 --wire
```

It installs a small script on the Puppet server, proves it serves a node, and only then (`--wire`) puts it on the catalog compile path. The Puppet server keeps reading a local copy of the classification and never calls NexusPuppet while compiling. Details and alternatives: [DEPLOYMENT.md §6](../../DEPLOYMENT.md#6-wiring-puppetserver).

## Upgrade

```bash
cd /opt/nexuspuppet
git fetch --tags
git checkout v1.11.0                         # the release you are moving to
./scripts/deploy.sh
```

Re-running `deploy.sh` is the upgrade. It keeps your `.env`, rebuilds, applies database migrations in the right order and restarts. Puppet runs are unaffected while it does.

**One change to `.env` you will see.** If your `.env` has no `CONFIG_ENCRYPTION_KEY`, `deploy.sh` appends one and prints a line saying so. The console needs it to store a directory bind password or a single sign-on client secret. It is the only thing `deploy.sh` ever adds to an existing `.env`; it never edits or removes a line. **Back up `.env` afterwards, and never change that key** once you have saved a password in the console — the stored secrets cannot be read without it.

Read the **Upgrading** notes for each release you skip, in the [release notes](https://github.com/eth-man/nexuspuppet/releases). Since 1.10 there is no `EDITION` setting any more; a leftover `EDITION=` line in `.env` is ignored.

## Back up

Two things matter: the database, and `.env` (it holds the secrets, including `CONFIG_ENCRYPTION_KEY`). See [DEPLOYMENT.md §10](../../DEPLOYMENT.md#10-backups).
