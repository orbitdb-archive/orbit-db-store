'use strict'

const EventEmitter = require('events').EventEmitter
const mapSeries = require('p-each-series')
const Log = require('ipfs-log')
const Logger = require('logplease')
const Cache = require('orbit-db-cache')

const SnapshotManager = require('./snapshot-manager')
const StoreIndex = require('./Index')
const Replicator = require('./Replicator')
const ReplicationInfo = require('./replication-info')

const logger = Logger.create("orbit-db.store", { color: Logger.Colors.Blue })
Logger.setLogLevel('ERROR')

const DefaultOptions = {
  Index: StoreIndex,
  maxHistory: -1,
  path: './orbitdb',
  replicate: true,
  referenceCount: 64,
  replicationConcurrency: 128,
}

class Store extends EventEmitter {
  constructor(ipfs, peerId, address, options) {
    super()

    if (!ipfs) throw new Error('IPFS instance not defined')
    if (!peerId) throw new Error('Peer id is required')
    if (!address) throw new Error('Address is required')

    this._ipfs = ipfs
    // Default store type
    this._type = 'store'
    this.address = address
    this.dbname = address.path
    this.uid = peerId

    this.options = Object.assign({}, DefaultOptions, options)

    // Access controller
    const { accessController, key, keystore } = this.options
    if (!accessController) throw new Error('Access controller not defined')
    this._keystore = keystore
    this._key = key || this._keystore.getKey(peerId) || this._keystore.createKey(peerId)
    // FIX: duck typed interface
    this._ipfs.keystore = this._keystore
    // Access mapping
    const defaultAccess = {
      admin: [this._key.getPublic('hex')],
      read: [], // Not used atm, anyone can read
      write: [this._key.getPublic('hex')],
    }
    this.access = accessController || defaultAccess

    // Caching and Index
    const { cache, Index } = this.options
    this._cache = cache
    this._index = new Index(this.uid)

    // Create the operations log
    this._oplog = new Log(this._ipfs, this.address.toString(), null, null, null, this._key, this.access.write)

    // Statistics
    this._stats = {
      snapshot: {
        bytesLoaded: -1,
      },
      syncRequestsReceieved: 0,
    }

    // Replication progress info
    const { referenceCount, replicationConcurrency, replicate } = this.options
    this._replicationStatus = new ReplicationInfo()
    this._replicator = new Replicator(this, this.options.replicationConcurrency)
    this._replicator.on('load.added', this._onLoadAdded.bind(this))
    this._replicator.on('load.progress', this._onReplicatorLoadProgress.bind(this))
    this._replicator.on('load.end', this._onLoadCompleted.bind(this))
    this._snapshotManager = new SnapshotManager(this._ipfs, this, this._cache, this._replicator)

    this.emit('initialized', this)
  }

  _onReplicatorLoadProgress(id, hash, entry, have, bufferedLength) {
    const progress = this._replicationStatus.buffered > bufferedLength ? this._replicationStatus.progress + bufferedLength : this._oplog.length + bufferedLength
    this._recalculateReplicationProgress(progress)
    this._replicationStatus.buffered = bufferedLength
    this._recalculateReplicationMax(this._replicationStatus.progress)
    // logger.debug(`<replicate.progress>`)
    this.emit('replicate.progress', this.address.toString(), hash, entry, this._replicationStatus.progress, this._replicationStatus.max)
  }

  _onLoadAdded (entry) {
    // Update the latest entry state (latest is the entry with largest clock time)
    this._replicationStatus.queued ++
    const max = entry.clock ? entry.clock.time : 0
    this._recalculateReplicationMax(max)
    // logger.debug(`<replicate>`)
    this.emit('replicate', this.address.toString(), entry)
  }

