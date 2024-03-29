import assert from 'assert'
import Store, { DefaultOptions } from '../src/Store.js'
import Cache from 'orbit-db-cache'
import Keystore from 'orbit-db-keystore'
import IdentityProvider from 'orbit-db-identity-provider'
import storageAdapter from 'orbit-db-storage-adapter'
// Test utils
import {
  config,
  testAPIs,
  startIpfs,
  stopIpfs
} from 'orbit-db-test-utils'

const storage = storageAdapter()

Object.keys(testAPIs).forEach((IPFS) => {
  describe(`Constructor ${IPFS}`, function () {
    let ipfs, testIdentity, identityStore, store, storeWithCache, cacheStore

    this.timeout(config.timeout)

    const ipfsConfig = Object.assign({}, config.defaultIpfsConfig, {
      repo: config.defaultIpfsConfig.repo + '-entry' + new Date().getTime()
    })

    before(async () => {
      identityStore = await storage.createStore('identity')
      const keystore = new Keystore(identityStore)

      cacheStore = await storage.createStore('cache')
      const cache = new Cache(cacheStore)

      testIdentity = await IdentityProvider.createIdentity({ id: 'userA', keystore })
      ipfs = await startIpfs(IPFS, ipfsConfig.daemon1)

      const address = 'test-address'
      store = new Store(ipfs, testIdentity, address, DefaultOptions)
      const options = Object.assign({}, DefaultOptions, { cache })
      storeWithCache = new Store(ipfs, testIdentity, address, options)
    })

    after(async () => {
      await store.close()
      await storeWithCache.close()
      await stopIpfs(ipfs)
      await identityStore.close()
      await cacheStore.close()
    })

    it('creates a new Store instance', async () => {
      assert.strictEqual(typeof store.options, 'object')
      assert.strictEqual(typeof store._type, 'string')
      assert.strictEqual(typeof store.id, 'string')
      assert.strictEqual(typeof store.address, 'string')
      assert.strictEqual(typeof store.dbname, 'string')
      assert.strictEqual(typeof store.events, 'object')
      assert.strictEqual(typeof store._ipfs, 'object')
      assert.strictEqual(typeof store._cache, 'undefined')
      assert.strictEqual(typeof store.access, 'object')
      assert.strictEqual(typeof store._oplog, 'object')
      assert.strictEqual(typeof store._index, 'object')
      assert.strictEqual(typeof store._replicationStatus, 'object')
      assert.strictEqual(typeof store._stats, 'object')
      assert.strictEqual(typeof store._replication, 'undefined')
      assert.strictEqual(typeof store._loader, 'object')
    })

    it('properly defines a cache', async () => {
      assert.strictEqual(typeof storeWithCache._cache, 'object')
    })
  })
})
