'use strict'

const EventEmitter = require('events').EventEmitter
const Log = require('ipfs-log')
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
    this._oplog = Log.create()
    this._lastWrite = []

    this._cache = new Cache(this.options.cachePath, this.dbname)
  }

  load() {
    return this._cache.load()
      .then(() => {
        const hash = this._cache.get(this.dbname)
        return this.sync(hash, this.options.maxHistory)
      })
      .then(() => this.events.emit('ready'))
  }

  loadMore(amount) {
    this.events.emit('sync', this.dbname)
    return Log.expand(this._ipfs, this._oplog, amount)
      .then((log) => {
        const len = this._oplog.items.length
        this._oplog = log
        this._index.updateIndex(this._oplog)
        if (log.items.length > len)
          this.events.emit('synced', this.dbname)
      })
  }

  sync(hash, maxHistory = -1) {
    if(!hash || this._lastWrite.includes(hash) || maxHistory === 0) {
      // this.events.emit('synced', this.dbname)
      return Promise.resolve(hash)
    }

    if(hash) this._lastWrite.push(hash)
    this.events.emit('sync', this.dbname)

    // TODO: doesn't need to return the log hash, that's already cached here
    return this._mergeWith(hash, this.options.maxHistory)
      .then(() => Log.toMultihash(this._ipfs, this._oplog))
      .then((hash) => {
        return this._cache.set(this.dbname, hash)
          .then(() => {
            this.events.emit('synced', this.dbname)
            return hash
          })
      })
  }

  _mergeWith(hash, maxHistory) {
    const exclude = this._oplog.items.map((e) => e.hash)
    return Log.fromMultihash(this._ipfs, hash, maxHistory, exclude, this._onLoadProgress.bind(this))
      .then((log) => {
        const len = this._oplog.items.length
        this._oplog = Log.join(this._ipfs, this._oplog, log)
        this._index.updateIndex(this._oplog)
        return this
      })
  }

  _addOperation(data) {
    let logHash
    if(this._oplog) {
      return Log.append(this._ipfs, this._oplog, data)
        .then((res) => this._oplog = res)
        .then(() => Log.toMultihash(this._ipfs, this._oplog))
        .then((hash) => logHash = hash)
        .then(() => this._cache.set(this.dbname, logHash))
        .then(() => {
          const entryHash = this._oplog.items[this._oplog.items.length - 1].hash
          this._lastWrite.push(logHash)
          this._index.updateIndex(this._oplog)
          this.events.emit('write', this.dbname, logHash, this._oplog.items[this._oplog.items.length - 1])
          return entryHash
        })
    }
  }

  _onLoadProgress(hash, entry, parent, depth) {
    this.events.emit('load.progress', this.dbname, depth)
  }
}

module.exports = Store
