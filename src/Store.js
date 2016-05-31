'use strict';

const EventEmitter = require('events').EventEmitter;
const Log          = require('ipfs-log');
const Index        = require('./Index');
const Cache        = require('./Cache');

class Store {
  constructor(ipfs, id, dbname, options) {
    this.id = id;
    this.dbname = dbname;
    this.events = new EventEmitter();

    if(!options) options = {};
    if(!options.Index) Object.assign(options, { Index: Index });
    if(!options.cacheFile) Object.assign(options, { cacheFile: null });

    this.options = options;
    this._index = new this.options.Index(this.id);
    this._oplog = null;
    this._ipfs = ipfs;
    this._lastWrite = [];
  }

  use() {
    this.events.emit('load', this.dbname);
    this._oplog = new Log(this._ipfs, this.id, this.dbname, this.options);
    return Cache.loadCache(this.options.cacheFile).then(() => {
      const cached = Cache.get(this.dbname);
      if(cached) {
        this._lastWrite.push(cached);
        return Log.fromIpfsHash(this._ipfs, cached)
          .then((log) => this._oplog.join(log))
          .then((merged) => this._index.updateIndex(this._oplog, merged))
          .then(() => this.events.emit('ready', this.dbname))
          .then(() => this)
      }

      this.events.emit('ready', this.dbname)
      return Promise.resolve(this);
    });
  }

  close() {
    this.events.emit('close', this.dbname);
  }

  sync(hash) {
    // if(!hash || this._lastWrite.indexOf(hash) > -1) {
    if(!hash) {
      this.events.emit('updated', this.dbname, []);
      return Promise.resolve([]);
    }

    const oldCount = this._oplog.items.length;
    let newItems = [];
    this.events.emit('sync', this.dbname);
    this._lastWrite.push(hash);
    const startTime = new Date().getTime();
    return Log.fromIpfsHash(this._ipfs, hash)
      .then((log) => this._oplog.join(log))
      .then((merged) => newItems = merged)
      .then(() => Cache.set(this.dbname, hash))
      .then(() => this._index.updateIndex(this._oplog, newItems))
      .then(() => {
        if(newItems.length > 0) {
          console.log("Sync took", (new Date().getTime() - startTime) + "ms", this.id)
        }
        this.events.emit('updated', this.dbname, newItems);
      })
      .then(() => newItems)
  }

  delete() {
    this._index = new this.options.Index(this.id);
    if(this._oplog)
      this._oplog.clear();
  }

  _addOperation(data) {
    let result, logHash;
    if(this._oplog) {
      return this._oplog.add(data)
        .then((res) => result = res)
        .then(() => Log.getIpfsHash(this._ipfs, this._oplog))
        .then((hash) => logHash = hash)
        .then(() => this._lastWrite.push(logHash))
        .then(() => Cache.set(this.dbname, logHash))
        .then(() => this._index.updateIndex(this._oplog, [result]))
        .then(() => this.events.emit('data', this.dbname, logHash))
        .then(() => result.hash);
    }
  }
}

module.exports = Store;