  async _onLoadCompleted (logs, have) {
    try {
      for (let log of logs) {
        await this._oplog.join(log)
      }
      this._replicationStatus.queued -= logs.length
      this._replicationStatus.buffered = this._replicator._buffer.length
      await this._updateIndex()

      //only store heads that has been verified and merges
      const heads = this._oplog.heads
      await this._cache.set('_remoteHeads', heads)
      logger.debug(`Saved heads ${heads.length} [${heads.map(e => e.hash).join(', ')}]`)

      // logger.debug(`<replicated>`)
      this.emit('replicated', this.address.toString(), logs.length)
    } catch (e) {
      console.error("Store Error:", e)
    }
  }

  static async loadCache(path, address) {
    let cache
    try {
      cache = await Cache.load(path, address)
    } catch (e) {
      console.error(e)
      logger.error(`Couldn't load Cache: ${e}`)
    }

    return cache
  }

  static async loadManifest(path, address) {
    const cache = await Store.loadCache(path, address)
    return cache.get(path.join(address.toString(), '_manifest'))
  }

  static async saveManifest(path, address) {
    const cache = await Store.loadCache(path, address)
    await cache.set(path.join(address.toString(), '_manifest'), address.root)
    logger.debug(`Saved manifest to IPFS as '${address.root}'`)
  }

  get all () {
    return Array.isArray(this._index._index)
      ? this._index._index
      : Object.keys(this._index._index).map(e => this._index._index[e])
  }

  get type () {
    return this._type
  }

  get key () {
    return this._key
  }

  /**
   * Returns the database's current replication status information
   * @return {[Object]} [description]
   */
  get replicationStatus () {
    return this._replicationStatus
  }

  async close () {
    if (this.options.onClose)
      await this.options.onClose(this.address.toString())

    //Replicator teardown logic
    this._replicator.stop();

    // Reset replication statistics
    this._replicationStatus.reset()

    // Reset database statistics
    this._stats = {
      snapshot: {
        bytesLoaded: -1,
      },
      syncRequestsReceieved: 0,
    }

    // Remove all event listeners
    this.removeAllListeners('load')
    this.removeAllListeners('load.progress')
    this.removeAllListeners('replicate')
    this.removeAllListeners('replicate.progress')
    this.removeAllListeners('replicated')
    this.removeAllListeners('ready')
    this.removeAllListeners('write')

    // Close cache
    await this._cache.close()
  }

  /**
   * Drops a database and removes local data
   * @return {[None]}
   */
  async drop () {
    await this.close()
    await this._cache.destroy()
    // Reset
    this._index = new this.options.Index(this.uid)
    this._oplog = new Log(this._ipfs, this.address.toString(), null, null, null, this._key, this.access.write)
    this._cache = this.options.cache
  }

  async load (amount) {
    amount = amount || this.options.maxHistory

    const localHeads = await this._cache.get('_localHeads') || []
    const remoteHeads = await this._cache.get('_remoteHeads') || []
    const heads = localHeads.concat(remoteHeads)

    if (heads.length > 0)
      this.emit('load', this.address.toString(), heads)

    await mapSeries(heads, async (head) => {
      this._recalculateReplicationMax(head.clock.time)
      let log = await Log.fromEntryHash(this._ipfs, head.hash, this._oplog.id, amount, this._oplog.values, this._key, this.access.write, this._onLoadProgress.bind(this))
      await this._oplog.join(log, amount)
    })

    // Update the index
    if (heads.length > 0)
      await this._updateIndex()

    this.emit('ready', this.address.toString(), this._oplog.heads)
  }

