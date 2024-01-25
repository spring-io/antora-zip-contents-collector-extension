/* eslint-env mocha */
'use strict'

const { expect } = require('@springio/antora-zip-contents-collector-test-harness')
const { classifyVersion } = require('../lib/util/version-classifier.js')

describe('version classifier', () => {
  it('should classify version', () => {
    expect(classifyVersion('1.2.3-SNAPSHOT')).to.equal('snapshot')
    expect(classifyVersion('1.2.3-M1')).to.equal('milestone')
    expect(classifyVersion('1.2.3-M2')).to.equal('milestone')
    expect(classifyVersion('1.2.3-M200')).to.equal('milestone')
    expect(classifyVersion('1.2.3-RC1')).to.equal('rc')
    expect(classifyVersion('1.2.3-RC2')).to.equal('rc')
    expect(classifyVersion('1.2.3-RC200')).to.equal('rc')
    expect(classifyVersion('1.2.3')).to.equal('release')
  })
})
