const EventEmitter = require('events').EventEmitter
const Log = require('ipfs-log')

const batchSize = 1

class Loader extends EventEmitter {
  constructor (store, concurrency = 8) {
    super()
    this._store = store
    this._concurrency = concurrency

    this._queue = []
    this._fetching = {}
    this._tasksRunning = 0

    this._have = {}
    this._stats = {
      tasksProcessed: 0,
      tasksRequested: 0,
    }

    // Start the internal queue processing loop
    this._timer = setInterval(() => {
      if (this._queue.length > 0 && this._tasksRunning < this._concurrency)
        this._processLoop()
    }, 2)

    // // Debug print to output Replicator's status
    // this._debugTimer = setInterval(() => {
    //   console.log("[LOADER] tasksRequested:", this._stats.tasksRequested, "tasksProcessed:", this._stats.tasksProcessed, "tasksRunning:", this._tasksRunning, "queued:", this._queue.length, "oplog:", this._store._oplog.length)
    // }, 5000)
  }

  stop () {
    clearInterval(this._timer)
    clearInterval(this._debugTimer)
  }

  /*
    Process new heads.
   */
  load (entries) {
    this._stats.tasksRequested += 1
    entries
      .filter(entry => entry !== null && entry !== undefined)
      .sort((a, b) => (a.clock ? a.clock.time : 0) - (b.clock ? b.clock.time : 0))
      .forEach(entry => {
        if (!this._store._oplog.has(entry.hash || entry)
          && !this._queue.find((e) => (e.hash || e) === (entry.hash || entry))) {
          // Put the entries in front of the queue
          this._queue.splice(0, 0, entry)
          // this._stats.tasksRequested += 1
          this.emit('load.added', entry)
        }
    })
  }

  async _processLoop () {
    if (this._queue.length > 0 && this._tasksRunning < this._concurrency) {
      this._tasksRunning ++
      try {
        const getNext = () => {
          // Filter out all items that are currently being fetched
          this._queue = this._queue.filter(t => !this._fetching[t.hash || t])
          const task = this._queue.shift()
          if (task) {
            this._fetching[task.hash || task] = task
          }
          return task
        }

        const task = getNext()

        if (task) {
          const hash = task.hash || task
          const exclude = []//this._store._oplog.values

          this._have = Object.assign({}, this._have, this._store._replicationInfo.have)
          this.emit('load.start', task, this._have)
          const log = await Log.fromEntryHash(this._store._ipfs, hash, this._store._oplog.id, batchSize, exclude, this._onSyncProgress.bind(this))

          this._stats.tasksProcessed += 1
          delete this._fetching[hash]
          this.emit('load.end', log, this._have)
        }
      } catch (e) {
        console.error("LOADER-ERROR:", e)
        this.emit('error', e)
      }
      this._tasksRunning --
      this.emit('load.complete', this._have)
    }
  }

  _onSyncProgress (hash, entry, progress) {
    if (!this._have[entry.clock.time]) {
      this._have[entry.clock.time] = true
      this.emit('load.progress', this._id, hash, entry, progress, this._have)
    }
  }
}

module.exports = Loader
