const assert = require('assert')
const Log = require('ipfs-log')

const Keystore = require('orbit-db-keystore')
const IdentityProvider = require('orbit-db-identity-provider')
const Replicator = require('../src/Replicator')

const {
  connectPeers,
  config,
  testAPIs,
  startIpfs,
  stopIpfs
} = require('orbit-db-test-utils')

// Tests timeout
const timeout = 30000

class DummyStore {
  constructor (log, ipfs, identity) {
    this._oplog = log
    this._ipfs = ipfs
    this.identity = identity
  }

  async close () {}
}

Object.keys(testAPIs).forEach((IPFS) => {
  describe(`Replicator, ${IPFS}`, function () {
    this.timeout(timeout)

    let log, ipfsd, ipfs, replicator, store, keystore, signingKeystore

    const { identityKeysPath } = config

    before(async () => {
      keystore = new Keystore(identityKeysPath)

      ipfsd = await startIpfs(IPFS, config.daemon1)
      ipfs = ipfsd.api
      const id = await ipfsd.api.id()

      const testIdentity = await IdentityProvider.createIdentity({ id, keystore })
      log = new Log(ipfs, testIdentity)

      store = new DummyStore(log, ipfs, testIdentity)
      replicator = new Replicator(store, 10)
    })

    after(async () => {
      await store.close()
      await stopIpfs(ipfsd)
      await replicator.stop()
      await keystore.close()
    })

    it('default options', async () => {
      assert.deepStrictEqual(replicator._buffer, [])
    })

    describe('concurrency = 1', function () {
      let ipfsd2, ipfs2, log2, store2

      this.timeout(timeout)

      const logLength = 100

      before(async () => {
        ipfsd2 = await startIpfs(IPFS, config.daemon2)
        ipfs2 = ipfsd2.api
        await connectPeers(ipfs, ipfs2)

        const testIdentity = await IdentityProvider.createIdentity({ id: 'userB', keystore, signingKeystore })
        log2 = new Log(ipfs2, testIdentity, { logId: log.id })

        console.log(`writing ${logLength} entries to the log`)
        for (let i = 0; i < logLength; i++) {
          await log2.append(`entry${i}`, 10)
        }
        assert(log2.values.length, logLength)

        store2 = new DummyStore(log2, ipfs2, testIdentity)
      })

      after(async () => {
        await store2.close()
        await stopIpfs(ipfsd2)
      })

      it('loads', (done) => {
        let replicated = 0

        assert.strictEqual(log.id, log2.id)

        replicator.load(log2.heads)

        assert.strictEqual(replicator._buffer.length, 0)
        assert.deepStrictEqual(replicator.getQueue()[0], log2.heads[0])
        assert.strictEqual(replicator.tasksQueued, 1)
        assert.strictEqual(replicator.tasksRequested, 1)
        assert.strictEqual(replicator.tasksStarted, 0) // ??

        replicator.on('load.progress', () => replicated++)
        replicator.on('load.end', async (replicatedLogs) => {
          assert.strictEqual(replicator.tasksStarted, replicated) // ??
          assert.strictEqual(replicator.tasksQueued, 0)
          assert.strictEqual(replicator.tasksFinished, replicated)
          for (const replicatedLog of replicatedLogs) {
            await log.join(replicatedLog)
          }

          if (log.values.length === logLength) {
            assert.deepStrictEqual(log.values, log2.values)
            done()
          }
        })
      })
    })
  })
})
