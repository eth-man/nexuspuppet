# A class that exists solely so the ENC has something real to assign.
#
# Writes a file whose CONTENT comes from a class parameter, so the test can
# prove two separate things: that the class reached the catalog, and that the
# parameter NexusPuppet set travelled with it. A class taking no parameters
# would only prove the first.
class nexuspuppet_demo (
  String $marker = 'unset',
  String $tier   = 'unset',
) {
  file { '/tmp/nexuspuppet-classified':
    ensure  => file,
    content => "marker=${marker}\ntier=${tier}\n",
    mode    => '0644',
  }
}
