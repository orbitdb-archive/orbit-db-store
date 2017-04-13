'use strict'

const path = require('path')
const EventEmitter = require('events').EventEmitter
const Log = require('ipfs-log')
const Entry = require('ipfs-log/src/entry')
const EntrySet = require('ipfs-log/src/entry-set')
const Cache = require('orbit-db-cache')
const Index = require('./Index')
const Readable = require('readable-stream')

const DefaultOptions = {
  Index: Index,
  maxHistory: 256,
  cachePath: './orbit-db',
  syncHistory: true,
}

class Store {
  constructor(ipfs, id, dbname, options) {
    this.id = id
    this.dbname = dbname || ''
    this.events = new EventEmitter()
    this.path = path.join('/', id, dbname)

    let opts = Object.assign({}, DefaultOptions)
    Object.assign(opts, options)

    this.options = opts
    this._ipfs = ipfs
    this._index = new this.options.Index(this.id)
    this._oplog = Log.create(this.id)
    this._lastWrite = []
    this._type = 'store'

    this._latestLocalHead = null
    this._latestRemoteHead = null
    this._byteSize = -1

    // this._cache = new Cache(this.options.cachePath, this.dbname)
    this._cache = options && options.cache ? options.cache : new Cache(this.options.path, this.dbname)
    this.syncing = false
    this.syncQueue = []
    setInterval(() => this._processQ(), 16)

    this.syncedOnce = false
  }

  get all () {
    return Array.isArray(this._index._index) ? this._index._index : Object.keys(this._index._index).map(e => this._index._index[e])
  }

  get type () {
    return this._type
  }

  drop () {
    this._latestLocalHead = null
    this._latestRemoteHead = null
    return this._cache.set(this.dbname, null)
      .then(() => this._cache.set(this.dbname + '.snapshot', null))
      .then(() => this._cache.set(this.dbname + '.localhead', null))
      .then(() => this._cache.set(this.dbname + '.remotehead', null))
      .then(() => this._cache.set(this.dbname + '.type', null))
      .then(() => {
        this._index = new this.options.Index(this.id)
        this._oplog = Log.create(this.id)
        this._cache = new Cache(this.options.cachePath, this.dbname)
        this.syncing = false
        this.syncQueue = []
      })
  }

  load(amount) {
    let lastHash
    return this._cache.load()
      .then(() => this._cache.get(this.dbname))
      .then((hash) => {
        if (hash) {
          lastHash = hash
          // this.events.emit('sync', this.dbname)
          this.events.emit('load', this.dbname)
          amount = amount ? amount : this.options.maxHistory
          return Log.fromMultihash(this._ipfs, hash, amount, [], this._onLoadProgress.bind(this))
            .then((log) => {
              this._oplog = Log.join(this._oplog, log, -1, this._oplog.id)
              this._index.updateIndex(this._oplog)
              return this._oplog.heads
            })
        } else {
          return Promise.resolve()
        }
      })
      .then((heads) => this.events.emit('ready', this.dbname, heads))
  }

  loadMore(amount) {
    const prevLen = this._oplog.items.length
    this.events.emit('sync', this.dbname)
    // console.log("expand:", amount)
    return Log.expand(this._ipfs, this._oplog, amount)
      .then((log) => {
        const newCount = log.items.length - prevLen
        // console.log("expanded to:", log.items.length)
        this._oplog = log
        this._index.updateIndex(this._oplog)
        this.events.emit('synced', this.dbname)
        return newCount
      })
  }

  loadMoreFrom(amount, entries) {
    // TODO: need to put this via the sync queue

    // console.log("Load more from:", amount, entries)
    if (entries && !this.loadingMore) {
      this.loadingMore = true
      this.events.emit('sync', this.dbname)

      // TODO: move to LogUtils
      const allTails = new EntrySet(this._oplog.tails)//EntryCollection.findTails(this._oplog.items)
      const tails = allTails.intersection(new EntrySet(entries.reverse())) // Why do we need to reverse?

      // console.log("tails:", tails)
      // console.log(tails.map(e => e.clock.time + ' ' + JSON.parse(e.payload.value).Post.content).join('\n'))
      return Log.expandFrom(this._ipfs, this._oplog, tails, amount)
        .then((log) => {
          this._oplog = log
          this._index.updateIndex(this._oplog)
          this.loadingMore = false
          this.events.emit('synced', this.dbname)
        })
        .catch(e => console.error(e))
    }
  }

  sync(heads, tails, length, prioritize = true, max = -1, count = 0) {
    if (prioritize)
      this.syncQueue.splice(0, 0, { heads: heads, tails: tails, length: length, max: max, count: count })
    else
      this.syncQueue.push({ heads: heads, tails: tails, length: length, max: max, count: count })
  }

