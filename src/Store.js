'use strict'

const path = require('path')
const EventEmitter = require('events').EventEmitter
const Readable = require('readable-stream')
const mapSeries = require('p-each-series')
const Log = require('ipfs-log')
const Keystore = require('orbit-db-keystore')
const Index = require('./Index')
const Loader = require('./Loader')
const Replicator = require('./Replicator')

const DefaultOptions = {
  Index: Index,
  maxHistory: -1,
  path: './orbitdb',
  replicate: true,
}

class Store {
  constructor(ipfs, id, address, options) {
    // Set the options
    let opts = Object.assign({}, DefaultOptions)
    Object.assign(opts, options)
    this.options = opts

    // Default type
    this._type = 'store'

    // Create IDs, names and paths
    this.id = id
    this.address = address
    this.dbname = address.path || ''
    this.events = new EventEmitter()

    // External dependencies
    this._ipfs = ipfs
    this._cache = options.cache
    this._index = new this.options.Index(this.id)

    this._keystore = options && options.keystore 
      ? options.keystore 
      : new Keystore(path.join(this.options.path, this.id, '/keystore'))
    this._key = options && options.key
      ? options.key
      : this._keystore.getKey(id) || this._keystore.createKey(id)
    // FIX: duck typed interface
    this._ipfs.keystore = this._keystore 

    // Access mapping
    const defaultAccess = { 
      admin: [this._key.getPublic('hex')], 
      read: [], // Not used atm, anyone can read
      write: [this._key.getPublic('hex')] 
    }
    this.access = options.accessController || defaultAccess

    // Create the operations log
    this._oplog = new Log(this._ipfs, this.id, null, null, null, this._key, this.access.write)

    // Replication progress info
    this._replicationInfo = {
      progress: 0,
      max: 0,
      have: {}
    }

    // Statistics
    this._stats = {
      snapshot: {
        bytesLoaded: -1,
      },
      syncRequestsReceieved: 0,
    }

    try {
      this._loader = new Loader(this)
      this._loader.on('load.added', (entry) => {
        // Update the latest entry state (latest is the entry with largest clock time)
        this._replicationInfo.max = Math.max.apply(null, [this._replicationInfo.max, this._oplog.length, entry.clock ? entry.clock.time : 0])
        this.events.emit('replicate', this.address.toString())
      })
      this._loader.on('load.start', (entry, have) => {
        // Update the latest entry state (latest is the entry with largest clock time)
        this._replicationInfo.max = Math.max.apply(null, [this._replicationInfo.max, this._oplog.length, entry.clock ? entry.clock.time : 0])
      })
      this._loader.on('load.progress', (id, hash, entry, progress, have) => {
        this._replicationInfo.progress = Math.max.apply(null, [this._replicationInfo.progress, this._oplog.length])
        this.events.emit('replicate.progress', this.address.toString(), hash, entry, this._replicationInfo.progress, this._replicationInfo.have)
      })
      this._loader.on('load.end', async (log, have) => {
        try {
          await this._oplog.join(log, -1, this._oplog.id)
          this._replicator.replicate(this._oplog)
          this._index.updateIndex(this._oplog)
          this._calculateReplicationInfo(have)
          this.events.emit('replicated', this.address.toString())
        } catch (e) {
          console.error(e)
        }
      })

      this._replicator = new Replicator(this._loader)
      this._replicator.replicate(this._oplog)

      if (this.options.replicate) {
        this._replicator.start()
      }
    } catch (e) {
      console.error("Store Error:", e)
    }
  }

