'use strict';

const EventEmitter = require('events').EventEmitter;
const Log          = require('ipfs-log');
const Index        = require('./Index');
const Cache        = require('./Cache');

const DefaultMaxHistory = 256;

class Store {
  constructor(ipfs, id, dbname, options) {
    this.id = id;
    this.dbname = dbname;
    this.events = new EventEmitter();

    if(!options) options = {};
    if(options.Index === undefined) Object.assign(options, { Index: Index });
    if(options.cacheFile === undefined) Object.assign(options, { cacheFile: null });
    if(options.maxHistory === undefined) Object.assign(options, { maxHistory: DefaultMaxHistory });

    this.options = options;
    this._ipfs = ipfs;
    this._index = new this.options.Index(this.id);
    this._oplog = new Log(this._ipfs, this.id, this.dbname, this.options);
    this._lastWrite = [];
  }

  loadHistory(hash) {
    if(this._lastWrite.indexOf(hash) > -1)
      return Promise.resolve([]);

    this.events.emit('load', this.dbname);

    return Cache.loadCache(this.options.cacheFile).then(() => {
      const cached = hash || Cache.get(this.dbname);
      // console.log("CACHED!", hash, cached)
      if(cached) {
        if(this._lastWrite.indexOf(cached) > -1) this._lastWrite.push(cached);
        return Log.fromIpfsHash(this._ipfs, cached, this.options)
          .then((log) => this._oplog.join(log))
          .then((merged) => {
            this._index.updateIndex(this._oplog, merged)
            this.events.emit('history', this.dbname, merged)
          })
          .then(() => this.events.emit('ready', this.dbname))
          .then(() => this)
      }

      this.events.emit('ready', this.dbname)
      return Promise.resolve(this);
    });
  }

  close() {
    this.delete();
    this.events.emit('close', this.dbname);
  }

  sync(hash) {
    if(!hash || this._lastWrite.indexOf(hash) > -1) {
      // this.events.emit('data', this.dbname);
      return Promise.resolve([]);
    }

    let newItems = [];
    this.events.emit('sync', this.dbname);
    this._lastWrite.push(hash);
    const startTime = new Date().getTime();
    return Log.fromIpfsHash(this._ipfs, hash, this.options)
      .then((log) => this._oplog.join(log))
      .then((merged) => newItems = merged)
      .then(() => Cache.set(this.dbname, hash))
      .then(() => this._index.updateIndex(this._oplog, newItems))
      .then(() => {
        // if(newItems.length > 0) {
        //   console.log("Sync took", (new Date().getTime() - startTime) + "ms", this.id)
        // }
        newItems.reverse().forEach((e) => this.events.emit('data', this.dbname, e))
      })
      .then(() => newItems)
  }

  delete() {
    this._index = new this.options.Index(this.id);
    this._oplog = new Log(this._ipfs, this.id, this.dbname, this.options);
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
        .then(() => this.events.emit('write', this.dbname, logHash))
        .then(() => this.events.emit('data', this.dbname, result))
        .then(() => result.hash);
    }
  }
}

module.exports = Store;