  async saveSnapshot() {
    // return this._ipfs.files.add(new Buffer(JSON.stringify(this._oplog.toSnapshot())))
    let s = this._oplog.toSnapshot()
//    s.entries = s.entries.map(e => cbor.encode(e))
    let header = new Buffer(JSON.stringify({
      id: s.id,
      heads: s.heads,
      size: s.entries.length,
      type: this.type,
    }))
    const rs = new Readable()
    let size = new Uint16Array([header.length])
    let bytes = new Buffer(size.buffer)
    rs.push(bytes)
    rs.push(header)
    // console.log("\nSaving snapshot...")
    s.entries.forEach((val) => {
      let str = new Buffer(JSON.stringify(val))
      let size = new Uint16Array([str.length])
      rs.push(new Buffer(size.buffer))
      rs.push(str)
    })

    // bytes = cbor.encode([size])
//    console.log("\n2--->")//, bytes.byteLength, (new Uint16Array(bytes.buffer.slice(0, 2))).toString())
    rs.push(null)

    const stream = {
      path: this.dbname,
      content: rs
    }

    // bytes = Buffer.concat([new Buffer(s.id), new Buffer(s.heads), new Buffer(s.entries)])
//    const compBytes = new Buffer(JSON.stringify(this._oplog.toSnapshot()))
//    console.log(Math.floor(bytes.length/1024) + " KB")// vs. " + Math.floor(compBytes.length/1024) + " KB")
    return this._ipfs.files.add(stream)
      .then((snapshot) => {
        // console.log("\nSnapshot:\n", snapshot)
        return this._cache.set(this.dbname + '.snapshot', snapshot[snapshot.length - 1])
          .then(() => this._cache.set(this.dbname + '.type', this.type))
          .then(() => this._cache.set(this.dbname, this.id))
          .then(() => snapshot)
      })
  }

