#!/usr/bin/env bash
# Wire this Puppet server to a NexusPuppet ENC. Run it ON the Puppet server.
#
#   ./setup-enc.sh --origin https://nexuspuppet.example.com:8443            # check + install
#   ./setup-enc.sh --origin https://nexuspuppet.example.com:8443 --wire     # and edit puppet.conf
#   ./setup-enc.sh --check --origin https://nexuspuppet.example.com:8443    # check only
#
# Or drive it from your workstation, without cloning anything on the Puppet
# server — it ships itself over your own SSH session and runs there:
#
#   ./setup-enc.sh --remote you@puppet.example.com \
#                  --origin https://nexuspuppet.example.com:8443 --wire
#
# --remote writes no key and touches no authorized_keys. One interactive
# session, and nothing left behind.
#
# WHY THIS EXISTS. DEPLOYMENT.md §6 is 500 lines and 34 commands across two
# hosts, and it is a reference — it explains why at every turn, which is what you
# want during an incident and not what you want on a Tuesday afternoon.
#
# WHY IT CANNOT BE ONE COMMAND FROM THE CONSOLE. Nothing may make Puppet depend
# on NexusPuppet at runtime (ADR-0003), so there is no channel from the console
# into this host and there never will be. The Puppet-server half is yours to run.
# This makes that half one command instead of a dozen.
#
# YOU PROBABLY DO NOT WANT --receipts. Compile receipts already work without it
# on a REPLICATED host: nexuspuppet-sync.sh creates the receipts directory and
# hands the accumulated receipts over on each poll, deriving the URL from the
# tree URL. Installing this script's puller is all it takes.
#
# --receipts installs nexuspuppet-receipts.sh, a separate collector, and is for
# the CO-LOCATED case (ADR-0022 §15) where there is no sync config to carry
# them. Passing it on a replicated host is not harmful but is redundant: the
# collector stamps a marker, the sync script sees it and stands aside, and the
# same work happens in a second timer instead of the one already running.
#
# This distinction cost real debugging time — `compiled 0/N` in the console was
# read as "receipts are not installed" when it only ever meant "no agent has
# compiled since the tree last changed". Agents run on their own schedule.
#
# WHAT IT WILL NOT DO WITHOUT --wire. Editing puppet.conf is the step that puts
# an ENC on the catalog compile path for every node. If the tree is ever missing
# the ENC script exits non-zero, and the `exec` terminus has NO fallback to
# site.pp — compilation fails. So that edit is opt-in, after the checks pass, and
# it backs the file up first.

set -euo pipefail

# Resolved BEFORE the cd, and absolute. After `cd $(dirname $0)` a relative $0
# like scripts/setup-enc.sh no longer resolves from the new directory, which is
# what silently broke --help when invoked from the repo root.
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$0")"

ORIGIN=""
CHECK_ONLY=""
WIRE=""
# OFF BY DEFAULT, AND THAT IS CORRECT — see the note in the header. On a
# replicated host nexuspuppet-sync.sh already carries receipts; this flag is for
# the co-located case, which has no sync config to carry them.
RECEIPTS=""
REMOTE=""
# Certname to grant the class-list read to (ADR-0024 §3). Empty = do nothing.
ALLOW_CLASS_LIST=""
ENC_DIR="/etc/puppetlabs/nexuspuppet"

while [ $# -gt 0 ]; do
    case "$1" in
        --origin) ORIGIN="${2:-}"; shift 2 ;;
        --remote) REMOTE="${2:-}"; shift 2 ;;
        --check) CHECK_ONLY=yes; shift ;;
        --wire) WIRE=yes; shift ;;
        --receipts) RECEIPTS=yes; shift ;;
        --allow-class-list) ALLOW_CLASS_LIST="${2:-}"; shift 2 ;;
        # Everything from line 2 to the blank line before `set -euo pipefail`,
        # found rather than hardcoded — a fixed range silently truncates the help
        # the moment the header grows, which is exactly how the receipts note
        # went missing.
        -h | --help)
            sed -n "2,$(($(grep -n '^set -euo pipefail' "$SELF" | head -1 | cut -d: -f1) - 1))p" "$SELF" |
                sed 's/^# \{0,1\}//'
            exit 0
            ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad() { printf '  \033[31m✗\033[0m %s\n' "$*"; FAILED=$((FAILED + 1)); }
