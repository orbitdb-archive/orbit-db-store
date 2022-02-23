'use strict'

const path = require('path')
const EventEmitter = require('events').EventEmitter
const mapSeries = require('p-each-series')
const { default: PQueue } = require('p-queue')
const Log = require('ipfs-log')
const Entry = Log.Entry
const Index = require('./Index')
const Replicator = require('./Replicator')
const ReplicationInfo = require('./replication-info')

const Logger = require('logplease')
const logger = Logger.create('orbit-db.store', { color: Logger.Colors.Blue })
Logger.setLogLevel('ERROR')
const io = require('orbit-db-io')

const DefaultOptions = {
  Index: Index,
  maxHistory: -1,
  fetchEntryTimeout: null,
  referenceCount: 32,
  replicationConcurrency: 32,
  syncLocal: false,
  sortFn: undefined
}

class Store {
  constructor (ipfs, identity, address, options) {
    if (!identity) {
      throw new Error('Identity required')
    }

    // Set the options
    const opts = Object.assign({}, DefaultOptions)
    Object.assign(opts, options)
    this.options = opts

    // Default type
    this._type = 'store'

    // Create IDs, names and paths
    this.id = address.toString()
    this.identity = identity
    this.address = address
    this.dbname = address.path || ''
    this.events = new EventEmitter()

    this.remoteHeadsPath = path.join(this.id, '_remoteHeads')
    this.localHeadsPath = path.join(this.id, '_localHeads')
    this.snapshotPath = path.join(this.id, 'snapshot')
    this.queuePath = path.join(this.id, 'queue')
    this.manifestPath = path.join(this.id, '_manifest')

    // External dependencies
    this._ipfs = ipfs
    this._cache = options.cache

    // Access mapping
    const defaultAccess = {
      canAppend: (entry) => (entry.identity.publicKey === identity.publicKey)
    }
    this.access = options.accessController || defaultAccess

    // Create the operations log
    this._oplog = new Log(this._ipfs, this.identity, { logId: this.id, access: this.access, sortFn: this.options.sortFn })

    // _addOperation and log-joins queue. Adding ops and joins to the queue
    // makes sure they get processed sequentially to avoid race conditions
    // between writes and joins (coming from Replicator)
    this._queue = new PQueue({ concurrency: 1 })

    // Create the index
    this._index = new this.options.Index(this.address.root)

    // Replication progress info
    this._replicationStatus = new ReplicationInfo()

    // Statistics
    this._stats = {
      snapshot: {
        bytesLoaded: -1
      },
      syncRequestsReceieved: 0
    }

    try {
      const onReplicationQueued = async (entry) => {
        // Update the latest entry state (latest is the entry with largest clock time)
        this._recalculateReplicationMax(entry.clock ? entry.clock.time : 0)
        this.events.emit('replicate', this.address.toString(), entry)
      }

      const onReplicationProgress = async (entry) => {
        const previousProgress = this.replicationStatus.progress
        const previousMax = this.replicationStatus.max
        this._recalculateReplicationStatus(entry.clock.time)
        if (this._oplog.length + 1 > this.replicationStatus.progress ||
          this.replicationStatus.progress > previousProgress ||
          this.replicationStatus.max > previousMax) {
          this.events.emit('replicate.progress', this.address.toString(), entry.hash, entry, this.replicationStatus.progress, this.replicationStatus.max)
        }
      }

      const onReplicationComplete = async (logs) => {
        const updateState = async () => {
          try {
            if (this._oplog && logs.length > 0) {
              for (const log of logs) {
                await this._oplog.join(log)
              }

              // only store heads that has been verified and merges
              const heads = this._oplog.heads
              await this._cache.set(this.remoteHeadsPath, heads)
              logger.debug(`Saved heads ${heads.length} [${heads.map(e => e.hash).join(', ')}]`)

              // update the store's index after joining the logs
              // and persisting the latest heads
              await this._updateIndex()

              if (this._oplog.length > this.replicationStatus.progress) {
                this._recalculateReplicationStatus(this._oplog.length)
              }

              this.events.emit('replicated', this.address.toString(), logs.length, this)
            }
          } catch (e) {
            console.error(e)
          }
        }
        await this._queue.add(updateState.bind(this))
      }
      // Create the replicator
      this._replicator = new Replicator(this, this.options.replicationConcurrency)
      // For internal backwards compatibility,
      // to be removed in future releases
      this._loader = this._replicator
      // Hook up the callbacks to the Replicator
      this._replicator.onReplicationQueued = onReplicationQueued
      this._replicator.onReplicationProgress = onReplicationProgress
      this._replicator.onReplicationComplete = onReplicationComplete
    } catch (e) {
      console.error('Store Error:', e)
    }
    // TODO: verify if this is working since we don't seem to emit "replicated.progress" anywhere
    this.events.on('replicated.progress', (address, hash, entry, progress, have) => {
      this._procEntry(entry)
    })
    this.events.on('write', (address, entry, heads) => {
      this._procEntry(entry)
    })
  }

