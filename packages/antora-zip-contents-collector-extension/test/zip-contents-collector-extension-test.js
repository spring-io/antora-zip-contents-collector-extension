/* eslint-env mocha */
/* eslint no-template-curly-in-string: "off" */
'use strict'

const {
  createZip,
  closeServer,
  expect,
  heredoc,
  startGitServer,
  startHttpServer,
  trapAsyncError,
  updateYamlFile,
} = require('@springio/antora-zip-contents-collector-test-harness')
const aggregateContent = require('@antora/content-aggregator')
const ContentCatalog = require('@antora/content-classifier/content-catalog')
const UiCatalog = require('@antora/ui-loader/ui-catalog')
const fs = require('fs')
const { promises: fsp } = fs
const { isAsyncFunction: isAsync } = require('util').types
const getUserCacheDir = require('cache-directory')
const git = require('@antora/content-aggregator/git')
const logger = require('@antora/logger')
const os = require('os')
const ospath = require('path')
const url = require('url')
const Vinyl = require('vinyl')

const posixify = ospath.sep === '\\' ? (p) => p.replace(/\\/g, '/') : (p) => p

const FIXTURES_DIR = ospath.join(__dirname, 'fixtures')
const FIXTURES_REPOS_DIR = ospath.join(FIXTURES_DIR, 'repos')
const FIXTURES_ZIPS_DIR = ospath.join(FIXTURES_DIR, 'zips')
const WORK_DIR = ospath.join(__dirname, 'work')
const CACHE_DIR = ospath.join(WORK_DIR, 'cache')
const REPOS_DIR = ospath.join(WORK_DIR, 'repos')

