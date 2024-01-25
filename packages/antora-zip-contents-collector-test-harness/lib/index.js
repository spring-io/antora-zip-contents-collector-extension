/* eslint-env mocha */
'use strict'

process.env.NODE_ENV = 'test'

const chai = require('chai')
chai.use(require('chai-fs'))
chai.use(require('dirty-chai'))
const expect = chai.expect

const { configureLogger } = require('@antora/logger')
const fs = require('fs')
const { promises: fsp } = require('fs')
const { Git: GitServer } = require('node-git-server')
const { once } = require('events')
const yaml = require('js-yaml')
const express = require('express')
const basicAuth = require('express-basic-auth')
const archiver = require('archiver')

beforeEach(() => configureLogger({ level: 'silent' }))

function closeServer (server) {
  return once(server.close() || server, 'close')
}

function heredoc (literals, ...values) {
  const str =
    literals.length > 1
      ? values.reduce((accum, value, idx) => accum + value + literals[idx + 1], literals[0])
      : literals[0]
  const lines = str.trimRight().split(/^/m)
  if (lines.length < 2) return str
  if (lines[0] === '\n') lines.shift()
  const indentRx = /^ +/
  const indentSize = Math.min(...lines.filter((l) => l.startsWith(' ')).map((l) => l.match(indentRx)[0].length))
  return (indentSize ? lines.map((l) => (l.startsWith(' ') ? l.substr(indentSize) : l)) : lines).join('')
}

async function updateYamlFile (filepath, data) {
  const parsed = yaml.load(await fsp.readFile(filepath), { schema: yaml.CORE_SCHEMA })
  Object.assign(parsed, data)
  await fsp.writeFile(filepath, yaml.dump(parsed, { noArrayIndent: true }), 'utf8')
}

function startGitServer (dir) {
  return new Promise((resolve, reject) => {
    const gitServer = new GitServer(dir, { autoCreate: false })
    gitServer.listen(0, { type: 'http' }, function (err) {
      err ? reject(err) : resolve([gitServer, this.address().port])
    })
  })
}

function startHttpServer (httpPath, dir, users) {
  return new Promise((resolve, reject) => {
    const app = express()
    if (users) app.use(basicAuth({ users }))
    app.use(httpPath, express.static(dir))
    const server = app.listen(0, function (err) {
      err ? reject(err) : resolve([server, server.address().port])
    })
  })
}

function trapAsyncError (fn) {
  return fn().then(
    (retVal) => () => retVal,
    (err) => () => {
      throw err
    }
  )
}

function createZip (dir, file) {
  const archive = archiver('zip')
  const stream = fs.createWriteStream(file)
  return new Promise((resolve, reject) => {
    archive
      .directory(dir, false)
      .on('error', (err) => reject(err))
      .pipe(stream)
    stream.on('close', () => resolve())
    archive.finalize()
  })
}

module.exports = {
  closeServer,
  createZip,
  expect,
  heredoc,
  updateYamlFile,
  startGitServer,
  startHttpServer,
  trapAsyncError,
}
