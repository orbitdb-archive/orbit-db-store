'use strict'

const path = require('path')
const EventEmitter = require('events').EventEmitter
const Readable = require('readable-stream')
const Log = require('ipfs-log')
const Cache = require('orbit-db-cache')
const Index = require('./Index')
const Loader = require('./Loader')
const Replicator = require('./Replicator')
const parseAddress = require('./parse-address')

const DefaultOptions = {
  Index: Index,
  maxHistory: -1,
  path: './orbitdb',
  replicate: true,
}

class Store {
  constructor(ipfs, id, dbname, options) {
    let opts = Object.assign({}, DefaultOptions)
    Object.assign(opts, options)

    this.options = opts

    this.id = id
    this.dbname = dbname || ''
    this.path = parseAddress(this.dbname, this.id)

    this._ipfs = ipfs
    this._oplog = new Log(this._ipfs, this.id)
    this._index = new this.options.Index(this.id)
    this._cache = options && options.cache ? options.cache : new Cache(this.options.path, this.dbname)
    this.events = new EventEmitter()

    this._type = 'store'

    this._replicationInfo = {
      progress: 0,
      max: 0,
      have: {}
    }

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
        this.events.emit('replicate', this.path)
      })
      this._loader.on('load.start', (entry, have) => {
        // Update the latest entry state (latest is the entry with largest clock time)
        this._replicationInfo.max = Math.max.apply(null, [this._replicationInfo.max, this._oplog.length, entry.clock ? entry.clock.time : 0])
      })
      this._loader.on('load.progress', (id, hash, entry, progress, have) => {
        this._replicationInfo.progress = Math.max(this._replicationInfo.progress, Math.min(this._oplog.length + progress, this._replicationInfo.progress))
        this.events.emit('replicate.progress', this.path, hash, entry, progress, have)
      })
      this._loader.on('load.end', (log, have) => {
        this._replicationInfo.have = Object.assign({}, this._replicationInfo.have, have)
        this._oplog.join(log, -1, this._oplog.id)
        this._replicator.replicate(this._oplog)
        this._index.updateIndex(this._oplog)
      })
      this._loader.on('load.complete', (have) => {
        this._replicationInfo.progress = Math.min(this._oplog.length, Math.max(this._replicationInfo.progress, this._oplog.length))
        this._replicationInfo.max = Math.max(this._replicationInfo.max, this._oplog.length)
        this._replicationInfo.have = Object.assign({}, this._replicationInfo.have, have)
        this.events.emit('replicated', this.path)
        this.events.emit('synced', this.path) // for API backwards compatibility (ish)
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

  get all () {
    return Array.isArray(this._index._index) 
      ? this._index._index 
      : Object.keys(this._index._index).map(e => this._index._index[e])
  }

  get type () {
    return this._type
  }

  close () {
    this._loader.stop()
    this._replicator.stop()
    this.events.emit('close', this.path)
  }

  drop () {
    return this._cache.set(this.path, null)
      .then(() => this._cache.set(this.path + '.snapshot', null))
      .then(() => this._cache.set(this.path + '.localhead', null))
      .then(() => this._cache.set(this.path + '.remotehead', null))
      .then(() => this._cache.set(this.path + '.type', null))
      .then(() => {
        this._index = new this.options.Index(this.id)
        this._oplog = new Log(this._ipfs, this.id)
        this._cache = new Cache(this.options.path, this.dbname)
        this.syncing = false
        this.syncQueue = []
      })
  }

  load(amount) {
    let lastHash
    return this._cache.load()
      .then(() => this._cache.get(this.path + '.localhead'))
      .then((hash) => {
        if (hash) {
          lastHash = hash
          this.events.emit('load', this.path)
          amount = amount ? amount : this.options.maxHistory
          return Log.fromMultihash(this._ipfs, hash, amount, [], this._onLoadProgress.bind(this))
            .then((log) => {
              this._oplog.join(log, -1, this._oplog.id)
              this._index.updateIndex(this._oplog)
              return this._oplog.heads
            })
        } else {
          return Promise.resolve()
        }
      })
      .then((heads) => this.events.emit('ready', this.path, heads))
  }

  // TODO: refactor the signature to:
  // sync(heads) {
  sync(heads, tails, length, prioritize = true, max = -1, count = 0) {
    this._stats.syncRequestsReceieved += 1

    // To simulate network latency, uncomment this line
    // and comment out the rest of the function
    // That way the object (received as head message from pubsub)
    // doesn't get written to IPFS and so when the Loader is fetching
    // the log, it'll fetch it from the network instead from the disk.
    // return this._loader.load(heads)

    const saveToIpfs = (head) => {
      const logEntry = Object.assign({}, head)
      logEntry.hash = null
      return this._ipfs.object.put(new Buffer(JSON.stringify(logEntry)))
        .then((dagObj) => dagObj.toJSON().multihash)
        .then(hash => {
          // We need to make sure that the head message's hash actually
          // matches the hash given by IPFS in order to verify that the
          // message contents are authentic
          if (hash !== head.hash)
            console.warn('"WARNING! Head hash didn\'t match the contents')

          return hash
        })
        .then((hash) => this._cache.set(this.path + '.remotehead', hash))
    }

    return Promise.all(heads.map(saveToIpfs))
      .then(() => this._loader.load(heads))
  }

  async loadMoreFrom (amount, entries) {
    this._loader.load(entries)
  }

  async saveSnapshot() {
    const unfinished = Object.keys(this._loader._fetching).map(e => this._loader._fetching[e]).concat(this._loader._queue.map(e => e))
    await this._cache.set(this.path + '.queue', unfinished)

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
      path: this.path,
      content: rs
    }

    return this._ipfs.files.add(stream)
      .then((snapshot) => {
        return this._cache.set(this.path + '.snapshot', snapshot[snapshot.length - 1])
          .then(() => this._cache.set(this.path + '.type', this.type))
          .then(() => this._cache.set(this.path + '.max', this._replicationInfo.max))
          .then(() => this._cache.set(this.path, this.id))
          .then(() => snapshot)
      })
  }

  async loadFromSnapshot (hash, onProgressCallback) {
    this.events.emit('load', this.path)
    return this._cache.load()
      .then(async () => {
        const queue = await this._cache.get(this.path + '.queue')
        const lastMax = await this._cache.get(this.path + '.max')
        this._replicationInfo.max = lastMax || 0
        this.events.emit('progress.load', this.path, null, null, 0, this._replicationInfo.max)
        this._loader.load(queue || [])
      })
      .then(() => this._cache.get(this.path + '.snapshot'))
      .then((snapshot) => {
        if (snapshot) {
          return this._ipfs.files.cat(snapshot.hash)
            .then((res) => {
              return new Promise((resolve, reject) => {
                let buf = new Buffer(0)
                let q = []

                const bufferData = (d) => {
                  this._byteSize += d.length
                  if (q.length < 200) {
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
                  this.events.emit('progress.load', this.path, null, null, 0, this._replicationInfo.max)

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
                  this._replicationInfo.progress = values.length
                  resolve({ values: values, id: header.id, heads: header.heads, type: header.type })
                }
                res.on('data', bufferData)
                res.on('end', done)
              })
            })
            .then((res) => {
              const onProgress = (dbname, hash, entry, count, total) => {
                const max = Math.max(total || 0, this._replicationInfo.max)
                this._onLoadProgress(dbname, hash, entry, max, max)
              }

              return Log.fromJSON(this._ipfs, res, this.options.maxHistory, onProgress)
                .then((log) => {
                  this._oplog.join(log, -1, this._oplog.id)
                  this._oplog.values.forEach(e => this._replicationInfo.have[e.clock.time] = true)
                  this._replicationInfo.max = Math.max(this._replicationInfo.max, this._oplog.length)
                  this._replicator.replicate(this._oplog)
                  this._index.updateIndex(this._oplog)
                  return this._oplog.heads
                })
            })
        }
      })
      .then((heads) => this.events.emit('ready', this.path, heads))
      .then(() => {
        this._replicationInfo.max = Math.max(this._replicationInfo.max, this._oplog.values.reduce((res, val) => Math.max(res, val.clock.time), 0))
        this.events.emit('replicated', this.path)
        this.events.emit('synced', this.path) // for API backwards compatibility (ish)
      })
      .then(() => this)
  }

  _addOperation(data, batchOperation, lastOperation, onProgressCallback) {
    let logHash
    if(this._oplog) {
      return this._oplog.append(data)
        .then(() => this._oplog.toMultihash())
        .then((hash) => logHash = hash)
        .then(() => {
          this._cache.set(this.path + '.localhead', logHash)
        })
        .then(() => {
          this._index.updateIndex(this._oplog)
          const entry = this._oplog.values[this._oplog.values.length - 1]
          this.events.emit('write', this.path, logHash, entry, this._oplog.heads)
          if (onProgressCallback) onProgressCallback(entry)
          return entry.hash
        })
    }
  }

  _addOperationBatch(data, batchOperation, lastOperation, onProgressCallback) {
    let logHash
    if(this._oplog) {
      return this._oplog.append(data)
        .then(() => {
          if (!batchOperation || lastOperation) {
            return this._oplog.toMultihash()
              .then((hash) => {
                logHash = hash
                this._cache.set(this.path + '.localhead', logHash)
                  .then(() => {
                    this._index.updateIndex(this._oplog)
                    const entry = this._oplog.values[this._oplog.values.length - 1]
                    this.events.emit('write', this.path, logHash, entry, this._oplog.heads)
                  })
              })
          }
        })
        .then(() => {
          const entry = this._oplog.values[this._oplog.values.length - 1]
          if (onProgressCallback) onProgressCallback(entry)
          return entry.hash
        })
    }
  }

  _onLoadProgress (hash, entry, progress, total) {
    this.events.emit('load.progress', this.path, hash, entry, progress, total)
    this.events.emit('progress.load', this.path, hash, entry, progress, total)
  }

  _onSyncProgress (hash, entry, progress) {
    this.events.emit('sync.progress', this.path, hash, entry, progress)
  }
}

module.exports = Store
