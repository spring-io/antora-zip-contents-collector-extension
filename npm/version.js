'use strict'

const { promises: fsp } = require('fs')
const ospath = require('path')

const PROJECT_ROOT_DIR = ospath.join(__dirname, '..')
const PACKAGE_LOCK_FILE = ospath.join(PROJECT_ROOT_DIR, 'package-lock.json')
const PACKAGES_DIR = ospath.join(PROJECT_ROOT_DIR, 'packages')
const VERSION = process.env.npm_package_version

function updatePackageLock () {
  return fsp.readdir(PACKAGES_DIR, { withFileTypes: true }).then((dirents) => {
    const packageNames = dirents.filter((dirent) => dirent.isDirectory()).map(({ name }) => name)
    const moduleNames = packageNames.map((name) => `@springio/${name}`)
    const packagePaths = packageNames.map((name) => `packages/${name}`)
    const gitAddPaths = ['package-lock.json']
    const writes = []
    const packageLock = require(PACKAGE_LOCK_FILE)
    const { packages } = packageLock
    for (const packagePath of packagePaths) {
      if (!(packagePath in packages)) continue
      const packageJsonPath = ospath.join(packagePath, 'package.json')
      const packageJsonFile = ospath.join(PROJECT_ROOT_DIR, packageJsonPath)
      const packageJson = require(packageJsonFile)
      const packageInfo = packages[packagePath]
      if (packageInfo.version) packageInfo.version = VERSION
      const { dependencies: runtimeDependencies, devDependencies } = packageInfo
      let writePackageJson
      for (const dependencies of [runtimeDependencies, devDependencies]) {
        if (!dependencies) continue
        for (const moduleName of moduleNames) {
          if (moduleName in dependencies) {
            dependencies[moduleName] = VERSION
            packageJson[dependencies === devDependencies ? 'devDependencies' : 'dependencies'][moduleName] = VERSION
            writePackageJson = true
          }
        }
      }
      if (writePackageJson) {
        gitAddPaths.push(packageJsonPath)
        writes.push(fsp.writeFile(packageJsonFile, JSON.stringify(packageJson, undefined, 2) + '\n', 'utf8'))
      }
    }
    writes.push(fsp.writeFile(PACKAGE_LOCK_FILE, JSON.stringify(packageLock, undefined, 2) + '\n', 'utf8'))
    return Promise.all(writes)
  })
}

;(async () => {
  await updatePackageLock()
})()
