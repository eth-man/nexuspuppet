# Matches the class NexusPuppet's sample classification assigns.
#
# Parameters are untyped on purpose. `permit_root_login: no` in YAML parses as
# a boolean, not the string "no", and a strict type would fail compilation for
# a reason that has nothing to do with the ENC under test.
class profile::base ($ntp_servers = []) {
  file { '/tmp/nexuspuppet-enc-proof':
    ensure  => file,
    # Written from the parameter, so the file proves the VALUE arrived rather
    # than merely that the class was declared.
    content => "ntp_servers=${ntp_servers}\ndatacenter=${::datacenter}\n",
    mode    => '0644',
  }
}
