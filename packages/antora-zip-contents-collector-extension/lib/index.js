'use strict'

const { classifyVersion } = require('../lib/util/version-classifier.js')
const { ZipReadable } = require('../lib/util/file.js')
const ospath = require('path')
const getUserCacheDir = require('cache-directory')
const expandPath = require('@antora/expand-path-helper')
const fs = require('fs')
const { promises: fsp } = fs
const git = require('isomorphic-git')
const mimeTypes = require('mime-types')
const { concat: get } = require('simple-get')
const { pipeline, PassThrough, Transform, Writable } = require('stream')
const Vinyl = require('vinyl')
const { XMLParser } = require('fast-xml-parser')
const yaml = require('js-yaml')
const yauzl = require('yauzl')

const forEach = (write, final) => new Writable({ objectMode: true, write, final })
const map = (transform) => new Transform({ objectMode: true, transform })
const posixify = ospath.sep === '\\' ? (p) => p.replace(/\\/g, '/') : (p) => p
const through = () => new PassThrough({ objectMode: true })

const gradleVersionRegex = /^version\s*=\s*(.*)$/m

const DAYS = 60 * 60 * 24
const CACHE_RETENTION = 60 * DAYS

function register ({ config, downloadLog }) {
  const logger = this.getLogger('zip-contents-collector-extension')
  const catalogIncludes = new Map()
  this.once('contentAggregated', (contextVariables) =>
    contentAggregated.call(this, contextVariables, config, downloadLog)
  )
  this.once('contentClassified', (contextVariables) =>
    contentClassified.call(this, contextVariables, config, downloadLog)
  )
  this.once('uiLoaded', (contextVariables) => uiLoaded.call(this, contextVariables))

  async function contentAggregated ({ playbook, contentAggregate }, config, downloadLog) {
    logger.trace('Checking content aggregate for zip contents collector includes')
    const collectorCacheDir = await getCollectorCacheDir(playbook)
    logger.trace(`Using cache dir ${collectorCacheDir}`)
    const componentVersionBucketsToDrop = []
    // First apply content_aggregate includes since they may update the version
    for (const componentVersionBucket of contentAggregate) {
      for (const origin of componentVersionBucket.origins) {
        const version = await readVersion(origin, config.versionFile)
        try {
          await addContentAggregateIncludes(
            config,
            downloadLog,
            origin,
            version,
            collectorCacheDir,
            componentVersionBucket
          )
        } catch (error) {
          handleContentAggregatedError(
            config,
            origin,
            version,
            componentVersionBucket,
            error,
            componentVersionBucketsToDrop
          )
        }
      }
    }
    // Once the version is set we can collect content_catalog includes
    for (const componentVersionBucket of contentAggregate) {
      const key = componentVersionBucket.version + '@' + componentVersionBucket.name
      for (const origin of componentVersionBucket.origins) {
        const version = await readVersion(origin, config.versionFile)
        try {
          await collectContentCatalogIncludes(config, downloadLog, collectorCacheDir, origin, version, key)
        } catch (error) {
          handleContentAggregatedError(
            config,
            origin,
            version,
            componentVersionBucket,
            error,
            componentVersionBucketsToDrop
          )
        }
      }
    }
    if (componentVersionBucketsToDrop.length > 0) {
      const updatedContentAggregate = contentAggregate.filter(
        (candidate) => !componentVersionBucketsToDrop.includes(candidate)
      )
      this.updateVariables({ contentAggregate: updatedContentAggregate })
    }
  }

  async function addContentAggregateIncludes (
    config,
    downloadLog,
    origin,
    version,
    collectorCacheDir,
    componentVersionBucket
  ) {
    const includes = getIncludes(
      config,
      origin,
      (include) =>
        !include.destination ||
        include.destination.toLowerCase() === 'content-aggregate' ||
        include.destination.toLowerCase() === 'content_aggregate'
    )
    if (includes.length > 0) {
      logger.trace(`Adding '${origin.refname}' aggregate includes ${includes.map((include) => include.name)}`)
      await doWithIncludes(config, downloadLog, collectorCacheDir, version, includes, (include, zipFile, file) =>
        addToContentAggregate(componentVersionBucket, include, zipFile, file)
      )
    }
  }

  async function collectContentCatalogIncludes (config, downloadLog, collectorCacheDir, origin, version, key) {
    const includes = getIncludes(
      config,
      origin,
      (include) =>
        include.destination &&
        (include.destination.toLowerCase() === 'content_catalog' ||
          include.destination.toLowerCase() === 'content-catalog')
    )
    logger.trace(`Collecting '${origin.refname}' content catalog includes ${includes.map((include) => include.name)}`)
    await doWithIncludes(config, downloadLog, collectorCacheDir, version, includes, (include, zipFile, file) =>
      logger.trace(`Prepared ${file.path} for addition to content catalog`)
    )
    if (includes.length > 0) {
      logger.trace(
        `Storing '${origin.refname}' content includes [${includes.map((include) => include.name)}] under '${key}'`
      )
      const includesForKey = (catalogIncludes.has(key) ? catalogIncludes : catalogIncludes.set(key, [])).get(key)
      includesForKey.push(...includes)
    }
  }

  function handleContentAggregatedError (
    config,
    origin,
    version,
    componentVersionBucket,
    error,
    componentVersionBucketsToDrop
  ) {
    if (config.onMissingSnapshotZip === 'drop_content') {
      logger.trace(`Considering if '${origin.refname}' content can be dropped`)
      if (origin.reftype === 'branch' && version && version.endsWith('-SNAPSHOT') && isHttpNotFoundError(error)) {
        logger.trace(`Dropping '${origin.refname}' content for due to HTTP not found error`)
        componentVersionBucketsToDrop.push(componentVersionBucket)
        return
      }
    }
    throw error
  }

  function isHttpNotFoundError (error) {
    if (error && error.name === 'HTTPError' && error.statusCode === 404) {
      return true
    }
    if (error instanceof AggregateError) {
      return error.errors.every((candidate) => isHttpNotFoundError(candidate))
    }
    return false
  }

  async function contentClassified ({ playbook, contentCatalog }, config, downloadLog) {
    const collectorCacheDir = await getCollectorCacheDir(playbook)
    for (const component of contentCatalog.getComponents()) {
      for (const version of component.versions) {
        const key = version.version + '@' + version.name
        const includes = catalogIncludes.get(key)
        if (includes && includes.length > 0) {
          logger.trace(`Adding '${key}' content includes [${includes.map((include) => include.name)}]`)
          await doWithIncludes(
            config,
            downloadLog,
            collectorCacheDir,
            version.displayVersion,
            includes,
            (include, zipFile, file) => addToContentCatalog(contentCatalog, component, version, include, zipFile, file)
          )
        } else {
          logger.trace(`Content catalog component ${key} did not match any includes`)
        }
      }
    }
    await cleanupCollectorCacheDir(collectorCacheDir)
  }

  async function uiLoaded ({ uiCatalog }) {
    const layouts = uiCatalog.findByType('layout')
    if (layouts.filter((file) => posixify(file.path) === 'layouts/bare.hbs').length === 0) {
      logger.trace("Adding 'bare' layout to UI catalog")
      const file = new Vinyl({
        path: 'layouts/bare.hbs',
        contents: Buffer.from('{{{page.contents}}}'),
      })
      file.type = 'layout'
      uiCatalog.addFile(file)
    }
  }

  async function getCollectorCacheDir (playbook) {
    const cacheDir = ospath.join(getBaseCacheDir(playbook), 'zip-contents-collector')
    await fsp.mkdir(cacheDir, { recursive: true })
    return cacheDir
  }

  function getBaseCacheDir ({ dir: dot, runtime: { cacheDir } }) {
    return cacheDir
      ? expandPath(cacheDir, { dot })
      : getUserCacheDir(`antora${process.env.NODE_ENV === 'test' ? '-test' : ''}`) || ospath.join(dot, '.cache/antora')
  }

  function getIncludes (config, origin, filter) {
    const originConfig = origin.descriptor?.ext?.zip_contents_collector
    const alwaysIncludes = config && asArray(config.alwaysInclude)
    const originIncludes = originConfig && asArray(originConfig.include)
    let includes = alwaysIncludes || []
    if (originConfig) includes = includes.concat(...originIncludes)
    if (includes.length === 0) return []
    includes = includes
      .map((include) => (include.name ? include : { name: include }))
      .map((include) => ({ ...include, origin }))
      .filter(filter)
    for (const include of includes) {
      if (!include.name) throw new Error("Zip contents extension include must include a 'name'")
    }
    return includes
  }

  async function doWithIncludes (config, downloadLog, collectorCacheDir, version, includes, action) {
    for (const include of includes) {
      const { name, origin } = include
      const versionClassification = classifyVersion(version)
      logger.trace(
        `Processing zip contents include '${name}' to ${origin.reftype} '${origin.refname}'${
          version ? ' (' + version + ')' : ''
        }`
      )
      const downloadCacheDir = ospath.join(collectorCacheDir, origin.reftype, origin.refname)
      await fsp.mkdir(downloadCacheDir, { recursive: true })
      const locations = asArray(config.locations).map((location) => (location.url ? location : { url: location }))
      const locationVariables = { name, version, classifier: include.classifier }
      const zipFile = await getZipFile(
        config,
        downloadLog,
        name,
        locations,
        locationVariables,
        downloadCacheDir,
        origin.worktree,
        versionClassification
      )
      if (zipFile) {
        await doWithZipContents(zipFile, (file) => {
          file.isDirectory() || action(include, zipFile, file)
        })
      }
    }
  }

  async function getZipFile (
    config,
    downloadLog,
    name,
    locations,
    locationVariables,
    downloadCacheDir,
    worktree,
    versionClassification
  ) {
    const downloadErrors = []
    for (const location of locations) {
      if (considerLocation(location, versionClassification)) {
        const url = resolvePlaceholders(location.url, locationVariables)
        const username = resolvePlaceholders(location.username || config.username)
        const password = resolvePlaceholders(location.password || config.password)
        const httpHeaders = { ...config.httpHeaders, ...location.httpHeaders }
        if (username || password) {
          const credentials = Buffer.from(`${username ?? ''}:${password ?? ''}`).toString('base64')
          httpHeaders.Authorization = `Basic ${credentials}`
        }
        if (['http:', 'https:'].some((prefix) => url.toLowerCase().startsWith(prefix))) {
          try {
            return await download(name, url, httpHeaders, downloadCacheDir, downloadLog)
          } catch (downloadError) {
            downloadErrors.push(downloadError)
          }
        } else {
          if (!worktree) {
            logger.trace(`Skipping local file URL ${url} due to missing worktree`)
            continue
          }
          const localFile = ospath.join(worktree, ...url.split('/'))
          if (fs.existsSync(localFile)) return localFile
        }
      }
    }
    throwIfNecessary(`Unable to download '${name}' from any location`, downloadErrors)
  }

  function considerLocation (location, versionClassification) {
    const versionTypes = asArray(location.forVersionType)
    const result =
      versionTypes.length === 0 ||
      versionTypes.map((element) => element.toLowerCase().trim()).includes(versionClassification)
    logger.trace(`Evaluated '${location.url}' versionTypes='${versionTypes}' to ${result}`)
    return result
  }

  async function readVersion (origin, versionFile) {
    if (!versionFile) {
      return null
    }
    logger.trace(`Reading version information from ${versionFile}`)
    if (origin.worktree) {
      const content = await fsp.readFile(ospath.join(origin.worktree, ...versionFile.split('/')), {
        encoding: 'utf-8',
      })
      return extractVersion(versionFile, content)
    }
    const repo = { fs, gitdir: origin.gitdir, noCheckout: true, url: origin.url }
    let { tree } = await git.readTree(Object.assign({ oid: origin.refhash }, repo))
    const path = config.versionFile.split('/')
    let node
    while (path.length) {
      const name = path.shift()
      node = tree.find((node) => node.path === name)
      ;({ tree } = path.length > 0 && (await git.readTree(Object.assign({ oid: node.oid }, repo))))
    }
    const { blob } = await git.readBlob(Object.assign({ oid: node.oid }, repo))
    return extractVersion(versionFile, new TextDecoder().decode(blob))
  }

  function extractVersion (versionFile, contents) {
    logger.trace(`Extracting version from '${versionFile}'`)
    if (versionFile.toLowerCase().endsWith('gradle.properties')) {
      const match = gradleVersionRegex.exec(contents)
      const version = match && match[1]
      if (!version) throw new Error(`Unable to find 'version=<value>' in Gradle file '${versionFile}'`)
      return version
    }
    if (versionFile.toLowerCase().endsWith('pom.xml')) {
      const xml = new XMLParser().parse(contents)
      const version = xml?.project?.version
      if (!version) throw new Error(`Unable to find 'version' in Maven file '${versionFile}'`)
      return version
    }
    throw new Error(`Unable to extract 'version' from unsupported file type '${versionFile}'`)
  }

  async function download (name, url, headers, dir, downloadLog) {
    const file = ospath.join(dir, name + '.zip')
    const cacheFile = ospath.join(dir, name + '.cache')
    logger.trace(`Attempting download of '${url}' to '${file}'`)
    let cache
    try {
      await fsp.stat(file)
      cache = JSON.parse(await fsp.readFile(cacheFile, 'utf8'))
    } catch (_) {}
    if (!cache || cache.url !== url) {
      cache = { url }
    }
    headers = headers && resolveHeaderPlaceholders(headers)
    if (cache && cache.etag) {
      headers['if-none-match'] = cache.etag
    }
    const { response, contents } = await new Promise((resolve, reject) => {
      get({ url, headers }, (err, response, contents) => {
        if (err) {
          const message = `Unable to download '${url}'`
          logger.trace(message)
          if (err instanceof AggregateError) {
            return reject(
              new AggregateError(
                err.errors,
                message + ':\n' + err.errors.map((error) => `- ${error.message}` + '\n').join('')
              )
            )
          }
          return reject(new Error(message + ` ${err.message}`, { cause: err }))
        }
        return resolve({ response, contents })
      })
    })
    if (downloadLog) {
      downloadLog.push({ url, statusCode: response.statusCode })
    }
    if (response.statusCode === 304) {
      logger.trace(`Existing cache used for download of '${url}' to '${file}'`)
      try {
        const time = new Date()
        fsp.utimes(file, time, time)
        fsp.utimes(cacheFile, time, time)
      } catch (_) {}
      return file
    }
    cache.etag = response.headers.etag
    if (response.statusCode !== 200) {
      const message = `Unable to download '${url}' due to HTTP response code ${response.statusCode} (${response.statusMessage})`
      logger.trace(message)
      throw Object.assign(new Error(message), { name: 'HTTPError', statusCode: response.statusCode })
    }
    await fsp.writeFile(file, contents)
    await fsp.writeFile(cacheFile, JSON.stringify(cache))
    logger.trace(`Downloaded '${url}' to '${file}'`)
    return file
  }

  function resolveHeaderPlaceholders (headers) {
    return Object.fromEntries(Object.entries(headers).map(([k, v]) => [k, resolvePlaceholders(v)]))
  }

  function resolvePlaceholders (str, variables) {
    if (!str) return str
    variables = variables || {}
    variables = { ...variables, env: process.env }
    return str.replace(/\${(.*?)}/g, (match, name) => {
      const parts = name.split('.')
      let result = variables
      while (result && parts.length > 0) {
        result = result[parts.shift()]
      }
      return result || match
    })
  }

  function doWithZipContents (zipFile, action) {
    return new Promise((resolve, reject) => {
      srcZip(zipFile)
        .on('error', (err) => reject(new Error(`Error unzipping ${zipFile}: ${err.message}`, { cause: err })))
        .pipe(bufferizeContents())
        .on('error', reject)
        .pipe(
          forEach(
            (file, _, done) => action(file) || done(),
            (done) => done() || resolve()
          )
        )
        .on('error', reject)
    })
  }

  function srcZip (file) {
    const result = through()
    yauzl.open(file, { lazyEntries: true }, (err, zipFile) => {
      if (err) return result.emit('error', err)
      new ZipReadable(zipFile).on('error', (err) => result.emit('error', err)).pipe(result)
    })
    return result
  }

  function bufferizeContents () {
    return map((file, _, next) => {
      if (file.isStream()) {
        const buffer = []
        pipeline(
          file.contents,
          forEach((chunk, _, done) => buffer.push(chunk) && done()),
          (err) => (err ? next(err) : next(null, Object.assign(file, { contents: Buffer.concat(buffer) })))
        )
      } else {
        next(null, file)
      }
    })
  }

  function addToContentAggregate (componentVersionBucket, include, zipFile, file) {
    let destination = include.module && ospath.join('modules', include.module)
    destination = include.path && (destination ? ospath.join(destination, include.path) : include.path)
    file = asAntoraFile(include, zipFile, file, destination)
    logger.trace(`Adding ${file.path} to content aggregate`)
    const existing = componentVersionBucket.files.find((candidate) => candidate.src.path === file.src.path)
    if (file.src.path === 'antora.yml' || file.src.path === 'modules/antora.yml') {
      const generated = yaml.load(file.contents)
      if (generated.name && componentVersionBucket.name !== generated.name) {
        delete generated.name
      }
      Object.assign(componentVersionBucket, generated)
      if (!('prerelease' in generated)) delete componentVersionBucket.prerelease
    } else if (existing) {
      Object.assign(existing, { contents: file.contents, stat: file.stat })
    } else {
      componentVersionBucket.files.push(file)
    }
  }

  function addToContentCatalog (contentCatalog, component, version, include, zipFile, file) {
    const moduleName = include.module || 'ROOT'
    const pageLayout = include.layout || 'bare'
    file = asAntoraFile(include, zipFile, file, include.path, 'application/octet-stream', {
      component: component.name,
      version: version.version,
      module: moduleName,
      family: 'page',
    })
    const pageAttributes = {
      'page-layout': pageLayout,
      'page-component-name': component.name,
      'page-component-version': version.version,
      'page-version': version.version,
      'page-component-display-version': version.displayVersion,
      'page-component-title': component.title,
      'page-module': moduleName,
      'page-relative': file.src.path,
      'page-origin-type': file.src.origin.type,
      'page-origin-url': file.src.origin.url,
    }
    file.asciidoc = { attributes: pageAttributes }
    logger.trace(`Adding ${file.path} to content catalog`)
    contentCatalog.addFile(file)
  }

  function asAntoraFile (include, zipFile, file, destination, fallbackMediaType, src) {
    const path = posixify(destination ? ospath.join(destination, file.path) : file.path)
    const basename = ospath.basename(path)
    const extname = ospath.extname(path)
    const stem = basename.slice(0, basename.length - extname.length)
    const mediaType = mimeTypes.lookup(extname) || fallbackMediaType
    src = {
      origin: include.origin,
      path,
      basename,
      stem,
      extname,
      abspath: path,
      relative: path,
      mediaType,
      zipFile,
      ...src,
    }
    return { path, contents: file.contents, stat: file.stat, src }
  }

  async function cleanupCollectorCacheDir (collectorCacheDir) {
    const currentTime = Math.floor(new Date().getTime() / 1000)
    const candidates = await fsp.readdir(collectorCacheDir, { recursive: true })
    for (const candidate of candidates) {
      const path = ospath.join(collectorCacheDir, candidate)
      const stats = await fsp.stat(path)
      if (stats.isFile() && currentTime - Math.floor(stats.mtimeMs / 1000) > CACHE_RETENTION) {
        logger.trace(`Removing cache file ${path}`)
        await fsp.rm(path)
      }
    }
  }

  function throwIfNecessary (message, errors) {
    if (errors.length === 1) throw errors[0]
    if (errors.length > 0) {
      throw new AggregateError(errors, message + ':\n' + errors.map((error) => `- ${error.message}` + '\n').join(''))
    }
  }

  function asArray (obj) {
    return obj ? (Array.isArray(obj) ? obj : [obj]) : []
  }
}

module.exports = { register }
