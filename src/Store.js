'use strict'

const EventEmitter = require('events').EventEmitter
const Log = require('ipfs-log')
const Entry = require('ipfs-log/src/entry')
const EntrySet = require('ipfs-log/src/entry-set')
const Cache = require('orbit-db-cache')
const Index = require('./Index')

const DefaultOptions = {
  Index: Index,
  maxHistory: 256,
  cachePath: './orbit-db'
}

class Store {
  constructor(ipfs, id, dbname, options) {
    this.id = id
    this.dbname = dbname || ''
    this.events = new EventEmitter()

    let opts = Object.assign({}, DefaultOptions)
    Object.assign(opts, options)

    this.options = opts
    this._ipfs = ipfs
    this._index = new this.options.Index(this.id)
    this._oplog = Log.create(this.id)
    this._lastWrite = []

    this._cache = new Cache(this.options.cachePath, this.dbname)
    this.syncing = false
    this.syncQueue = []
    setInterval(() => this._processQ(), 16)

    this.syncedOnce = false
  }

  load(amount) {
    let lastHash
    return this._cache.load()
      .then(() => this._cache.get(this.dbname))
      .then((hash) => {
        if (hash) {
          lastHash = hash
          this.events.emit('sync', this.dbname)
          return Log.fromMultihash(this._ipfs, hash, amount || this.options.maxHistory)
            .then((log) => {
              this._oplog = Log.join(this._oplog, log, -1, this._oplog.id)
              this._index.updateIndex(this._oplog)
              return this._oplog.heads
            })
        } else {
          return Promise.resolve()
        }
      })
      .then(() => {
        if (this._oplog.length > 0) {
          return Log.toMultihash(this._ipfs, this._oplog)
            .then((hash) => this._cache.set(this.dbname, hash))
        }
      })
      .then((heads) => this.events.emit('ready', this.dbname))
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

      if (allTails.keys.includes("QmdUMFtFdZTiaSmuomvB3QzrwpGakhqzvoJgmekHLZs2s6"))
        debugger

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
    if (!heads)
      return Promise.resolve()

    // TODO: doesn't need to return the log hash, that's already cached here
    const exclude = this._oplog.items.map((e) => e.hash)

    heads = heads.filter(e => e !== undefined && e !== null && Entry.isEntry(e))

    // If we have one of the heads, return
    // FIX: need to filter out the heads instead of returning
    if (heads.length === 0 || exclude.find((e) => heads.map((a) => a.hash).indexOf(e) > -1))
      return Promise.resolve()

    this.events.emit('sync', this.dbname)

    const saveToIpfs = (head) => {
      const e = Object.assign({}, head)
      e.hash = null
      return this._ipfs.object.put(new Buffer(JSON.stringify(e)))
        .then((dagObj) => dagObj.toJSON().multihash)
    }

    maxHistory = maxHistory || this.options.maxHistory
    currentCount = currentCount || 0
    max = max ||this.options.maxHistory

    // console.log("SYNC FROM", maxHistory, heads)
    return Promise.all(heads.map(saveToIpfs))
      .then((hashes) => {
        return Log.fromEntry(this._ipfs, heads, maxHistory, exclude, this._onLoadProgress.bind(this))
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

          if (this.options.syncHistory && (max === -1 || currentCount < max)) {
            const newTails = this._oplog.tails.filter(e => e.next.length > 0)
            const uniqueNewTails = newTails.filter((e) => !prevTails.map(a => a.hash).includes(e.hash))
            const newerTails = uniqueNewTails
              .map(e => newTails.map(a => a.hash).indexOf(e) !== 0 ? e : null)
              .filter(e => e !== null)

            const hasNewerTails = uniqueNewTails.reduce((res, e) => {
              // True if tail doesn't exist (-1) or is at index > 0 (newer)
              return newTails.map(a => a.hash).indexOf(e) !== 0
            }, false)

            // console.log("we should fetch more?", isNewer, newer.length, newer, prevTails, newTails)
            if (hasNewerTails) {
              this.sync(null, [newTails[newTails.length - 1]], this.options.maxHistory * 2, false, 32, currentCount)
              return
            }

            const newHeads = this._oplog.heads
            const shouldLoadFromHeads = prevHeads.length !== newHeads.length // If the length of the heads is different
              || newHeads.filter((e, idx) => e.hash !== prevHeads[idx].hash).length > 0 // Or if the heads are different than before merge
            if (shouldLoadFromHeads && newItemsCount > 1) {
              this.sync(newHeads, null, this.options.maxHistory * 2, false, 32, currentCount)
            }
          }
        }
      })
      // We should save the heads instead of the hash.
      .then(() => Log.toMultihash(this._ipfs, this._oplog))
      .then((hash) => {
        return this._cache.set(this.dbname, hash)
          .then(() => {
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

    // console.log("SYNC FROM TAILS", maxHistory, tails)
    this.events.emit('sync', this.dbname)

    const fetchLog = (hash) => Log.fromEntry(this._ipfs, hash, maxHistory, exclude, this._onLoadProgress.bind(this))

    return Promise.all(tails.map(fetchLog))
      .then((logs) => {
        const len = this._oplog.items.length
        const prevTails = this._oplog.tails.filter(e => e.next.length > 0)
        const prevHeads = this._oplog.heads

        this._oplog = Log.joinAll([this._oplog].concat(logs), len + maxHistory, this._oplog.id)
        this._index.updateIndex(this._oplog)

        const newItemsCount = this._oplog.items.length - len
        // console.log("Synced from tails:", newItemsCount)
        currentCount += newItemsCount

        if (max === -1 || currentCount < max) {
          const newTails = this._oplog.tails.filter(e => e.next.length > 0)
          const uniqueNewTails = newTails.filter((e) => !prevTails.map(a => a.hash).includes(e.hash))
          const newerTails = uniqueNewTails
            .map(e => newTails.map(a => a.hash).indexOf(e) !== 0 ? e : null)
            .filter(e => e !== null)

          const hasNewerTails = uniqueNewTails.reduce((res, e) => {
            // True if tail doesn't exist (-1) or is at index > 0 (newer)
            return newTails.map(a => a.hash).indexOf(e) !== 0
          }, false)

          // hasNewerTails.log("we should fetch more tails?", isNewer, prevTails, newTails)
          if (hasNewerTails) {
            this.sync(null, newerTails, this.options.maxHistory * 2, false, 32, currentCount)
          }
        }
      })
      // We should save the heads instead of the hash.
      .then(() => Log.toMultihash(this._ipfs, this._oplog))
      .then((hash) => {
        return this._cache.set(this.dbname, hash)
          .then(() => {
            this.events.emit('synced', this.dbname)
            return hash
          })
      })
      .catch((e) => this.events.emit('error', e))
  }

  _addOperation(data) {
    let logHash
    if(this._oplog) {
      return Log.append(this._ipfs, this._oplog, data)
        .then((res) => {
          this._oplog = res
          return
        })
        .then(() => Log.toMultihash(this._ipfs, this._oplog))
        .then((hash) => logHash = hash)
        .then(() => this._cache.set(this.dbname, logHash))
        .then(() => {
          const entry = this._oplog.items[this._oplog.items.length - 1]
          this._lastWrite.push(logHash)
          this._index.updateIndex(this._oplog)
          this.events.emit('write', this.dbname, logHash, entry, this._oplog.heads)
          return entry.hash
        })
    }
  }

  _onLoadProgress(hash, entry, parent, depth) {
    this.events.emit('load.progress', this.dbname, depth)
  }
}

module.exports = Store
