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
      ipfsd = await startIpfs(IPFS, ipfsConfig.daemon1)
      ipfs = ipfsd.api

      const address = 'test-address'
      const options = Object.assign({}, DefaultOptions, { cache })
      store = new Store(ipfs, testIdentity, address, options)
    })
    it('Specific log.op event', (done) => {
      const data = {
        op: 'SET',
        key: 'transaction',
        value: 'data'
      }
      store.events.on('log.op.SET', (id, address, payload) => {
        const { op, key, value } = payload
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