  _calculateReplicationInfo (have) {
    this._replicationInfo.progress = Math.min(this._oplog.length, Math.max(this._replicationInfo.progress, this._oplog.length))
    this._replicationInfo.max = Math.max(this._replicationInfo.max, this._oplog.length)
    if (have)
      this._replicationInfo.have = Object.assign(this._replicationInfo.have, have)
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

  async close () {
    // Stop the replicator
    this._loader.stop()
    this._replicator.stop()
    // Reset replication statistics
    this._replicationInfo = {
      progress: 0,
      max: 0,
      have: {}
    }
    // Reset database statistics
    this._stats = {
      snapshot: {
        bytesLoaded: -1,
      },
      syncRequestsReceieved: 0,
    }
    // Remove all event listeners
    this.events.removeAllListeners('load')
    this.events.removeAllListeners('load.progress')
    this.events.removeAllListeners('replicate')
    this.events.removeAllListeners('replicate.progress')
    this.events.removeAllListeners('replicated')
    this.events.removeAllListeners('ready')
    this.events.removeAllListeners('write')

    // Close cache
    await this._cache.close()

    // Database is now closed
    this.events.emit('closed', this.address.toString())
    return Promise.resolve()
  }

  async drop () {
    await this._cache.del(this.address.toString() + '/_manifest', null)
    await this._cache.del(this.address.toString(), null)
    await this._cache.del('_localHeads', null)
    await this._cache.del('_remoteHeads', null)
    await this._cache.del('snapshot', null)
    await this._cache.del('queue', null)
    await this.close()
    this._index = new this.options.Index(this.id)
    this._oplog = new Log(this._ipfs, this.id, null, null, null, this._key, this.access.write)
    this._cache = this.options && this.options.cache ? this.options.cache : new Cache(this.options.path, this.dbname)
  }

  async load (amount) {
    this._replicator.stop()

    amount = amount ? amount : this.options.maxHistory

    const localHeads = await this._cache.get('_localHeads') || []
    const remoteHeads = await this._cache.get('_remoteHeads') || []
    const heads = localHeads.concat(remoteHeads)

    if (heads.length > 0)
      this.events.emit('load', this.address.toString(), heads)

    await mapSeries(heads, async (head) => {
      this._replicationInfo.max = Math.max(this._replicationInfo.max, head.clock.time)
      let log = await Log.fromEntryHash(this._ipfs, head.hash, this._oplog.id, amount, this._oplog.values, this.key, this.access.write, this._onLoadProgress.bind(this))
      await this._oplog.join(log, amount, this._oplog.id)
      this._replicationInfo.progress = Math.max.apply(null, [this._replicationInfo.progress, this._oplog.length])
    })

    // Update the index
    if (heads.length > 0)
      this._index.updateIndex(this._oplog)

    // Start replicating again
    if (this.options.replicate) {
      this._replicator.replicate(this._oplog)
      this._replicator.start()
    }

    this.events.emit('ready', this.address.toString(), this._oplog.heads)
  }

  // TODO: refactor the signature to:
  // sync(heads) {
  sync (heads, tails, length, prioritize = true, max = -1, count = 0) {
    this._stats.syncRequestsReceieved += 1

    // To simulate network latency, uncomment this line
    // and comment out the rest of the function
    // That way the object (received as head message from pubsub)
    // doesn't get written to IPFS and so when the Loader is fetching
    // the log, it'll fetch it from the network instead from the disk.
    // return this._loader.load(heads)

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
        await this._cache.set('_remoteHeads', heads)
        return this._loader.load(saved.filter(e => e !== null))
      })
  }

  loadMoreFrom (amount, entries) {
    this._loader.load(entries)
  }

  async saveSnapshot() {
    const unfinished = Object.keys(this._loader._fetching).map(e => this._loader._fetching[e]).concat(this._loader._queue.map(e => e))

    let s = this._oplog.toSnapshot()
    let header = new Buffer(JSON.stringify({
      id: s.id,
      heads: s.heads,
      size: s.values.length,
      type: this.type,
    }))
    const rs = new Readable()
    let size = new Uint16Array([header.length])
    let bytes = new Buffer(size.buffer)
    rs.push(bytes)
    rs.push(header)

    s.values.forEach((val) => {
      let str = new Buffer(JSON.stringify(val))
      let size = new Uint16Array([str.length])
      rs.push(new Buffer(size.buffer))
      rs.push(str)
    })

    rs.push(null)

    const stream = {
      path: this.address.toString(),
      content: rs
    }

    const snapshot = await this._ipfs.files.add(stream)

    await this._cache.set('snapshot', snapshot[snapshot.length - 1])
    await this._cache.set('queue', unfinished)

    return snapshot
  }

  async loadFromSnapshot (onProgressCallback) {
    this.events.emit('load', this.address.toString())

    const queue = await this._cache.get('queue')
    this.sync(queue || [])

    const snapshot = await this._cache.get('snapshot')

    if (snapshot) {
      const res = await this._ipfs.files.catReadableStream(snapshot.hash)
      const loadSnapshotData = () => {
        return new Promise((resolve, reject) => {
          let buf = new Buffer(0)
          let q = []

          const bufferData = (d) => {
            this._byteSize += d.length
            if (q.length < 2000) {
              q.push(d)
            } else {
              const a = Buffer.concat(q)
              buf = Buffer.concat([buf, a])
              q = []
            }
          }

          const done = () => {
            // this.events.emit('load.progress', this.address.toString(), null, null, 0, this._replicationInfo.max)

            if (q.length > 0) {
              const a = Buffer.concat(q)
              buf = Buffer.concat([buf, a])
            }

            function toArrayBuffer(buf) {
              var ab = new ArrayBuffer(buf.length)
              var view = new Uint8Array(ab)
              for (var i = 0; i < buf.length; ++i) {
                  view[i] = buf[i]
              }
              return ab
            }

            const headerSize = parseInt(new Uint16Array(toArrayBuffer(buf.slice(0, 2))))
            const header = JSON.parse(buf.slice(2, headerSize + 2))

            let values = []
            let a = 2 + headerSize
            while(a < buf.length) {
              const s = parseInt(new Uint16Array(toArrayBuffer(buf.slice(a, a + 2))))
              // console.log("size: ", s)
              a += 2
              const data = buf.slice(a, a + s)
              try {
                const d = JSON.parse(data)
                values.push(d)
              } catch (e) {
              }
              a += s
            }

            this._type = header.type
            this._replicationInfo.max = Math.max(this._replicationInfo.max, values.reduce((res, val) => Math.max(res, val.clock.time), 0))
            resolve({ values: values, id: header.id, heads: header.heads, type: header.type })
          }
          res.on('data', bufferData)
          res.on('end', done)
        })
      }

      const onProgress = (hash, entry, count, total) => {
        this._replicationInfo.max = Math.max(this._replicationInfo.max, entry.clock.time)
        this._replicationInfo.progress = Math.max.apply(null, [this._replicationInfo.progress, count, this._oplog.length])
        this._onLoadProgress(hash, entry, this._replicationInfo.progress, this._replicationInfo.max)
      }

      // Fetch the entries
      // Timeout 1 sec to only load entries that are already fetched (in order to not get stuck at loading)
      const snapshotData = await loadSnapshotData()
      const log = await Log.fromJSON(this._ipfs, snapshotData, -1, this._key, this.access.write, 1000, onProgress)
      await this._oplog.join(log, -1, this._oplog.id)
      this._oplog.values.forEach(e => this._replicationInfo.have[e.clock.time] = true)
      this._replicationInfo.max = Math.max(this._replicationInfo.max, this._oplog.length)
      this._replicationInfo.progress = Math.max(this._replicationInfo.progress, this._oplog.length)
      this._replicator.replicate(this._oplog)
      this._index.updateIndex(this._oplog)
      this.events.emit('ready', this.address.toString(), this._oplog.heads)
      this.events.emit('replicated', this.address.toString())
    } else {
      throw new Error(`Snapshot for ${this.address} not found!`)
    }
    return this
  }

  async _addOperation(data, batchOperation, lastOperation, onProgressCallback) {
    if(this._oplog) {
      const entry = await this._oplog.append(data)
      this._replicationInfo.max = Math.max(this._replicationInfo.max, entry.clock.time)
      this._replicationInfo.progress++
      const address = this.address.toString()
      await this._cache.set('_localHeads', [entry])
      this._index.updateIndex(this._oplog)
      this.events.emit('write', this.address.toString(), entry, this._oplog.heads)
      if (onProgressCallback) onProgressCallback(entry)
      return entry.hash
    }
  }

  _addOperationBatch(data, batchOperation, lastOperation, onProgressCallback) {
    throw new Error("Not implemented!")
  }

  _onLoadProgress (hash, entry, progress, total) {
    this.events.emit('load.progress', this.address.toString(), hash, entry, Math.max(this._oplog.length, progress), Math.max(this._oplog.length || 0, this._replicationInfo.max || 0))
  }
}

module.exports = Store