note() { printf '      %s\n' "$*"; }
die() { printf '\n\033[31mFAILED:\033[0m %s\n' "$*" >&2; exit 1; }

# Update one key in an env file, preserving every other line.
#
# NOT `printf ... > file`. Re-running this script is normal — after an upgrade,
# to add --receipts, to point at a new origin — and a truncating write silently
# drops settings the operator put there by hand. The co-located case is the one
# that bites: NEXUSPUPPET_RECEIPTS_RESOLVE lives in this file and nothing else
# recreates it, so clobbering it breaks receipts with no error anywhere.
set_env_key() {
    local file=$1 key=$2 value=$3 tmp
    [ -e "$file" ] || : >"$file"
    if grep -qE "^[[:space:]]*${key}=" "$file"; then
        tmp=$(mktemp)
        sed "s|^[[:space:]]*${key}=.*|${key}=${value}|" "$file" >"$tmp"
        cat "$tmp" >"$file"
        rm -f "$tmp"
    else
        printf '%s=%s\n' "$key" "$value" >>"$file"
    fi
}

# ---------------------------------------------------------------------------
# --remote: ship this script to the Puppet server and run it there.
#
# WHY THIS DOES NOT BREAK ADR-0003. That rule forbids the RUNNING PRODUCT from
# depending on Puppet — the api container must never reach puppetserver while a
# catalog compiles. This is an installer, driven by an operator at a terminal,
# using that operator's own SSH credentials, once. Afterwards the compile path
# is still `cat` on a local file with no NexusPuppet process in it.
#
# WHAT IT DELIBERATELY DOES NOT DO. It does not write a key, touch
# authorized_keys, or leave anything behind that could be used again. A standing
# root channel from the console host to the Puppet server would mean a
# compromised console yields the whole estate — a far worse trade than the
# convenience is worth. One interactive session, then nothing.
# ---------------------------------------------------------------------------
if [ -n "$REMOTE" ]; then
    command -v ssh >/dev/null || die "--remote needs ssh on THIS machine"
    command -v tar >/dev/null || die "--remote needs tar on THIS machine"
    [ -d ../deploy/systemd ] || die "run --remote from a repo checkout — ../deploy/systemd is missing"

    remote_args=""
    [ -n "$ORIGIN" ] && remote_args="$remote_args --origin '$ORIGIN'"
    [ -n "$CHECK_ONLY" ] && remote_args="$remote_args --check"
    [ -n "$WIRE" ] && remote_args="$remote_args --wire"
    [ -n "$RECEIPTS" ] && remote_args="$remote_args --receipts"
    [ -n "$ALLOW_CLASS_LIST" ] && remote_args="$remote_args --allow-class-list '$ALLOW_CLASS_LIST'"

    step "Copying the ENC scripts to ${REMOTE}"
    stage=$(mktemp -d)
    trap 'rm -rf "$stage"' EXIT
    mkdir -p "$stage/scripts" "$stage/deploy"
    cp ./setup-enc.sh ./nexuspuppet-sync.sh ./nexuspuppet-enc.sh ./nexuspuppet-receipts.sh "$stage/scripts/"
    cp -r ../deploy/systemd "$stage/deploy/"

    # Pushed as a tar stream over the same SSH session rather than scp'd file by
    # file, so a half-copied payload cannot be run.
    remote_dir=$(tar -cf - -C "$stage" . | ssh "$REMOTE" \
        'd=$(mktemp -d /tmp/nexuspuppet-enc.XXXXXX) && tar -xf - -C "$d" \
         && chmod +x "$d"/scripts/*.sh && printf %s "$d"') \
        || die "could not copy to ${REMOTE} — check: ssh ${REMOTE} true"
    [ -n "$remote_dir" ] || die "the copy to ${REMOTE} produced no working directory"
    ok "copied"

    # -t for a TTY: sudo on the far side may need to prompt for a password, and
    # without a TTY that prompt never appears and the run simply hangs.
    step "Running on ${REMOTE}"
    printf '\n'
    ssh -t "$REMOTE" \
        "cd '${remote_dir}/scripts' && sudo ./setup-enc.sh${remote_args}; rc=\$?; rm -rf '${remote_dir}'; exit \$rc"
    rc=$?

    if [ "$rc" -ne 0 ]; then
        printf '\n\033[31mThe remote run failed (exit %s).\033[0m Nothing was left on %s.\n\n' "$rc" "$REMOTE"
    fi
    exit "$rc"
fi

