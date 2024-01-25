'use strict'

const snapshot = /^.*-SNAPSHOT$/m
const milestone = /^.*-M\d+$/m
const rc = /^.*-RC\d+$/m

module.exports = { classifyVersion }

function classifyVersion (version) {
  if (snapshot.exec(version)) return 'snapshot'
  if (milestone.exec(version)) return 'milestone'
  if (rc.exec(version)) return 'rc'
  return 'release'
}