  sync (heads) {
    this._stats.syncRequestsReceieved += 1
    logger.debug(`Sync request #${this._stats.syncRequestsReceieved} ${heads.length}`)

    if (heads.length === 0)
      return

    // To simulate network latency, uncomment this line
    // and comment out the rest of the function
    // That way the object (received as head message from pubsub)
    // doesn't get written to IPFS and so when the Replicator is fetching
    // the log, it'll fetch it from the network instead from the disk.
    // return this._replicator.load(heads)

    const saveToIpfs = (head) => {
      if (!head) {
        console.warn("Warning: Given input entry was 'null'.")
        return Promise.resolve(null)
      }

      if (!this.access.write.includes(head.key) && !this.access.write.includes('*')) {
        console.warn("Warning: Given input entry is not allowed in this log and was discarded (no write access).")
        return Promise.resolve(null)
      }

      // TODO: verify the entry's signature here

      const logEntry = Object.assign({}, head)
      logEntry.hash = null
      return this._ipfs.object.put(Buffer.from(JSON.stringify(logEntry)))
        .then((dagObj) => dagObj.toJSON().multihash)
        .then(hash => {
          // We need to make sure that the head message's hash actually
          // matches the hash given by IPFS in order to verify that the
          // message contents are authentic
          if (hash !== head.hash) {
            console.warn('"WARNING! Head hash didn\'t match the contents')
          }

          return hash
        })
        .then(() => head)
    }

    return mapSeries(heads, saveToIpfs)
      .then(async (saved) => {
          return this._replicator.load(saved.filter(e => e !== null))
      })
  }

  loadMoreFrom (amount, entries) {
    this._replicator.load(entries)
  }

  async saveSnapshot () {
    const unfinished = this._replicator.getQueue()
    return this._snapshotManager.saveSnapshot(this._ipfs, this._oplog, unfinished, this._type)
  }

  async loadFromSnapshot () {
    this.emit('load', this.address.toString())

    const queue = await this._cache.get('queue')
    await this.sync(queue || [])

    const snapshot = await this._snapshotManager.loadSnapshot(this._ipfs, this._cache, queue, this.address)
    if (snapshot) {
      const maxClock = (res, val) => Math.max(res, val.clock.time)
      this._recalculateReplicationMax(snapshot.values.reduce(maxClock, 0))
      // Fetch the entries
      // Timeout 1 sec to only load entries that are already fetched (in order to not get stuck at loading)
      const length = -1
      const timeout = 1000
      const log = await Log.fromJSON(
        this._ipfs,
        snapshot,
        length,
        this._key,
        this.access.write,
        timeout,
        (hash, entry, count) => {
          this._recalculateReplicationStatus(count, entry.clock.time)
          this._onLoadProgress(hash, entry)
        }
      )

      await this._oplog.join(log)
      await this._updateIndex()
      this.emit('replicated', this.address.toString())
    }

    this.emit('ready', this.address.toString(), this._oplog.heads)

    return this
  }

  async _updateIndex () {
    this._recalculateReplicationMax()
    await this._index.updateIndex(this._oplog)
    this._recalculateReplicationProgress()
  }

  async _addOperation (data, batchOperation, lastOperation, onProgressCallback) {
    if (this._oplog) {
      const entry = await this._oplog.append(data, this.options.referenceCount)
      this._recalculateReplicationStatus(this._replicationStatus.progress + 1, entry.clock.time)

      await this._cache.set('_localHeads', [entry])
      await this._updateIndex()

      this.emit('write', this.address.toString(), entry, this._oplog.heads)
      if (onProgressCallback) onProgressCallback(entry)

      return entry.hash
    }
  }

  _addOperationBatch (data, batchOperation, lastOperation, onProgressCallback) {
    throw new Error("Not implemented!")
  }

  _onLoadProgress (hash, entry, progress, total) {
    this._recalculateReplicationStatus(progress, total)
    this.emit('load.progress', this.address.toString(), hash, entry, this._replicationStatus.progress, this._replicationStatus.max)
  }

  /* Replication Status state updates */

  _recalculateReplicationProgress (max) {
    this._replicationStatus.progress = Math.max.apply(null, [
      this._replicationStatus.progress,
      this._oplog.length,
      max || 0,
    ])
    this._recalculateReplicationMax(this._replicationStatus.progress)
  }

  _recalculateReplicationMax (max) {
    this._replicationStatus.max = Math.max.apply(null, [
      this._replicationStatus.max,
      this._oplog.length,
      max || 0,
    ])
  }

  _recalculateReplicationStatus (maxProgress, maxTotal) {
    this._recalculateReplicationProgress(maxProgress)
    this._recalculateReplicationMax(maxTotal)
  }
}

module.exports = Store
