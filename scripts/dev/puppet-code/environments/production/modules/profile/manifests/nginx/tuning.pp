# The class the `nginx-servers` group assigns.
#
# It did not exist until that group started matching. The group had been
# assigning `profile::nginx::tuning` since it was created, but its rule was
# `role EQUALS "web"` against a fact nothing supplied, so no node was ever
# classified into it and no catalog ever asked for the class.
#
# The moment the rule started matching, the missing class became a catalog
# compilation failure — the ENC named a class the environment did not have.
# Worth noting as a general hazard: a broken rule hides a broken class, and
# fixing the first exposes the second.
#
# A notify, like the rest of this development estate: the point is proving the
# ENC's classes and parameters reach a real catalog, not configuring nginx.
class profile::nginx::tuning ($extra_config_line = undef) {
  notify { "nexuspuppet: nginx extra_config_line=${extra_config_line}": }
}
