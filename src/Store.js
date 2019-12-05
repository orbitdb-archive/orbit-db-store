'use strict'

const path = require('path')
const EventEmitter = require('events').EventEmitter
const Readable = require('readable-stream')
const mapSeries = require('p-each-series')
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
  replicate: true,
  referenceCount: 32,
  replicationConcurrency: 128,
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
      this._replicator = new Replicator(this, this.options.replicationConcurrency)
      // For internal backwards compatibility,
      // to be removed in future releases
      this._loader = this._replicator
      this._replicator.on('load.added', (entry) => {
        // Update the latest entry state (latest is the entry with largest clock time)
        this._replicationStatus.queued++
        this._recalculateReplicationMax(entry.clock ? entry.clock.time : 0)
        // logger.debug(`<replicate>`)
        this.events.emit('replicate', this.address.toString(), entry)
      })
      this._replicator.on('load.progress', (id, hash, entry, have, bufferedLength) => {
        if (this._replicationStatus.buffered > bufferedLength) {
          this._recalculateReplicationProgress(this.replicationStatus.progress + bufferedLength)
        } else {
          this._recalculateReplicationProgress(this._oplog.length + bufferedLength)
        }
        this._replicationStatus.buffered = bufferedLength
        this._recalculateReplicationMax(this.replicationStatus.progress)
        // logger.debug(`<replicate.progress>`)
        this.events.emit('replicate.progress', this.address.toString(), hash, entry, this.replicationStatus.progress, this.replicationStatus.max)
      })

      const onLoadCompleted = async (logs, have) => {
        try {
          for (const log of logs) {
            await this._oplog.join(log)
          }
          this._replicationStatus.queued -= logs.length
          this._replicationStatus.buffered = this._replicator._buffer.length
          await this._updateIndex()

          // only store heads that has been verified and merges
          const heads = this._oplog.heads
          await this._cache.set(this.remoteHeadsPath, heads)
          logger.debug(`Saved heads ${heads.length} [${heads.map(e => e.hash).join(', ')}]`)

          // logger.debug(`<replicated>`)
          this.events.emit('replicated', this.address.toString(), logs.length)
        } catch (e) {
          console.error(e)
        }
      }
      this._replicator.on('load.end', onLoadCompleted)
    } catch (e) {
      console.error('Store Error:', e)
    }
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
    if (this.options.onClose) {
      await this.options.onClose(this)
    }

    // Replicator teardown logic
    this._replicator.stop()

    // Reset replication statistics
    this._replicationStatus.reset()

    // Reset database statistics
    this._stats = {
      snapshot: {
        bytesLoaded: -1
      },
      syncRequestsReceieved: 0
    }

    // Remove all event listeners
    this.events.removeAllListeners('load')
    this.events.removeAllListeners('load.progress')
    this.events.removeAllListeners('replicate')
    this.events.removeAllListeners('replicate.progress')
    this.events.removeAllListeners('replicated')
    this.events.removeAllListeners('ready')
    this.events.removeAllListeners('write')
    this.events.removeAllListeners('peer')

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

  async load (amount, { fetchEntryTimeout } = {}) {
    amount = amount || this.options.maxHistory
    fetchEntryTimeout = fetchEntryTimeout || this.options.fetchEntryTimeout

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
      logId: this._oplog.id,
      access: this.access,
      sortFn: this.options.sortFn,
      length: amount,
      exclude: this._oplog.values,
      onProgressCallback: this._onLoadProgress.bind(this),
      timeout: fetchEntryTimeout
    })

    // Join the log with the existing log
    await this._oplog.join(log, amount)

    // Update the index
    if (heads.length > 0) {
      await this._updateIndex()
    }

    this.events.emit('ready', this.address.toString(), this._oplog.heads)
  }

  sync (heads) {
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
    const unfinished = this._replicator.getQueue()

    const snapshotData = this._oplog.toSnapshot()
    const header = Buffer.from(JSON.stringify({
      id: snapshotData.id,
      heads: snapshotData.heads,
      size: snapshotData.values.length,
      type: this.type
    }))
    const rs = new Readable()
    const size = new Uint16Array([header.length])
    const bytes = Buffer.from(size.buffer)
    rs.push(bytes)
    rs.push(header)

    const addToStream = (val) => {
      const str = Buffer.from(JSON.stringify(val))
      const size = new Uint16Array([str.length])
      rs.push(Buffer.from(size.buffer))
      rs.push(str)
    }

    snapshotData.values.forEach(addToStream)
    rs.push(null) // tell the stream we're finished

    const snapshot = this._ipfs.files.add ? await this._ipfs.files.add(rs) : await this._ipfs.add(rs)

    await this._cache.set(this.snapshotPath, snapshot[snapshot.length - 1])
    await this._cache.set(this.queuePath, unfinished)

    logger.debug(`Saved snapshot: ${snapshot[snapshot.length - 1].hash}, queue length: ${unfinished.length}`)

    return snapshot
  }

  async loadFromSnapshot (onProgressCallback) {
    if (this.options.onLoad) {
      await this.options.onLoad(this)
    }

    this.events.emit('load', this.address.toString())

    const maxClock = (res, val) => Math.max(res, val.clock.time)

    const queue = await this._cache.get(this.queuePath)
    this.sync(queue || [])

    const snapshot = await this._cache.get(this.snapshotPath)

    if (snapshot) {
      const res = this._ipfs.files.catReadableStream ? await this._ipfs.files.catReadableStream(snapshot.hash) : await this._ipfs.catReadableStream(snapshot.hash)
      const loadSnapshotData = () => {
        return new Promise((resolve, reject) => {
          let buf = Buffer.alloc(0)
          let q = []

          const bufferData = (d) => {
            this._byteSize += d.length
            if (q.length < 20000) {
              q.push(d)
            } else {
              const a = Buffer.concat(q)
              buf = Buffer.concat([buf, a])
              q = []
            }
          }

          const done = () => {
            if (q.length > 0) {
              const a = Buffer.concat(q)
              buf = Buffer.concat([buf, a])
            }

            function toArrayBuffer (buf) {
              var ab = new ArrayBuffer(buf.length)
              var view = new Uint8Array(ab)
              for (var i = 0; i < buf.length; ++i) {
                view[i] = buf[i]
              }
              return ab
            }

            const headerSize = parseInt(new Uint16Array(toArrayBuffer(buf.slice(0, 2))))
            let header

            try {
              header = JSON.parse(buf.slice(2, headerSize + 2))
            } catch (e) {
              // TODO
            }

            const values = []
            let a = 2 + headerSize
            while (a < buf.length) {
              const s = parseInt(new Uint16Array(toArrayBuffer(buf.slice(a, a + 2))))
              a += 2
              const data = buf.slice(a, a + s)
              try {
                const d = JSON.parse(data)
                values.push(d)
              } catch (e) {
              }
              a += s
            }

            if (header) {
              this._type = header.type
              resolve({ values: values, id: header.id, heads: header.heads, type: header.type })
            } else {
              resolve({ values: values, id: null, heads: null, type: null })
            }
          }
          res.on('data', bufferData)
          res.on('end', done)
        })
      }

      const onProgress = (hash, entry, count, total) => {
        this._recalculateReplicationStatus(count, entry.clock.time)
        this._onLoadProgress(hash, entry)
      }

      // Fetch the entries
      // Timeout 1 sec to only load entries that are already fetched (in order to not get stuck at loading)
      const snapshotData = await loadSnapshotData()
      this._recalculateReplicationMax(snapshotData.values.reduce(maxClock, 0))
      if (snapshotData) {
        const log = await Log.fromJSON(this._ipfs, this.identity, snapshotData, { access: this.access, sortFn: this.options.sortFn, length: -1, timeout: 1000, onProgressCallback: onProgress })
        await this._oplog.join(log)
        await this._updateIndex()
        this.events.emit('replicated', this.address.toString())
      }
      this.events.emit('ready', this.address.toString(), this._oplog.heads)
    } else {
      throw new Error(`Snapshot for ${this.address} not found!`)
    }

    return this
  }

  async _updateIndex () {
    this._recalculateReplicationMax()
    await this._index.updateIndex(this._oplog)
    this._recalculateReplicationProgress()
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
    if (this._oplog) {
      // check local cache?
      if (this.options.syncLocal) {
        await this.syncLocal()
      }

      const entry = await this._oplog.append(data, this.options.referenceCount, pin)
      this._recalculateReplicationStatus(this.replicationStatus.progress + 1, entry.clock.time)
      await this._cache.set(this.localHeadsPath, [entry])
      await this._updateIndex()
      this.events.emit('write', this.address.toString(), entry, this._oplog.heads)
      if (onProgressCallback) onProgressCallback(entry)
      return entry.hash
    }
  }

  _addOperationBatch (data, batchOperation, lastOperation, onProgressCallback) {
    throw new Error('Not implemented!')
  }

  _onLoadProgress (hash, entry, progress, total) {
    this._recalculateReplicationStatus(progress, total)
    this.events.emit('load.progress', this.address.toString(), hash, entry, this.replicationStatus.progress, this.replicationStatus.max)
  }

  /* Replication Status state updates */

  _recalculateReplicationProgress (max) {
    this._replicationStatus.progress = Math.max.apply(null, [
      this._replicationStatus.progress,
      this._oplog.length,
      max || 0
    ])
    this._recalculateReplicationMax(this.replicationStatus.progress)
  }

  _recalculateReplicationMax (max) {
    this._replicationStatus.max = Math.max.apply(null, [
      this._replicationStatus.max,
      this._oplog.length,
      max || 0
    ])
  }

  _recalculateReplicationStatus (maxProgress, maxTotal) {
    this._recalculateReplicationProgress(maxProgress)
    this._recalculateReplicationMax(maxTotal)
  }
}

module.exports = Store
module.exports.DefaultOptions = DefaultOptions