[ "$(id -u)" -eq 0 ] || die "run this with sudo — it installs into /usr/local/bin and /etc
       Or drive it from your workstation:  ./setup-enc.sh --remote you@puppet-server ..."

# Puppet installs to /opt/puppetlabs/bin, which is NOT in sudo's secure_path on
# Debian or Ubuntu. So under the sudo this script requires, `puppet` is not on
# PATH even on a perfectly good Puppet server — and a bare `command -v puppet`
# reports "no puppet on this host", which is wrong and sends you hunting.
PUPPET=$(command -v puppet 2>/dev/null || true)
if [ -z "$PUPPET" ]; then
    for candidate in /opt/puppetlabs/bin/puppet /usr/local/bin/puppet /usr/bin/puppet; do
        [ -x "$candidate" ] && PUPPET="$candidate" && break
    done
fi
[ -n "$PUPPET" ] || die "no puppet binary found (checked PATH and /opt/puppetlabs/bin).
       Run this ON the Puppet server."

CERTNAME=$("$PUPPET" config print certname 2>/dev/null || hostname -f)
SSL_DIR=$("$PUPPET" config print ssldir --section server 2>/dev/null || echo /etc/puppetlabs/puppet/ssl)

# ---------------------------------------------------------------------------
# Checks first, always. Every one corresponds to a way this goes wrong that is
# invisible until agents start failing.
# ---------------------------------------------------------------------------
FAILED=0
step "Checking this host"

# THE ONE THAT COSTS AN INSTALLATION. Puppet Enterprise runs a classifier of its
# own; node_terminus names exactly one, so wiring an ENC REPLACES it and PE's
# own classes stop being applied to every node, including its infrastructure.
terminus=$("$PUPPET" config print node_terminus --section server 2>/dev/null || echo unknown)
if [ "$terminus" = "classifier" ]; then
    bad "node_terminus is 'classifier' — Puppet Enterprise is classifying this estate"
    note "wiring this ENC REPLACES PE's classifier. Its own classes, including the"
    note "infrastructure groups it created at install, stop being applied to every"
    note "node. Do not continue without reading DEPLOYMENT.md §6."
elif [ "$terminus" = "exec" ]; then
    ok "node_terminus is already 'exec'"
    note "external_nodes = $("$PUPPET" config print external_nodes --section server 2>/dev/null || echo '?')"
else
    ok "node_terminus is '${terminus}' — no classifier to displace"
fi

# Labelled, not basenamed: the certificate and the private key are both
# <certname>.pem and differ only by directory, so a basename prints the same
# line twice and tells you nothing about which one is missing.
check_ssl_file() {
    if [ -r "${SSL_DIR}/$1" ]; then
        ok "$2 present"
    else
        bad "missing $2 — ${SSL_DIR}/$1"
        note "this host's own agent certificate is what authenticates it to the origin"
    fi
}
check_ssl_file "certs/${CERTNAME}.pem" "certificate"
check_ssl_file "private_keys/${CERTNAME}.pem" "private key"
check_ssl_file "certs/ca.pem" "CA certificate"

# A separate flag rather than blanking ORIGIN: blanking it makes the reachability
# branch below fall through to "no --origin given", which is false — one mistake
# reported as two failures, the second of them wrong.
ORIGIN_USABLE=""
if [ -z "$ORIGIN" ]; then
    bad "no --origin given"
    note "  --origin https://<nexuspuppet-host>:8443"
else
    case "$ORIGIN" in
        https://*) ORIGIN_USABLE=yes ;;
        http://*)
            bad "--origin is http:// — the tree is served over mTLS only"
            note "  --origin https://<nexuspuppet-host>:8443"
            ;;
        *)
            bad "--origin must begin with https:// (got '${ORIGIN}')"
            note "  --origin https://<nexuspuppet-host>:8443"
            ;;
    esac
fi

