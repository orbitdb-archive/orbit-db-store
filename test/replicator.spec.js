import assert from 'assert'
import Log from 'ipfs-log'
import Keystore from 'orbit-db-keystore'
import IdentityProvider from 'orbit-db-identity-provider'
import Replicator from '../src/Replicator.js'
import {
  config,
  testAPIs,
  startIpfs,
  stopIpfs
} from 'orbit-db-test-utils'

// Tests timeout
const timeout = 30000

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

      replicator = new Replicator(store, 123)
    })

    after(async () => {
      await replicator.stop()
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
          assert.strictEqual(replicator.unfinished.length, 0)
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
