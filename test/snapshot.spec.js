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
  describe(`Snapshots ${IPFS}`, function () {
    let ipfs, testIdentity, identityStore, store, cacheStore

    this.timeout(config.timeout)

    const ipfsConfig = Object.assign({}, config.defaultIpfsConfig, {
      repo: config.defaultIpfsConfig.repo + '-entry' + new Date().getTime()
    })

    before(async () => {
      identityStore = await storage.createStore('identity')
      const keystore = new Keystore(identityStore)

      cacheStore = await storage.createStore('cache')
      const cache = new Cache(cacheStore)
      const identities = new IdentityProvider({ keystore })
      testIdentity = await identities.createIdentity({ id: 'userA' })
      ipfs = await startIpfs(IPFS, ipfsConfig)

      const address = 'test-address'
      const options = Object.assign({}, DefaultOptions, { cache })
      store = new Store(ipfs, identities, testIdentity, address, options)
    })

    after(async () => {
      await store.close()
      await stopIpfs(ipfs)
      await identityStore.close()
      await cacheStore.close()
    })

    afterEach(async () => {
      await store.drop()
      await cacheStore.open()
      await identityStore.open()
    })

    it('Saves a local snapshot', async () => {
      const writes = 10

      for (let i = 0; i < writes; i++) {
        await store._addOperation({ step: i })
      }
      const snapshot = await store.saveSnapshot()
      assert.strictEqual(snapshot[0].path.length, 46)
      assert.strictEqual(snapshot[0].hash.length, 46)
      assert.strictEqual(snapshot[0].path, snapshot[0].hash)
      assert.strictEqual(snapshot[0].size > writes * 200, true)
    })

    it('Successfully loads a saved snapshot', async () => {
      const writes = 10

      for (let i = 0; i < writes; i++) {
        await store._addOperation({ step: i })
      }
      await store.saveSnapshot()
      const storeFromSnapshot = await store.loadFromSnapshot()
      assert.strictEqual(storeFromSnapshot.index.length, 10)

      for (let i = 0; i < writes; i++) {
        assert.strictEqual(storeFromSnapshot.index[i].payload.step, i)
      }
    })
  })
})