if [ -n "$ORIGIN_USABLE" ]; then
    err=$(mktemp)
    code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 \
        --cert "${SSL_DIR}/certs/${CERTNAME}.pem" \
        --key "${SSL_DIR}/private_keys/${CERTNAME}.pem" \
        --cacert "${SSL_DIR}/certs/ca.pem" \
        "${ORIGIN}/enc-tree.tar" 2>"$err") || true
    [ -n "$code" ] || code=000
    case "$code" in
        200) ok "the origin served the tree to ${CERTNAME}" ;;
        403)
            bad "the origin refused ${CERTNAME} (403)"
            note "add it to ENC_REPLICATION_ALLOWED_CERTNAMES on the NexusPuppet host:"
            note "  echo 'ENC_REPLICATION_ALLOWED_CERTNAMES=${CERTNAME}' >> .env && ./scripts/deploy.sh"
            ;;
        000)
            detail=$(head -1 "$err" 2>/dev/null)
            bad "could not reach ${ORIGIN}"
            [ -n "$detail" ] && note "${detail}"
            note "is ENC_REPLICATION_ENABLED=true there, and 8443 open from this host?"
            ;;
        *) bad "the origin answered HTTP ${code}" ;;
    esac
    rm -f "$err"
fi

for f in nexuspuppet-sync.sh nexuspuppet-enc.sh; do
    if [ -r "./${f}" ]; then
        ok "${f} found beside this script"
    else
        bad "${f} is not in $(pwd)"
    fi
done

# The units are a directory up, in the repo. Checked HERE rather than at install
# time: a missing unit only shows up as `systemctl start` failing with "unit not
# found", long after the script has reported progress and started changing things.
UNIT_DIR="../deploy/systemd"
if [ -d "$UNIT_DIR" ]; then
    ok "systemd units found in ${UNIT_DIR}"
else
    bad "no ${UNIT_DIR} — run this from a repo checkout, not a directory of copied scripts"
    note "  git clone https://github.com/eth-man/nexuspuppet && cd nexuspuppet/scripts"
fi

if [ "$FAILED" -ne 0 ]; then
    printf '\n\033[31m%s check(s) failed.\033[0m Nothing has been installed.\n\n' "$FAILED"
    exit 1
fi

if [ -n "$CHECK_ONLY" ]; then
    printf '\n\033[32mAll checks passed.\033[0m Run without --check to install.\n\n'
    exit 0
fi

# ---------------------------------------------------------------------------
# Install. Nothing here touches the compile path yet.
# ---------------------------------------------------------------------------
puppet_user=$("$PUPPET" config print user --section server 2>/dev/null || echo puppet)
puppet_group=$("$PUPPET" config print group --section server 2>/dev/null || echo puppet)

step "Installing the puller"
install -m 0755 ./nexuspuppet-sync.sh /usr/local/bin/nexuspuppet-sync.sh
for unit in nexuspuppet-sync.service nexuspuppet-sync.timer; do
    install -m 0644 "${UNIT_DIR}/${unit}" /etc/systemd/system/ \
        || die "could not install ${unit} from ${UNIT_DIR}"
done

set_env_key /etc/default/nexuspuppet-sync NEXUSPUPPET_SYNC_URL "${ORIGIN}/enc-tree.tar"
# Wrong or missing and receipts silently never appear — the ENC script may not
# complain, because a catalog must never fail over bookkeeping. Written from what
# Puppet reports rather than left to the `puppet` default, which is wrong on
# Puppet Enterprise (`pe-puppet`).
set_env_key /etc/default/nexuspuppet-sync NEXUSPUPPET_SYNC_RECEIPTS_GROUP "$puppet_group"
ok "configured for ${ORIGIN}"

# The shipped unit hardcodes SupplementaryGroups=puppet, which is how it reads a
# 0640 puppet:puppet private key with CAP_DAC_OVERRIDE dropped. On Puppet
# Enterprise that group is pe-puppet and the unit cannot read the key at all.
if [ "$puppet_group" != "puppet" ]; then
    mkdir -p /etc/systemd/system/nexuspuppet-sync.service.d
    printf '[Service]\nSupplementaryGroups=%s\n' "$puppet_group" \
        >/etc/systemd/system/nexuspuppet-sync.service.d/group.conf
    ok "overrode the unit's group to ${puppet_group}"
fi

systemctl daemon-reload

step "Fetching the tree"
systemctl start nexuspuppet-sync.service || die "the first sync failed — journalctl -u nexuspuppet-sync"
[ -f "${ENC_DIR}/default.yaml" ] || die "no ${ENC_DIR}/default.yaml after the sync.
       The tree did not arrive. journalctl -u nexuspuppet-sync -n 30"
ok "tree installed at ${ENC_DIR}"
systemctl enable --now nexuspuppet-sync.timer >/dev/null 2>&1 || true
ok "sync timer enabled"

step "Installing the ENC script"
install -m 0755 ./nexuspuppet-enc.sh /usr/local/bin/nexuspuppet-enc.sh
ok "/usr/local/bin/nexuspuppet-enc.sh"

