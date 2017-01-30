'use strict'

const EventEmitter = require('events').EventEmitter
const Log = require('ipfs-log')
const Index = require('./Index')

const DefaultOptions = {
  Index: Index,
  maxHistory: 256
}

class Store {
  constructor(ipfs, id, dbname, options = {}) {
    this.id = id
    this.dbname = dbname
    this.events = new EventEmitter()

    let opts = Object.assign({}, DefaultOptions)
    Object.assign(opts, options)

    this.options = opts
    this._ipfs = ipfs
    this._index = new this.options.Index(this.id)
    this._oplog = Log.create(this._ipfs)
    this._lastWrite = []
  }

  sync(hash, maxHistory = -1) {
    if(!hash || this._lastWrite.includes(hash) || maxHistory === 0) {
      this.events.emit('ready', this.dbname)
      return Promise.resolve(hash)
    }

    if(hash) this._lastWrite.push(hash)
    this.events.emit('sync', this.dbname)
    return this._mergeWith(hash, maxHistory)
      .then(() => {
        this.events.emit('ready', this.dbname)
        return Log.toMultihash(this._ipfs, this._oplog)
      })
  }

  _mergeWith(hash, maxHistory) {
    return Log.fromMultihash(this._ipfs, hash, maxHistory, this._onLoadProgress.bind(this))
      .then((log) => {
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
        .then((hash) => {
          this._lastWrite.push(hash)
          this._index.updateIndex(this._oplog)
          this.events.emit('write', this.dbname, hash, this._oplog.toJSON())
          return this._oplog.items[this._oplog.items.length - 1].hash
        })
    }
  }

  _onLoadProgress(hash, entry, parent, depth) {
    this.events.emit('load.progress', this.dbname, depth)
  }
}

module.exports = Store