describe('zip contents collector extension', () => {
  let gitServer
  let gitServerPort
  let tempDir
  let httpServer
  let httpServerPort

  before(async () => {
    await cleanWorkDir({ create: true })
    tempDir = await fsp.mkdtemp(ospath.join(os.tmpdir(), 'antora-zip-collector'))
    ;[gitServer, gitServerPort] = await startGitServer(REPOS_DIR)
    httpServer = httpServerPort = null
  })

  after(async () => {
    await closeServer(gitServer.server)
    await fsp.rm(WORK_DIR, { recursive: true, force: true })
    await fsp.rm(tempDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    logger.configureLogger({ level: 'error' })
  })

  afterEach(async () => {
    if (httpServer) await closeServer(httpServer)
    await cleanWorkDir()
  })

  const cleanWorkDir = async (opts = {}) => {
    await fsp.rm(WORK_DIR, { recursive: true, force: true })
    if (opts.create) await fsp.mkdir(WORK_DIR, { recursive: true })
  }

  describe('bootstrap', () => {
    it('should be able to require extension', () => {
      const exports = require('@springio/antora-zip-contents-collector-extension')
      expect(exports).to.be.instanceOf(Object)
      expect(exports.register).to.be.instanceOf(Function)
    })
  })

  describe('integration', () => {
    const ext = require('@springio/antora-zip-contents-collector-extension')

    it('should download zip and collect files', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: ['start-page'] }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/',
        before: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          expect(contentAggregate[0].files).to.be.empty()
        },
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(1)
          expect(contentAggregate[0].files[0].src.path).to.equal('modules/ROOT/pages/index.adoc')
        },
      })
    })

    it('should download zip and collect files when has expanded include', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: [{ name: 'start-page' }] }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/',
        before: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          expect(contentAggregate[0].files).to.be.empty()
        },
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(1)
          expect(contentAggregate[0].files[0].src.path).to.equal('modules/ROOT/pages/index.adoc')
        },
      })
    })

    it('should download zip and collect files when multiple URL candidates', async () => {
      const extensionConfig = () => ({
        locations: [
          { url: `http://localhost:${httpServerPort}/nope/\${name}.zip` },
          { url: `http://localhost:${httpServerPort}/bad/\${name}.zip` },
          { url: `http://localhost:${httpServerPort}/\${name}.zip` },
        ],
      })
      const componentConfig = { include: ['start-page'] }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/',
        before: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          expect(contentAggregate[0].files).to.be.empty()
        },
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(1)
          expect(contentAggregate[0].files[0].src.path).to.equal('modules/ROOT/pages/index.adoc')
        },
      })
    })

    it('should download zip and collect files when has classifier', async () => {
      const extensionConfig = () => ({
        locations: [`http://localhost:${httpServerPort}/\${name}-\${classifier}.zip`],
      })
      const componentConfig = {
        include: [
          { name: 'classifier', classifier: 'one' },
          { name: 'classifier', classifier: 'two' },
        ],
      }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['classifier-one', 'classifier-two'],
        httpPath: '/',
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(2)
          expect(contentAggregate[0].files[0].src.path).to.equal('modules/ROOT/pages/c1.adoc')
          expect(contentAggregate[0].files[1].src.path).to.equal('modules/ROOT/pages/c2.adoc')
        },
      })
    })

    it('should download zip and collect files when has module and path', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: [{ name: 'no-path', module: 'ROOT', path: 'pages' }] }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['no-path'],
        httpPath: '/',
        before: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          expect(contentAggregate[0].files).to.be.empty()
        },
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(1)
          expect(contentAggregate[0].files[0].src.path).to.equal('modules/ROOT/pages/index.adoc')
        },
      })
    })

    it('should fail when HTTP status code is not 2XX', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: ['missing'] }
      expect(
        await trapAsyncError(() =>
          runScenario({
            repoName: 'test-at-root',
            extensionConfig,
            componentConfig,
            zipFiles: ['start-page'],
            httpPath: '/',
            after: ({ contentAggregate }) => {
              expect(contentAggregate[0].files).to.have.lengthOf(1)
              expect(contentAggregate[0].files[0].path).to.equal('modules/ROOT/pages/index.adoc')
            },
          })
        )
      ).to.throw(
        Error,
        `Unable to download 'http://localhost:${httpServerPort}/missing.zip' due to HTTP response code 404 (Not Found)`
      )
    })

    it('should fail when multiple URL candidates and HTTP status codes are not 2XX', async () => {
      const extensionConfig = () => ({
        locations: [
          { url: `http://localhost:${httpServerPort}/nope/\${name}.zip` },
          { url: `http://localhost:${httpServerPort}/bad/\${name}.zip` },
          { url: `http://localhost:${httpServerPort}/missing/\${name}.zip` },
        ],
      })
      const componentConfig = { include: ['missing'] }
      expect(
        await trapAsyncError(() =>
          runScenario({
            repoName: 'test-at-root',
            extensionConfig,
            componentConfig,
            zipFiles: ['start-page'],
            httpPath: '/',
            after: ({ contentAggregate }) => {
              expect(contentAggregate[0].files).to.have.lengthOf(1)
              expect(contentAggregate[0].files[0].path).to.equal('modules/ROOT/pages/index.adoc')
            },
          })
        )
      ).to.throw(
        Error,
        `Unable to download 'missing' from any location:
- Unable to download 'http://localhost:${httpServerPort}/nope/missing.zip' due to HTTP response code 404 (Not Found)
- Unable to download 'http://localhost:${httpServerPort}/bad/missing.zip' due to HTTP response code 404 (Not Found)
- Unable to download 'http://localhost:${httpServerPort}/missing/missing.zip' due to HTTP response code 404 (Not Found)`
      )
    })

    it('should download zip and collect files when has gradle version file', async () => {
      const extensionConfig = () => ({
        versionFile: 'gradle.properties',
        locations: [{ url: `http://localhost:${httpServerPort}/v\${version}/\${name}.zip` }],
      })
      const componentConfig = { include: ['start-page'] }
      await runScenario({
        repoName: 'test-gradle-version-file-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/v1.2.3',
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(2)
          const page = contentAggregate[0].files.find((it) => it.src.path === 'modules/ROOT/pages/index.adoc')
          expect(page).to.be.exist()
        },
      })
    })

    it('should download zip and collect files when has gradle version file in dir', async () => {
      const extensionConfig = () => ({
        versionFile: 'my-project/my-build/gradle.properties',
        locations: [{ url: `http://localhost:${httpServerPort}/v\${version}/\${name}.zip` }],
      })
      const componentConfig = { include: ['start-page'] }
      await runScenario({
        repoName: 'test-gradle-version-file-in-dir',
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/v1.2.3',
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(2)
          const page = contentAggregate[0].files.find((it) => it.src.path === 'modules/ROOT/pages/index.adoc')
          expect(page).to.be.exist()
        },
      })
    })

    it('should download zip and collect files when has maven version file', async () => {
      const extensionConfig = () => ({
        versionFile: 'pom.xml',
        locations: [{ url: `http://localhost:${httpServerPort}/v\${version}/\${name}.zip` }],
      })
      const componentConfig = { include: ['start-page'] }
      await runScenario({
        repoName: 'test-maven-version-file-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/v1.2.3',
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(2)
          const page = contentAggregate[0].files.find((it) => it.src.path === 'modules/ROOT/pages/index.adoc')
          expect(page).to.be.exist()
        },
      })
    })

    it('should download zip and collect files when has version file in worktree', async () => {
      const extensionConfig = () => ({
        versionFile: 'gradle.properties',
        locations: [{ url: `http://localhost:${httpServerPort}/v\${version}/\${name}.zip` }],
      })
      const componentConfig = { include: ['start-page'] }
      await runScenario({
        repoName: 'test-gradle-version-file-at-root',
        useLocalRepo: true,
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/v1.2.3',
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(2)
          const page = contentAggregate[0].files.find((it) => it.src.path === 'modules/ROOT/pages/index.adoc')
          expect(page).to.be.exist()
        },
      })
    })

    it('should download zip and collect files only from url with matching "when" restriction', async () => {
      const extensionConfig = () => ({
        versionFile: 'gradle.properties',
        locations: [
          {
            url: `http://localhost:${httpServerPort}/snapshot/v\${version}/\${name}.zip`,
            forVersionType: 'snapshot',
          },
          {
            url: `http://localhost:${httpServerPort}/release/v\${version}/\${name}.zip`,
            forVersionType: ['release'],
          },
        ],
      })
      const componentConfig = { include: ['start-page'] }
      const downloadLog = []
      await runScenario({
        repoName: 'test-gradle-version-file-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/release/v1.2.3',
        downloadLog,
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(2)
          const page = contentAggregate[0].files.find((it) => it.src.path === 'modules/ROOT/pages/index.adoc')
          expect(page).to.be.exist()
          expect(downloadLog.length).to.equal(1)
          expect(downloadLog[0].url).to.equal(`http://localhost:${httpServerPort}/release/v1.2.3/start-page.zip`)
        },
      })
    })

    it('should populate properties of file collected from zip', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: ['start-page'] }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/',
        before: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          expect(contentAggregate[0].files).to.be.empty()
        },
        after: ({ contentAggregate }) => {
          const bucket = contentAggregate[0]
          const files = bucket.files
          expect(files).to.have.lengthOf(1)
          expect(files[0]).to.have.property('stat')
          expect(files[0].src).to.eql({
            path: 'modules/ROOT/pages/index.adoc',
            relative: 'modules/ROOT/pages/index.adoc',
            abspath: 'modules/ROOT/pages/index.adoc',
            basename: 'index.adoc',
            stem: 'index',
            extname: '.adoc',
            origin: contentAggregate[0].origins[0],
            mediaType: 'text/asciidoc',
            zipFile: ospath.join(getCollectorCacheDir(), 'branch/main/start-page.zip'),
          })
        },
      })
    })

    it('should download zip and collect files with global HTTP headers', async () => {
      process.env.MY_SECRET = 'YWRtaW46c2VjcmV0'
      const extensionConfig = () => ({
        httpHeaders: { Authorization: 'Basic ${env.MY_SECRET}' },
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: ['start-page'] }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/',
        httpUsers: { admin: 'secret' },
        before: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          expect(contentAggregate[0].files).to.be.empty()
        },
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(1)
          expect(contentAggregate[0].files[0].src.path).to.equal('modules/ROOT/pages/index.adoc')
        },
      })
    })

    it('should download zip and collect files with location HTTP headers', async () => {
      process.env.MY_SECRET = 'YWRtaW46c2VjcmV0'
      const extensionConfig = () => ({
        locations: [
          {
            url: `http://localhost:${httpServerPort}/\${name}.zip`,
            httpHeaders: { Authorization: 'Basic ${env.MY_SECRET}' },
          },
        ],
      })
      const componentConfig = { include: ['start-page'] }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/',
        httpUsers: { admin: 'secret' },
        before: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          expect(contentAggregate[0].files).to.be.empty()
        },
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(1)
          expect(contentAggregate[0].files[0].src.path).to.equal('modules/ROOT/pages/index.adoc')
        },
      })
    })

    it('should download zip and collect files with global username / password', async () => {
      process.env.MY_PASSWORD = 'secret'
      const extensionConfig = () => ({
        username: 'admin',
        password: '${env.MY_PASSWORD}',
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: ['start-page'] }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/',
        httpUsers: { admin: 'secret' },
        before: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          expect(contentAggregate[0].files).to.be.empty()
        },
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(1)
          expect(contentAggregate[0].files[0].src.path).to.equal('modules/ROOT/pages/index.adoc')
        },
      })
    })

    it('should update component metadata from antora.yml file, if found in root', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: ['component-desc'] }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['component-desc'],
        httpPath: '/',
        before: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          const bucket = contentAggregate[0]
          expect(bucket.version).to.equal('main')
          expect(bucket.files).to.be.empty()
        },
        after: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          const bucket = contentAggregate[0]
          expect(bucket.version).to.equal('1.0.0')
          expect(bucket.title).to.equal('Test')
          expect(bucket.files).to.be.empty()
          expect(bucket).to.have.nested.property('asciidoc.attributes.url-api', 'https://api.example.org')
        },
      })
    })

    it('should not change name in component metadata if set in antora.yml', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: ['component-desc-with-bad-name'] }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['component-desc-with-bad-name'],
        httpPath: '/',
        before: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          const bucket = contentAggregate[0]
          expect(bucket.version).to.equal('main')
          expect(bucket.files).to.be.empty()
        },
        after: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          const bucket = contentAggregate[0]
          expect(bucket.name).to.equal('test')
        },
      })
    })

    it('should update component metadata from antora.yml file, if found in modules', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: ['modules-component-desc'] }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['modules-component-desc'],
        httpPath: '/',
        before: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          const bucket = contentAggregate[0]
          expect(bucket.version).to.equal('main')
          expect(bucket.files).to.be.empty()
        },
        after: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          const bucket = contentAggregate[0]
          expect(bucket.version).to.equal('1.0.0')
          expect(bucket.title).to.equal('Test')
          expect(bucket.files).to.be.empty()
          expect(bucket).to.have.nested.property('asciidoc.attributes.url-api', 'https://api.example.org')
        },
      })
    })

    it('should remove prerelease key if not specified in scanned antora.yml file', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: ['component-desc'] }
      await runScenario({
        repoName: 'test-at-root-prerelease',
        extensionConfig,
        componentConfig,
        zipFiles: ['component-desc'],
        httpPath: '/',
        before: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          const bucket = contentAggregate[0]
          expect(bucket.version).to.equal('')
          expect(bucket.prerelease).to.be.true()
          expect(bucket.files).to.be.empty()
        },
        after: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          const bucket = contentAggregate[0]
          expect(bucket.version).to.equal('1.0.0')
          expect(bucket.prerelease).to.be.undefined()
          expect(bucket.files).to.be.empty()
        },
      })
    })

    it('should cache etag and skip download zip and use cache to collect files', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: ['start-page'] }
      const downloadLog = []
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/',
        downloadLog,
        times: 2,
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(1)
          expect(contentAggregate[0].files[0].src.path).to.equal('modules/ROOT/pages/index.adoc')
          expect(downloadLog.length).to.equal(2)
          expect(downloadLog[0].statusCode).to.equal(200)
          expect(downloadLog[1].statusCode).to.equal(304)
        },
      })
    })

    it('should cache etag and skip download zip and use cache to collect files when has multiple urls', async () => {
      const extensionConfig = () => ({
        locations: [
          { url: `http://localhost:${httpServerPort}/missing/\${name}.zip` },
          { url: `http://localhost:${httpServerPort}/\${name}.zip` },
        ],
      })
      const componentConfig = { include: ['start-page'] }
      const downloadLog = []
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/',
        downloadLog,
        times: 2,
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(1)
          expect(contentAggregate[0].files[0].src.path).to.equal('modules/ROOT/pages/index.adoc')
          expect(downloadLog.length).to.equal(4)
          expect(downloadLog[0].statusCode).to.equal(404)
          expect(downloadLog[1].statusCode).to.equal(200)
          expect(downloadLog[2].statusCode).to.equal(404)
          expect(downloadLog[3].statusCode).to.equal(304)
        },
      })
    })

    it('should use local zip and collect files', async () => {
      const extensionConfig = () => ({
        locations: [{ url: 'build/missing/${name}.zip' }, { url: 'build/${name}.zip' }],
      })
      const componentConfig = { include: ['start-page'] }
      await runScenario({
        repoName: 'test-at-root',
        useLocalRepo: true,
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        before: async ({ contentAggregate }) => {
          const srcZipFile = ospath.join(tempDir, 'zips', 'start-page.zip')
          const origin = contentAggregate[0].origins[0]
          const worktree = url.fileURLToPath(origin.url)
          const dest = ospath.join(worktree, 'build')
          await fsp.mkdir(dest, { recursive: true })
          await fsp.copyFile(srcZipFile, ospath.join(dest, 'start-page.zip'))
          expect(contentAggregate).to.have.lengthOf(1)
          expect(contentAggregate[0].files).to.be.empty()
        },
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(1)
          expect(contentAggregate[0].files[0].src.path).to.equal('modules/ROOT/pages/index.adoc')
        },
      })
    })

    it('should ignore local zip and collect files from HTTP if not worktree', async () => {
      const extensionConfig = () => ({
        locations: [{ url: 'build/${name}.zip' }, { url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: ['start-page'] }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/',
        before: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          expect(contentAggregate[0].files).to.be.empty()
        },
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(1)
          expect(contentAggregate[0].files[0].src.path).to.equal('modules/ROOT/pages/index.adoc')
        },
      })
    })

    it('should replace contents of existing page', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: ['replace-start-page'] }
      let originalStat
      await runScenario({
        repoName: 'test-replace',
        extensionConfig,
        componentConfig,
        zipFiles: ['replace-start-page'],
        httpPath: '/',
        before: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          expect(contentAggregate[0].files).to.have.lengthOf(1)
          expect(contentAggregate[0].files[0].contents.toString()).to.include('= Stub Start Page')
          originalStat = contentAggregate[0].files[0].stat
        },
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(1)
          const expectedContents = heredoc`
            = Real Start Page

            This is the real deal.
          `
          expect(contentAggregate[0].files[0].contents.toString().replace(/\r/g, '')).to.equal(expectedContents + '\n')
          expect(contentAggregate[0].files[0].stat).to.not.equal(originalStat)
          expect(contentAggregate[0].files[0].stat.size).to.not.equal(originalStat.size)
          expect(contentAggregate[0].files[0].src).to.not.have.property('scanned')
        },
      })
    })

    it('should download zip and collect files when adding to content catalog', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: [{ name: 'javadoc', destination: 'content_catalog', path: 'api/java' }] }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['javadoc'],
        httpPath: '/',
        descriptorVersion: 'main',
        before: ({ contentAggregate, contentCatalog }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          expect(contentAggregate[0].files).to.be.empty()
        },
        after: ({ contentAggregate, contentCatalog }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(0)
          const files = contentCatalog.getFiles()
          const src = files[0].src
          expect(files.filter((file) => file.src.path === 'api/java/README')).to.have.lengthOf(1)
          expect(files.filter((file) => file.src.path === 'api/java/javadoc.css')).to.have.lengthOf(1)
          expect(files.filter((file) => file.src.path === 'api/java/javadoc.html')).to.have.lengthOf(1)
          expect(src.module).to.be.equal('ROOT')
          expect(src.family).to.be.equal('page')
          expect(src.component).to.be.equal('test')
          const htmlFile = files.filter((file) => file.src.path === 'api/java/javadoc.html')[0]
          expect(htmlFile.asciidoc.attributes['page-layout']).to.be.equal('bare')
        },
      })
    })

    it('should download zip and collect files when adding to content catalog with module', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = {
        include: [{ name: 'javadoc', destination: 'content_catalog', module: 'mymodule', path: 'api/java' }],
      }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['javadoc'],
        httpPath: '/',
        descriptorVersion: 'main',
        after: ({ contentAggregate, contentCatalog }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(0)
          const files = contentCatalog.getFiles()
          const src = files[0].src
          expect(files.filter((file) => file.src.path === 'api/java/README')).to.have.lengthOf(1)
          expect(files.filter((file) => file.src.path === 'api/java/javadoc.css')).to.have.lengthOf(1)
          expect(files.filter((file) => file.src.path === 'api/java/javadoc.html')).to.have.lengthOf(1)
          expect(src.module).to.be.equal('mymodule')
          expect(src.family).to.be.equal('page')
          expect(src.component).to.be.equal('test')
        },
      })
    })

    it('should download zip and collect files when adding to content catalog with layout', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = {
        include: [{ name: 'javadoc', destination: 'content_catalog', path: 'api/java', layout: 'javadoc' }],
      }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['javadoc'],
        httpPath: '/',
        descriptorVersion: 'main',
        before: ({ contentAggregate, contentCatalog }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          expect(contentAggregate[0].files).to.be.empty()
        },
        after: ({ contentAggregate, contentCatalog }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(0)
          const files = contentCatalog.getFiles()
          expect(files.filter((file) => file.src.path === 'api/java/javadoc.html')).to.have.lengthOf(1)
          const htmlFile = files.filter((file) => file.src.path === 'api/java/javadoc.html')[0]
          expect(htmlFile.asciidoc.attributes['page-layout']).to.be.equal('javadoc')
        },
      })
    })

    it('should create dedicated cache folder for collector under Antora cache dir', async () => {
      await fsp.mkdir(CACHE_DIR, { recursive: true })
      await fsp.writeFile(getCollectorCacheDir(), Buffer.alloc(0))
      expect(await trapAsyncError(() => runScenario({ repoName: 'test-at-root' }))).to.throw('file already exists')
    })

    it('should create cache folder under user cache if cache dir is not specified', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: ['start-page'] }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/',
        before: ({ playbook }) => {
          delete playbook.runtime.cacheDir
        },
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(1)
          expect(contentAggregate[0].files[0].src.zipFile.startsWith(getUserCacheDir('antora-test'))).to.be.true()
        },
      })
    })

    it('should remove older files from cache dir after run', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const cacheDir = getCollectorCacheDir()
      let fd
      const newerFile = ospath.join(cacheDir, 'newerfile')
      const olderFile = ospath.join(cacheDir, 'olderfile')
      await fsp.mkdir(cacheDir, { recursive: true })
      fd = await fsp.open(newerFile, 'w')
      fd.close()
      fd = await fsp.open(olderFile, 'w')
      fd.close()
      const time = new Date(new Date().setDate(new Date().getDate() - 65))
      await fsp.utimes(olderFile, time, time)
      expect(newerFile).to.be.a.path()
      expect(olderFile).to.be.a.path()
      await runScenario({ repoName: 'test-at-root', extensionConfig })
      expect(newerFile).to.be.a.path()
      expect(olderFile).to.not.be.a.path()
    })

    it('should add bare UI layout if missing', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: ['start-page'] }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/',
        before: ({ uiCatalog }) => {
          const layouts = uiCatalog.findByType('layout')
          expect(layouts).to.be.empty()
        },
        after: ({ uiCatalog }) => {
          const layouts = uiCatalog.findByType('layout')
          expect(layouts).to.have.lengthOf(1)
          expect(posixify(layouts[0].path)).to.be.equal('layouts/bare.hbs')
        },
      })
    })

    it('should not add bare UI layout if already in UI', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: ['start-page'] }
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/',
        before: ({ uiCatalog }) => {
          const file = new Vinyl({
            path: 'layouts/bare.hbs',
            contents: Buffer.from('test'),
          })
          file.type = 'layout'
          uiCatalog.addFile(file)
        },
        after: ({ uiCatalog }) => {
          const layouts = uiCatalog.findByType('layout')
          expect(layouts).to.have.lengthOf(1)
          expect(posixify(layouts[0].path)).to.be.equal('layouts/bare.hbs')
          expect(layouts[0].contents.toString()).to.be.equal('test')
        },
      })
    })

    it('should download zip and collect files when include is in playbook', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
        alwaysInclude: ['start-page'],
      })
      const componentConfig = {}
      await runScenario({
        repoName: 'test-at-root',
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/',
        before: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          expect(contentAggregate[0].files).to.be.empty()
        },
        after: ({ contentAggregate }) => {
          expect(contentAggregate[0].files).to.have.lengthOf(1)
          expect(contentAggregate[0].files[0].src.path).to.equal('modules/ROOT/pages/index.adoc')
        },
      })
    })

    it('should error on bad zip file', async () => {
      const extensionConfig = () => ({
        locations: [{ url: `http://localhost:${httpServerPort}/\${name}.zip` }],
      })
      const componentConfig = { include: ['bad-file'] }
      expect(
        await trapAsyncError(() =>
          runScenario({
            repoName: 'test-at-root',
            extensionConfig,
            componentConfig,
            zipFiles: ['bad-file'],
            httpPath: '/',
          })
        )
      ).to.throw('invalid central directory file header signature')
    })

    it('should drop content when 404 on branch when configured to do so', async () => {
      const extensionConfig = () => ({
        versionFile: 'gradle.properties',
        onMissingSnapshotZip: 'drop_content',
        locations: [{ url: `http://localhost:${httpServerPort}/v\${version}/\${name}.zip` }],
      })
      const componentConfig = { include: ['start-page'] }
      await runScenario({
        repoName: 'test-gradle-snapshot-version-file-at-root',
        tags: ['v1.2.2'],
        extensionConfig,
        componentConfig,
        zipFiles: ['start-page'],
        httpPath: '/v1.2.2',
        afterGit: async ({ repo }) => {
          await git.branch({ ...repo, ref: 'update' })
          await git.checkout({ ...repo, ref: 'update' })
          const gradleProperties = ospath.join(repo.dir, 'gradle.properties')
          let content = await fsp.readFile(gradleProperties, 'utf8')
          content = content.replace(/1.2.3-SNAPSHOT/g, '1.2.2')
          await fsp.writeFile(gradleProperties, content, 'utf8')
          await git.add({ ...repo, filepath: 'gradle.properties' })
          await git.commit({
            ...repo,
            author: { name: 'Tester', email: 'tester@example.org' },
            message: 'update version',
          })
          await git.tag({ ...repo, ref: 'v1.2.2', force: true })
          await git.deleteBranch({ ...repo, ref: 'update' })
          console.log('Hello')
        },
        after: ({ contentAggregate }) => {
          expect(contentAggregate).to.have.lengthOf(1)
          expect(contentAggregate[0].files).to.have.lengthOf(2)
          const page = contentAggregate[0].files.find((it) => it.src.path === 'modules/ROOT/pages/index.adoc')
          expect(page).to.be.exist()
        },
      })
    })

    async function runScenario ({
      repoName,
      branches,
      tags,
      startPath,
      useLocalRepo,
      extensionConfig,
      componentConfig,
      zipFiles,
      httpPath,
      httpUsers,
      downloadLog,
      times = 1,
      descriptorVersion = '1.0',
      afterGit,
      before,
      after,
    }) {
      const zipDir = await createZipDir(zipFiles)
      httpServer = httpServerPort = null
      if (httpPath) {
        ;[httpServer, httpServerPort] = await startHttpServer(httpPath, zipDir, httpUsers)
      }
      const repo = await createRepository({ repoName, branches, tags, startPath, componentConfig, afterGit })
      const playbook = {
        runtime: { cacheDir: CACHE_DIR, quiet: true },
        content: {
          sources: [
            {
              url: useLocalRepo ? repo.dir : repo.url,
              startPath,
              branches: branches || 'main',
              tags,
              worktrees: '.',
              editUrl: true,
            },
          ],
        },
      }
      let contentAggregate = await aggregateContent(playbook)
      const contentCatalog = new ContentCatalog()
      const uiCatalog = new UiCatalog()
      const descriptor = { name: 'test', version: descriptorVersion }
      contentCatalog.registerComponentVersion(descriptor.name, descriptor.version, descriptor)
      if (before) {
        const beforeParams = { contentAggregate, contentCatalog, uiCatalog, playbook }
        isAsync(before) ? await before(beforeParams) : before(beforeParams)
      }
      const generatorContext = createGeneratorContext()
      ext.register.call(generatorContext, {
        config: extensionConfig instanceof Function ? extensionConfig() : extensionConfig,
        downloadLog,
      })
      for (let index = 0; index < times; index++) {
        await generatorContext.contentAggregated({ playbook, contentAggregate })
        if (generatorContext?.variables?.contentAggregate) {
          contentAggregate = generatorContext.variables.contentAggregate
        }
        await generatorContext.contentClassified({ playbook, contentCatalog })
        await generatorContext.uiLoaded({ uiCatalog })
      }
      if (after) {
        const afterParams = { contentAggregate, contentCatalog, uiCatalog }
        isAsync(after) ? await after(afterParams) : after(afterParams)
      }
    }

    async function createRepository ({
      repoName,
      fixture = repoName,
      branches,
      tags,
      startPath,
      componentConfig,
      afterGit,
    }) {
      const repo = { dir: ospath.join(REPOS_DIR, repoName), fs }
      const links = []
      const captureLinks = function (src, dest) {
        if (!src.endsWith('-link')) return true
        return fsp.readFile(src, 'utf8').then((link) => {
          const [from, to] = link.trim().split(' -> ')
          this.push([ospath.join(ospath.dirname(dest), from), to])
          return false
        })
      }
      await fsp.cp(ospath.join(FIXTURES_REPOS_DIR, fixture), repo.dir, {
        recursive: true,
        filter: captureLinks.bind(links),
      })
      for (const [from, to] of links) {
        const type = to.endsWith('/') ? 'dir' : 'file'
        await fsp.symlink(type === 'dir' ? to.slice(0, -1) : to, from, type)
      }
      if (componentConfig) {
        const antoraYmlPath = ospath.join(repo.dir, startPath || '', 'antora.yml')
        await updateYamlFile(antoraYmlPath, {
          ext: {
            zip_contents_collector: componentConfig,
          },
        })
      }
      await git.init({ ...repo, defaultBranch: 'main' })
      await git
        .statusMatrix(repo)
        .then((status) =>
          Promise.all(
            status.map(([filepath, _, worktreeStatus]) =>
              worktreeStatus === 0 ? git.remove({ ...repo, filepath }) : git.add({ ...repo, filepath })
            )
          )
        )
      await git.commit({ ...repo, author: { name: 'Tester', email: 'tester@example.org' }, message: 'initial import' })
      if (branches) {
        for (const branch of branches) await git.branch({ ...repo, ref: branch })
      }
      if (tags) {
        for (const tag of tags) await git.tag({ ...repo, ref: tag })
      }
      repo.url = `http://localhost:${gitServerPort}/${repoName}/.git`
      if (afterGit) {
        const afterGitParams = { repo }
        isAsync(afterGit) ? await afterGit(afterGitParams) : afterGit(afterGitParams)
      }
      return repo
    }

    async function createZipDir (zipFiles) {
      const destDir = ospath.join(tempDir, 'zips')
      await fsp.mkdir(destDir, { recursive: true })
      if (zipFiles) {
        for (const zipFile of zipFiles) {
          const source = ospath.join(FIXTURES_ZIPS_DIR, zipFile)
          const dest = ospath.join(destDir, zipFile + '.zip')
          if ((await fsp.lstat(source)).isDirectory()) {
            await createZip(source, dest)
          } else {
            await fsp.copyFile(source, dest)
          }
        }
      }
      return destDir
    }

    const createGeneratorContext = () => ({
      require: () => git,
      once (eventName, fn) {
        this[eventName] = fn
      },
      getLogger: logger.getLogger,
      updateVariables (variables) {
        this.variables = variables
      },
    })

    const getCollectorCacheDir = () => {
      return ospath.join(CACHE_DIR, 'zip-contents-collector')
    }
  })
})