# ---------------------------------------------------------------------------
# THE GATE. This is exactly what puppetserver will run, as the user it runs as.
# ---------------------------------------------------------------------------
step "Serving a node, as puppetserver will"
if out=$(sudo -u "$puppet_user" /usr/local/bin/nexuspuppet-enc.sh "$CERTNAME" 2>&1) \
    && printf '%s' "$out" | head -1 | grep -q -- '---'; then
    ok "valid YAML, exit 0"
    printf '%s\n' "$out" | sed 's/^/      /' | head -6
else
    die "the ENC script did not serve ${CERTNAME}:
$(printf '%s' "$out" | sed 's/^/       /')

       puppet.conf has NOT been changed. Fix this first — with node_terminus
       set to exec, this failure would fail catalog compilation for every node."
fi

if [ -n "$RECEIPTS" ]; then
    step "Installing the receipts collector"
    install -m 0755 ./nexuspuppet-receipts.sh /usr/local/bin/nexuspuppet-receipts.sh
    for unit in nexuspuppet-receipts.service nexuspuppet-receipts.timer; do
        install -m 0644 "${UNIT_DIR}/${unit}" /etc/systemd/system/ \
            || die "could not install ${unit} from ${UNIT_DIR}"
    done
    set_env_key /etc/default/nexuspuppet-receipts NEXUSPUPPET_RECEIPTS_GROUP "$puppet_group"
    systemctl daemon-reload
    systemctl enable --now nexuspuppet-receipts.timer >/dev/null 2>&1 || true
    ok "collector enabled — compiles will report back"
fi

# ---------------------------------------------------------------------------
# Let a NexusPuppet read the class list (ADR-0024 §3).
#
# auth.conf is the SECURITY CONTROL on this server, so this is a named flag with
# a backup — never a side effect of running an upgrade. It grants exactly one
# read-only endpoint to exactly one certname.
#
# It only ever edits a rule THIS SCRIPT created, identified by its name. A rule
# for the same path written by somebody else is left alone and reported: their
# reasons are not ours to guess at.
# ---------------------------------------------------------------------------
if [ -n "$ALLOW_CLASS_LIST" ]; then
    step "Allowing ${ALLOW_CLASS_LIST} to read the class list"

    AUTH_CONF=/etc/puppetlabs/puppetserver/conf.d/auth.conf
    [ -r "$AUTH_CONF" ] || die "no ${AUTH_CONF} — is this a Puppet server?"

    RUBY=/opt/puppetlabs/puppet/bin/ruby
    [ -x "$RUBY" ] || RUBY=$(command -v ruby || true)
    [ -n "$RUBY" ] || die "no ruby found. Puppet ships one at /opt/puppetlabs/puppet/bin/ruby."

    cp -a "$AUTH_CONF" "${AUTH_CONF}.bak.$(date +%Y%m%d%H%M%S)"

    # Ruby, because Puppet ships it — python3 is not guaranteed on a Puppet
    # server and a shell/sed edit of HOCON is how you corrupt a file that stops
    # puppetserver booting.
    # shellcheck disable=SC2016
    # Single quotes are deliberate: $1 and $~ below are RUBY globals from the
    # regex matches, and letting the shell expand them would substitute
    # positional parameters into someone's auth.conf.
    result=$("$RUBY" -e '
      path, certname = ARGV
      s = File.read(path)
      marker = "nexuspuppet environment classes"
      endpoint = "/puppet/v3/environment_classes"

      if s.include?(marker)
        i = s.index(marker)
        open_i  = s.rindex("{", i)
        close_i = s.index("}", i)
        block   = s[open_i..close_i]
        if block =~ /allow:\s*\[([^\]]*)\]/
          names = $1.scan(/"([^"]*)"/).flatten
          if names.include?(certname)
            print "unchanged"; exit
          end
          names << certname
          nb = block.sub(/allow:\s*\[[^\]]*\]/, "allow: [" + names.map { |n| %Q{"#{n}"} }.join(", ") + "]")
        elsif block =~ /allow:\s*"([^"]*)"/
          existing = $1
          if existing == certname
            print "unchanged"; exit
          end
          nb = block.sub(/allow:\s*"[^"]*"/, %Q{allow: ["#{existing}", "#{certname}"]})
        else
          print "unrecognised"; exit
        end
        File.write(path, s[0...open_i] + nb + s[(close_i + 1)..-1])
        print "extended"
      elsif s.include?(endpoint)
        # Someone else already governs this path. Their reasons are not ours to
        # guess at, and a second rule would make the effective policy depend on
        # sort-order nobody chose deliberately.
        print "foreign"
      else
        anchor = "    rules: [\n"
        unless s.include?(anchor)
          print "no-anchor"; exit
        end
        rule = <<~RULE
              {
                  # Added by nexuspuppet setup-enc.sh --allow-class-list.
                  # READ ONLY, and one endpoint: class names, parameter names and
                  # default values from the environment. Not catalogs, not facts,
                  # not the CA.
                  match-request: {
                      path: "#{endpoint}"
                      type: path
                      method: get
                  }
                  allow: "#{certname}"
                  sort-order: 400
                  name: "#{marker}"
              },
        RULE
        File.write(path, s.sub(anchor, anchor + rule))
        print "added"
      end
    ' "$AUTH_CONF" "$ALLOW_CLASS_LIST" 2>&1) || die "could not edit ${AUTH_CONF}: ${result}"

    case "$result" in
        added) ok "rule added for ${ALLOW_CLASS_LIST}" ;;
        extended) ok "added ${ALLOW_CLASS_LIST} to the existing rule" ;;
        unchanged) ok "${ALLOW_CLASS_LIST} was already allowed — nothing to do" ;;
        foreign)
            die "auth.conf already has a rule for /puppet/v3/environment_classes that
       this script did not write. Left alone deliberately — a second rule would
       make the effective policy depend on a sort-order nobody chose.

       Add ${ALLOW_CLASS_LIST} to that rule's allow list by hand."
            ;;
        *) die "could not understand ${AUTH_CONF} (${result}). It is unchanged; the backup is beside it." ;;
    esac

    # RELOAD, not restart. auth.conf is re-read on SIGHUP, and a restart would
    # stop compiling catalogs for a minute to apply a read permission.
    if [ "$result" != "unchanged" ]; then
        systemctl reload puppetserver || die "puppetserver would not reload — restore ${AUTH_CONF}.bak.* and try again"
        ok "puppetserver reloaded"
    fi