  loadFromSnapshot (hash, onProgressCallback) {
    this.events.emit('load', this.dbname)
    return this._cache.load()
      .then(() => this._cache.get(this.dbname + '.snapshot'))
      .then((snapshot) => {
        if (snapshot) {
          return this._ipfs.files.cat(snapshot.hash)
            .then((res) => {
              // this.events.emit('progress.load', this.dbname, null, null, 0, snapshot.size)
//              console.log("\nLoaded snapshot:", buf.length, "bytes")
              return new Promise((resolve, reject) => {
                let buf = new Buffer(0)
                let q = []

                // const timer = setInterval(() => {
                //   this.events.emit('progress.load', this.dbname, null, null, buf.length, snapshot.size)
                // }, 1000)

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

                  // clearInterval(timer)
                  // this.events.emit('progress.load', this.dbname, null, null, snapshot.size, snapshot.size)

                  const headerSize = parseInt(new Uint16Array(toArrayBuffer(buf.slice(0, 2))))
                  const header = JSON.parse(buf.slice(2, headerSize + 2))
                  this.events.emit('progress.load', this.dbname, null, null, 0, header.size)

                  let ee = []
                  let a = 2 + headerSize
                  while(a < buf.length) {
                    const s = parseInt(new Uint16Array(toArrayBuffer(buf.slice(a, a + 2))))
                    // console.log("size: ", s)
                    a += 2
                    const data = buf.slice(a, a + s)
                    //console.log(ee.length, data.length, data.toString())
                    try {
                      const d = JSON.parse(data)
                      ee.push(d)
                      // t ++
                      // this.events.emit('progress.init', this.dbname, null, null, t, header.size)
                    } catch (e) {
                    }
                    a += s
                  }

                  // let entries = buf.slice(2, buf.length)
                  // buf.forEach((e, i) => size[i] = e)

                  // entries = 
                  //console.log("\nEntries:\n", ee.slice(10))
                  this._type = header.type
                  this._latestLocalHead = this._cache.get(this.dbname + '.localhead')
                  this._latestRemoteHead = this._cache.get(this.dbname + '.remotehead')
                  resolve({ entries: ee, id: header.id, heads: header.heads, type: header.type })
                }
                res.on('data', bufferData)
                res.on('end', done)
              })
            })
            .then((res) => {
              return Log.fromJSON(this._ipfs, res, this.options.maxHistory, this._onLoadProgress.bind(this))
                .then((log) => {
                  this.events.emit('update', this._oplog)
                  this._oplog = log

                  const onUpdate = (entry, progress) => {
                    this.events.emit('progress.update', this.dbname, entry.hash, entry, progress, this._oplog.length)
                  }

                  this._index.updateIndex(this._oplog, onUpdate)
                  return this._oplog.heads
                })
            })
        }
      })
      .then((heads) => this.events.emit('ready', this.dbname, heads))
      .then(() => this)
  }

  _processQ() {
    if (this.syncQueue && this.syncQueue.length > 0 && !this.syncing) {
      this.syncing = true
      const task = this.syncQueue.shift()
      if (task.heads) {
        this._syncFromHeads(task.heads, task.length, task.max, task.count)
          .then(() => this.syncing = false)
          .catch((e) => this.events.emit('error', e))
      } else if (task.tails) {
        this._syncFromTails(task.tails, task.length, task.max, task.count)
          .then(() => this.syncing = false)
          .catch((e) => this.events.emit('error', e))
      }
    }
  }

  _syncFromHeads(heads, maxHistory, max, currentCount) {
    if (!heads || !Array.isArray(heads))
      return Promise.resolve()

    // TODO: doesn't need to return the log hash, that's already cached here
    const exclude = this._oplog.items.map((e) => e.hash)

    heads = heads.filter(e => e !== undefined && e !== null && Entry.isEntry(e))

    // If we have one of the heads, return
    // FIX: need to filter out the heads instead of returning
    if (heads.length === 0 || exclude.find((e) => heads.map((a) => a.hash).indexOf(e) > -1))
      return Promise.resolve()

    // console.log("SYNC FROM HEADS", maxHistory)
    this.events.emit('sync', this.dbname, heads)

    const saveToIpfs = (head) => {
      const e = Object.assign({}, head)
      e.hash = null
      return this._ipfs.object.put(new Buffer(JSON.stringify(e)))
        .then((dagObj) => dagObj.toJSON().multihash)
    }

    maxHistory = maxHistory || this.options.maxHistory
    currentCount = currentCount || 0
    max = max ||this.options.maxHistory

    return Promise.all(heads.map(saveToIpfs))
      .then((hashes) => {
        // return Log.fromEntry(this._ipfs, heads, maxHistory, exclude, this._onLoadProgress.bind(this))
        return Log.fromEntry(this._ipfs, heads, maxHistory, exclude, this._onSyncProgress.bind(this))
      })
      .then((log) => {
        const len = this._oplog.items.length
        if (log.items.length > 0) {
          const prevTails = this._oplog.tails.filter(e => e.next.length > 0)
          const prevHeads = this._oplog.heads

          this._oplog = Log.join(this._oplog, log, -1, this._oplog.id)
          this._index.updateIndex(this._oplog)

          const newItemsCount = this._oplog.items.length - len
          // console.log("Synced:", newItemsCount)
          currentCount += newItemsCount

          // console.log("sync more?", this.options.syncHistory, currentCount, max)
          // if (this.options.syncHistory && (max === -1 || currentCount < max)) {
          //   const newTails = this._oplog.tails.filter(e => e.next.length > 0)
          //   const uniqueNewTails = newTails.filter((e) => !prevTails.map(a => a.hash).includes(e.hash))
          //   const newerTails = uniqueNewTails
          //     .map(e => newTails.map(a => a.hash).indexOf(e) !== 0 ? e : null)
          //     .filter(e => e !== null)

          //   const hasNewerTails = uniqueNewTails.reduce((res, e) => {
          //     // True if tail doesn't exist (-1) or is at index > 0 (newer)
          //     return newTails.map(a => a.hash).indexOf(e) !== 0
          //   }, false)

          //   // console.log("we should fetch more?", isNewer, newer.length, newer, prevTails, newTails)
          //   if (hasNewerTails) {
          //     console.log("has newer tails")
          //     setImmediate(() => this.sync(null, [newTails[newTails.length - 1]], this.options.maxHistory * 2, false, 32, currentCount))
          //     return
          //   }

          //   const newHeads = this._oplog.heads
          //   const shouldLoadFromHeads = prevHeads.length !== newHeads.length // If the length of the heads is different
          //     || newHeads.filter((e, idx) => e.hash !== prevHeads[idx].hash).length > 0 // Or if the heads are different than before merge
          //   if (shouldLoadFromHeads && newItemsCount > 1) {
          //     console.log("has new heads")
          //     setImmediate(() => this.sync(newHeads, null, this.options.maxHistory * 2, false, 32, currentCount))
          //   }
          // }
        }
      })
      // We should save the heads instead of the hash.
      .then(() => Log.toMultihash(this._ipfs, this._oplog))
      .then((hash) => {
        this._latestRemoteHead = hash
        return this._cache.set(this.dbname + '.remotehead', hash)
          .then(() => {
            // console.log("synced")
            this.events.emit('synced', this.dbname)
            return hash
          })
      })
      .catch((e) => this.events.emit('error', e))
  }

  _syncFromTails(tails, maxHistory, max, currentCount) {
    if (!tails)
      return Promise.resolve()

    maxHistory = maxHistory || this.options.maxHistory
    currentCount = currentCount || 0
    max = max ||this.options.maxHistory

    const exclude = this._oplog.items.map((e) => e.hash)

    // console.log("SYNC FROM TAILS", maxHistory)
    this.events.emit('sync', this.dbname)

    // const fetchLog = (hash) => Log.fromEntry(this._ipfs, hash, maxHistory, exclude, this._onLoadProgress.bind(this))
    const fetchLog = (hash) => Log.fromEntry(this._ipfs, hash, maxHistory, exclude, this._onSyncProgress.bind(this))

    return Promise.all(tails.map(fetchLog))
      .then((logs) => {
        const len = this._oplog.items.length
        const prevTails = this._oplog.tails.filter(e => e.next.length > 0)
          .sort((a, b) => b.clock.time - a.clock.time)
        const prevHeads = this._oplog.heads

        this._oplog = Log.joinAll([this._oplog].concat(logs), len + maxHistory, this._oplog.id)
        this._index.updateIndex(this._oplog)

        const newItemsCount = this._oplog.items.length - len
        // console.log("Synced from tails:", newItemsCount)
        currentCount += newItemsCount

        if (max === -1 || currentCount < max) {
          const newTails = this._oplog.tails.filter(e => e.next.length > 0)
            .sort((a, b) => b.clock.time - a.clock.time)

          const uniqueNewTails = newTails.filter((e) => !prevTails.map(a => a.hash).includes(e.hash))
          const newerTails = uniqueNewTails
            .map(e => newTails.map(a => a.hash).indexOf(e) !== 0 ? e : null)
            .filter(e => e !== null)
            .sort((a, b) => b.clock.time - a.clock.time)

          const hasNewerTails = uniqueNewTails.reduce((res, e) => {
            // True if tail doesn't exist (-1) or is at index > 0 (newer)
            return newTails.map(a => a.hash).indexOf(e) !== 0
          }, false)

          // hasNewerTails.log("we should fetch more tails?", isNewer, prevTails, newTails)
          if (hasNewerTails) {
            // console.log("has new tails 2", this.options.maxHistory, currentCount, max, newerTails, "--------", newTails)
            // setImmediate(() => this.sync(null, newerTails, this.options.maxHistory * 2, false, 32, currentCount))
          }
          console.log("has new tails 2", this.options.maxHistory, currentCount, max, newerTails, "--------", newTails)
          setImmediate(() => this.sync(null, newTails, this.options.maxHistory * 2, false, 32, currentCount))
        }
      })
      // We should save the heads instead of the hash.
      .then(() => Log.toMultihash(this._ipfs, this._oplog))
      .then((hash) => {
        this._latestRemoteHead = hash
        return this._cache.set(this.dbname + '.remotehead', hash)
          .then(() => {
            this.events.emit('synced', this.dbname)
            return hash
          })
      })
      .catch((e) => this.events.emit('error', e))
  }

  _addOperation(data, batchOperation, lastOperation, onProgressCallback) {
    let logHash
    if(this._oplog) {
      return Log.append(this._ipfs, this._oplog, data)
        .then((res) => {
          this._oplog = res
          return
        })
        .then(() => Log.toMultihash(this._ipfs, this._oplog))
        .then((hash) => logHash = hash)
        .then(() => {
          this._latestLocalHead = logHash
          this._cache.set(this.dbname + '.localhead', logHash)
        })
        .then(() => {
          const entry = this._oplog.items[this._oplog.items.length - 1]
          this._lastWrite.push(logHash)
          this._index.updateIndex(this._oplog)
          this.events.emit('write', this.dbname, logHash, entry, this._oplog.heads)
          if (onProgressCallback) onProgressCallback(entry)
          return entry.hash
        })
    }
  }

  _addOperationBatch(data, batchOperation, lastOperation, onProgressCallback) {
    let logHash
    if(this._oplog) {
      return Log.append(this._ipfs, this._oplog, data)
        .then((res) => {
          this._oplog = res
          return
        })
        .then(() => {
          if (!batchOperation || lastOperation) {
            return Log.toMultihash(this._ipfs, this._oplog)
              .then((hash) => {
                logHash = hash
                this._cache.set(this.dbname + '.localhead', logHash)
                  .then(() => {
                    this._index.updateIndex(this._oplog)
                    const entry = this._oplog.items[this._oplog.items.length - 1]
                    this.events.emit('write', this.dbname, logHash, entry, this._oplog.heads)
                  })
              })
          }
        })
        .then(() => {
          const entry = this._oplog.items[this._oplog.items.length - 1]
          this._lastWrite.push(logHash)
          if (onProgressCallback) onProgressCallback(entry)
          return entry.hash
        })
    }
  }

  _onLoadProgress (hash, entry, progress, total) {
    this.events.emit('load.progress', this.dbname, hash, entry, progress, total)
    this.events.emit('progress.load', this.dbname, hash, entry, progress, total)
  }

  _onSyncProgress (hash, entry, progress) {
    this.events.emit('sync.progress', this.dbname, hash, entry, progress)
  }
}

module.exports = Store
