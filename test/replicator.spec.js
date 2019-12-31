const assert = require('assert')
const Log = require('ipfs-log')

const Keystore = require('orbit-db-keystore')
const IdentityProvider = require('orbit-db-identity-provider')
const Replicator = require('../src/Replicator')

const {
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
      replicator = new Replicator(store, 123)
    })

    after(async () => {
      await replicator.stop()
      await store.close()
      await stopIpfs(ipfsd)
      await keystore.close()
    })

    it('default options', async () => {
      assert.deepStrictEqual(replicator._logs, [])
    })

    describe('concurrency = 123', function () {
      let log2

      this.timeout(timeout)

      const logLength = 100

      before(async () => {
        const testIdentity = await IdentityProvider.createIdentity({ id: 'userB', keystore, signingKeystore })
        log2 = new Log(ipfs, testIdentity, { logId: log.id })

        console.log(`writing ${logLength} entries to the log`)
        for (let i = 0; i < logLength; i++) {
          await log2.append(`entry${i}`, 123)
        }
        assert(log2.values.length, logLength)
      })

      it('replicates all entries in the log', async () => {
        let replicated = 0
        assert.strictEqual(log.id, log2.id)

        assert.strictEqual(replicator._logs.length, 0)
        assert.strictEqual(replicator.tasksQueued, 0)

        replicator.onReplicationProgress = () => replicated++
        replicator.onReplicationComplete = async (replicatedLogs) => {
          assert.strictEqual(replicator.tasksRunning, 0)
          assert.strictEqual(replicator.tasksQueued, 0)
          assert.strictEqual(replicator.unfinished, 0)
          for (const replicatedLog of replicatedLogs) {
            await log.join(replicatedLog)
          }
          assert.strictEqual(log.values.length, logLength)
          assert.deepStrictEqual(log.values, log2.values)
        }

        replicator.load(log2.heads)
      })
    })
  })
})
