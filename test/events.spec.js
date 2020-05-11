'use strict'

var assert = require('assert')
const Store = require('../src/Store')

const Cache = require('orbit-db-cache')
const Keystore = require('orbit-db-keystore')
const IdentityProvider = require('orbit-db-identity-provider')
const DefaultOptions = Store.DefaultOptions

// Test utils
const {
  config,
  testAPIs,
  startIpfs,
  stopIpfs,
  implementations
} = require('orbit-db-test-utils')

const properLevelModule = implementations.filter(i => i.key.indexOf('memdown') > -1).map(i => i.module)[0]
const storage = require('orbit-db-storage-adapter')(properLevelModule)

Object.keys(testAPIs).forEach((IPFS) => {
  describe(`Events ${IPFS}`, function () {
    let ipfsd, ipfs, testIdentity, identityStore, store, cacheStore

    this.timeout(config.timeout)

    const ipfsConfig = Object.assign({}, config.defaultIpfsConfig, {
      repo: config.defaultIpfsConfig.repo + '-entry' + new Date().getTime()
    })
    after(async () => {
      await store.close()
      await stopIpfs(ipfsd)
      await identityStore.close()
      await cacheStore.close()
    })

    afterEach(async () => {
      await store.drop()
      await cacheStore.open()
      await identityStore.open()
    })

    before(async () => {
      identityStore = await storage.createStore('identity')
      const keystore = new Keystore(identityStore)

      cacheStore = await storage.createStore('cache')
      const cache = new Cache(cacheStore)

      testIdentity = await IdentityProvider.createIdentity({ id: 'userA', keystore })
      ipfsd = await startIpfs(IPFS, ipfsConfig)
      ipfs = ipfsd.api

      const address = 'test-address'
      const options = Object.assign({}, DefaultOptions, { cache })
      store = new Store(ipfs, testIdentity, address, options)
    })
    it('Specific log.op event', (done) => {
      var data = {
        op: 'SET',
        key: 'transaction',
        value: 'data'
      }
      store.events.on('log.op.SET', (id, address, payload) => {
        var { op, key, value } = payload
        assert.strictEqual(op, data.op)
        assert.strictEqual(key, data.key)
        assert.strictEqual(value, data.value)
        assert.strictEqual(id, 'test-address')
        done()
      })
      store._addOperation(data)
    })
  })
})