  get all () {
    return Array.isArray(this._index._index)
      ? this._index._index
      : Object.keys(this._index._index).map(e => this._index._index[e])
  }

  get index () {
    return this._index._index
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

  setIdentity (identity) {
    this.identity = identity
    this._oplog.setIdentity(identity)
  }

  async close () {
    this._oplog = null

    // Stop the Replicator
    await this._replicator.stop()

    // Wait for the operations queue to finish processing
    // to make sure everything that all operations that have
    // been queued will be written to disk
    await this._queue.onIdle()

    // Reset replication statistics
    this._replicationStatus.reset()

    // Reset database statistics
    this._stats = {
      snapshot: {
        bytesLoaded: -1
      },
      syncRequestsReceieved: 0
    }

    if (this.options.onClose) {
      await this.options.onClose(this)
    }

    // Close store access controller
    if (this.access.close) {
      await this.access.close()
    }

    // Remove all event listeners
    for (const event in this.events._events) {
      this.events.removeAllListeners(event)
    }

    // Database is now closed
    // TODO: afaik we don't use 'closed' event anymore,
    // to be removed in future releases
    this.events.emit('closed', this.address.toString())
    return Promise.resolve()
  }

  /**
   * Drops a database and removes local data
   * @return {[None]}
   */
  async drop () {
    if (this.options.onDrop) {
      await this.options.onDrop(this)
    }

    await this._cache.del(this.localHeadsPath)
    await this._cache.del(this.remoteHeadsPath)
    await this._cache.del(this.snapshotPath)
    await this._cache.del(this.queuePath)
    await this._cache.del(this.manifestPath)

    await this.close()

    // Reset
    this._index = new this.options.Index(this.address.root)
    this._oplog = new Log(this._ipfs, this.identity, { logId: this.id, access: this.access, sortFn: this.options.sortFn })
    this._cache = this.options.cache
  }

  async load (amount, opts = {}) {
    if (typeof amount === 'object') {
      opts = amount
      amount = undefined
    }
    amount = amount || this.options.maxHistory
    const fetchEntryTimeout = opts.fetchEntryTimeout || this.options.fetchEntryTimeout

    if (this.options.onLoad) {
      await this.options.onLoad(this)
    }
    const localHeads = await this._cache.get(this.localHeadsPath) || []
    const remoteHeads = await this._cache.get(this.remoteHeadsPath) || []
    const heads = localHeads.concat(remoteHeads)

    if (heads.length > 0) {
      this.events.emit('load', this.address.toString(), heads)
    }

    // Update the replication status from the heads
    heads.forEach(h => this._recalculateReplicationMax(h.clock.time))

    // Load the log
    const log = await Log.fromEntryHash(this._ipfs, this.identity, heads.map(e => e.hash), {
      logId: this.id,
      access: this.access,
      sortFn: this.options.sortFn,
      length: amount,
      onProgressCallback: this._onLoadProgress.bind(this),
      timeout: fetchEntryTimeout,
      concurrency: this.options.replicationConcurrency
    })

    this._oplog = log

    // Update the index
    if (heads.length > 0) {
      await this._updateIndex()
    }

    this.events.emit('ready', this.address.toString(), this._oplog.heads)
  }

  async sync (heads) {
    this._stats.syncRequestsReceieved += 1
    logger.debug(`Sync request #${this._stats.syncRequestsReceieved} ${heads.length}`)
    if (heads.length === 0) {
      return
    }

    // To simulate network latency, uncomment this line
    // and comment out the rest of the function
    // That way the object (received as head message from pubsub)
    // doesn't get written to IPFS and so when the Replicator is fetching
    // the log, it'll fetch it from the network instead from the disk.
    // return this._replicator.load(heads)

    const saveToIpfs = async (head) => {
      if (!head) {
        console.warn("Warning: Given input entry was 'null'.")
        return Promise.resolve(null)
      }

      const identityProvider = this.identity.provider
      if (!identityProvider) throw new Error('Identity-provider is required, cannot verify entry')

      const canAppend = await this.access.canAppend(head, identityProvider)
      if (!canAppend) {
        console.warn('Warning: Given input entry is not allowed in this log and was discarded (no write access).')
        return Promise.resolve(null)
      }

      const logEntry = Entry.toEntry(head)
      const hash = await io.write(this._ipfs, Entry.getWriteFormat(logEntry), logEntry, { links: Entry.IPLD_LINKS, onlyHash: true })

      if (hash !== head.hash) {
        console.warn('"WARNING! Head hash didn\'t match the contents')
      }

      return head
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
    const unfinished = this._replicator.unfinished

    const snapshotData = this._oplog.toSnapshot()
    const buf = Buffer.from(JSON.stringify({
      id: snapshotData.id,
      heads: snapshotData.heads,
      size: snapshotData.values.length,
      values: snapshotData.values,
      type: this.type
    }))

    const snapshot = await this._ipfs.add(buf)

    snapshot.hash = snapshot.cid.toString() // js-ipfs >= 0.41, ipfs.add results contain a cid property (a CID instance) instead of a string hash property
    await this._cache.set(this.snapshotPath, snapshot)
    await this._cache.set(this.queuePath, unfinished)

    logger.debug(`Saved snapshot: ${snapshot.hash}, queue length: ${unfinished.length}`)

    return [snapshot]
  }

  async loadFromSnapshot (onProgressCallback) {
    if (this.options.onLoad) {
      await this.options.onLoad(this)
    }

    this.events.emit('load', this.address.toString()) // TODO emits inconsistent params, missing heads param

    const maxClock = (res, val) => Math.max(res, val.clock.time)

    const queue = await this._cache.get(this.queuePath)
    this.sync(queue || [])

    const snapshot = await this._cache.get(this.snapshotPath)

    if (snapshot) {
      const chunks = []
      for await (const chunk of this._ipfs.cat(snapshot.hash)) {
        chunks.push(chunk)
      }
      const buffer = Buffer.concat(chunks)
      const snapshotData = JSON.parse(buffer.toString())

      // Fetch the entries
      // Timeout 1 sec to only load entries that are already fetched (in order to not get stuck at loading)
      this._recalculateReplicationMax(snapshotData.values.reduce(maxClock, 0))
      if (snapshotData) {
        this._oplog = await Log.fromJSON(this._ipfs, this.identity, snapshotData, {
          access: this.access,
          sortFn: this.options.sortFn,
          length: -1,
          timeout: 1000,
          onProgressCallback: this._onLoadProgress.bind(this)
        })
        await this._updateIndex()
        this.events.emit('replicated', this.address.toString()) // TODO: inconsistent params, count param not emited
      }
      this.events.emit('ready', this.address.toString(), this._oplog.heads)
    } else {
      throw new Error(`Snapshot for ${this.address} not found!`)
    }

    return this
  }

  async _updateIndex () {
    await this._index.updateIndex(this._oplog)
  }

  async syncLocal () {
    const localHeads = await this._cache.get(this.localHeadsPath) || []
    const remoteHeads = await this._cache.get(this.remoteHeadsPath) || []
    const heads = localHeads.concat(remoteHeads)
    for (let i = 0; i < heads.length; i++) {
      const head = heads[i]
      if (!this._oplog.heads.includes(head)) {
        await this.load()
        break
      }
    }
  }

  async _addOperation (data, { onProgressCallback, pin = false } = {}) {
    async function addOperation () {
      if (this._oplog) {
        // check local cache for latest heads
        if (this.options.syncLocal) {
          await this.syncLocal()
        }
        const entry = await this._oplog.append(data, this.options.referenceCount, pin)
        this._recalculateReplicationStatus(entry.clock.time)
        await this._cache.set(this.localHeadsPath, [entry])
        await this._updateIndex()
        this.events.emit('write', this.address.toString(), entry, this._oplog.heads)
        if (onProgressCallback) onProgressCallback(entry)
        return entry.hash
      }
    }
    return this._queue.add(addOperation.bind(this))
  }

  _addOperationBatch (data, batchOperation, lastOperation, onProgressCallback) {
    throw new Error('Not implemented!')
  }

  _procEntry (entry) {
    const { payload, hash } = entry
    const { op } = payload
    if (op) {
      this.events.emit(`log.op.${op}`, this.address.toString(), hash, payload)
    } else {
      this.events.emit('log.op.none', this.address.toString(), hash, payload)
    }
    this.events.emit('log.op', op, this.address.toString(), hash, payload)
  }

  /* Replication Status state updates */
  _recalculateReplicationProgress () {
    this._replicationStatus.progress = Math.max(
      Math.min(this._replicationStatus.progress + 1, this._replicationStatus.max),
      this._oplog ? this._oplog.length : 0
    )
  }

  _recalculateReplicationMax (max) {
    this._replicationStatus.max = Math.max.apply(null, [
      this.replicationStatus.max,
      this._oplog ? this._oplog.length : 0,
      (max || 0)
    ])
  }

  _recalculateReplicationStatus (maxTotal) {
    this._recalculateReplicationMax(maxTotal)
    this._recalculateReplicationProgress()
  }

  /* Loading progress callback */
  _onLoadProgress (entry) {
    this._recalculateReplicationStatus(entry.clock.time)
    this.events.emit('load.progress', this.address.toString(), entry.hash, entry, this.replicationStatus.progress, this.replicationStatus.max)
  }
}

module.exports = Store
module.exports.DefaultOptions = DefaultOptions
