class profile::base::ssh ($permit_root_login = true) {
  notify { "nexuspuppet: permit_root_login=${permit_root_login}": }
}