fi

# ---------------------------------------------------------------------------
# The compile path. Opt-in, and reversible.
# ---------------------------------------------------------------------------
CONF=$("$PUPPET" config print config --section server 2>/dev/null || echo /etc/puppetlabs/puppet/puppet.conf)

if [ -z "$WIRE" ]; then
    printf '\n\033[32mReady.\033[0m The tree is here and the ENC script serves it.\n\n'
    # Re-running on an already-wired host is the normal upgrade path, and telling
    # that operator "nothing classifies yet" is simply false.
    if [ "$terminus" = "exec" ]; then
        printf 'This server was already wired, and still is — puppet.conf was not touched.\n'
        printf 'The scripts and the tree are now up to date.\n\n'
    else
        printf 'Nothing classifies through NexusPuppet yet. To make it, add to %s:\n\n' "$CONF"
        printf '  [server]\n  node_terminus  = exec\n  external_nodes = /usr/local/bin/nexuspuppet-enc.sh\n\n'
        printf 'then restart puppetserver. Or re-run this with --wire to do both.\n'
        printf 'Verify with one node before the fleet:  puppet agent -t --noop\n\n'
    fi
    exit 0
fi

step "Wiring ${CONF}"
cp -a "$CONF" "${CONF}.bak.$(date +%Y%m%d%H%M%S)"
ok "backed up"

# `[server]`, not `[master]`. Puppet 8 renamed the section; the old name is a
# deprecated alias that still works and gives no hint it is obsolete.
"$PUPPET" config set node_terminus exec --section server
"$PUPPET" config set external_nodes /usr/local/bin/nexuspuppet-enc.sh --section server
ok "node_terminus = exec"

systemctl restart puppetserver || die "puppetserver did not restart — restore ${CONF}.bak.* and try again"
ok "puppetserver restarted"

printf '\n\033[32mWired.\033[0m NexusPuppet is now classifying this estate.\n\n'
printf '  Verify on ONE node before trusting the fleet:\n    puppet agent -t --noop\n\n'
printf '  With no node groups defined, every node gets default.yaml — an empty\n'
printf '  classification. That is additive: site.pp and hiera keep applying.\n\n'
printf '  To undo: restore %s.bak.* and restart puppetserver.\n\n' "$CONF"
