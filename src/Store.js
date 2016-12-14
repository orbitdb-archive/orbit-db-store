'use strict'

const EventEmitter = require('events').EventEmitter
const Log          = require('ipfs-log')
const Index        = require('./Index')

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
    this._oplog = new Log(this._ipfs, this.id, this.options)
    this._lastWrite = []

    this._oplog.events.on('history', this._onLoadHistory.bind(this))
    this._oplog.events.on('progress', this._onLoadProgress.bind(this))
  }

  _onLoadHistory(amount) {
    this.events.emit('load.start', this.dbname, amount)
  }

  _onLoadProgress(amount) {
    this.events.emit('load.progress', this.dbname, amount)
  }

  loadHistory(hash) {
    if(this._lastWrite.includes(hash))
      return Promise.resolve([])

    if(hash) this._lastWrite.push(hash)

    if(hash && this.options.maxHistory > 0) {
      this.events.emit('load', this.dbname, hash)
      return Log.fromIpfsHash(this._ipfs, hash, this.options)
        .then((log) => {
          // this._oplog.events.on('history', this._onLoadHistory.bind(this))
          // this._oplog.events.on('progress', this._onLoadProgress.bind(this))
          return this._oplog.join(log)
        })
        .then((merged) => {
          // this._oplog.events.removeListener('history', this._onLoadHistory)
          // this._oplog.events.removeListener('progress', this._onLoadProgress)
          this._index.updateIndex(this._oplog, merged)
          this.events.emit('history', this.dbname, merged)
          this.events.emit('load.end', this.dbname, merged)
        })
        .then(() => this.events.emit('ready', this.dbname))
        .then(() => this)
    } else {
      this.events.emit('ready', this.dbname)
      return Promise.resolve(this)
    }
  }

  sync(hash) {
    if(!hash || this._lastWrite.includes(hash))
      return Promise.resolve([])

    let newItems = []
    if(hash) this._lastWrite.push(hash)
    this.events.emit('sync', this.dbname)
    const startTime = new Date().getTime()
    return Log.fromIpfsHash(this._ipfs, hash, this.options)
        .then((log) => {
          // this._oplog.events.on('history', this._onLoadHistory.bind(this))
          // this._oplog.events.on('progress', this._onLoadProgress.bind(this))
          return this._oplog.join(log)
        })
        .then((merged) => {
          // this._oplog.events.removeListener('history', this._onLoadHistory)
          // this._oplog.events.removeListener('progress', this._onLoadProgress)
          newItems = merged
          this._index.updateIndex(this._oplog, newItems)
          this.events.emit('load.end', this.dbname, newItems)
        })

      // .then((log) => this._oplog.join(log))
      // .then((merged) => newItems = merged)
      // .then(() => this._index.updateIndex(this._oplog, newItems))
      .then(() => {
        this.events.emit('history', this.dbname, newItems)
        // newItems.reverse()
        //   .forEach((e) => this.events.emit('data', this.dbname, e))
      })
      .then(() => newItems)
  }

  close() {
    this.delete()
    this.events.emit('close', this.dbname)
  }

  // TODO: should make private?
  delete() {
    this._index = new this.options.Index(this.id)
    this._oplog = new Log(this._ipfs, this.id, this.options)
  }

  _addOperation(data) {
    let result, logHash
    if(this._oplog) {
      return this._oplog.add(data)
        .then((res) => result = res)
        .then(() => Log.getIpfsHash(this._ipfs, this._oplog))
        .then((hash) => logHash = hash)
        .then(() => this._lastWrite.push(logHash))
        .then(() => this._index.updateIndex(this._oplog, [result]))
        .then(() => this.events.emit('write', this.dbname, logHash))
        .then(() => this.events.emit('data', this.dbname, result))
        .then(() => result.hash)
    }
  }
}

module.exports = Store
