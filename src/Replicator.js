const EventEmitter = require('events').EventEmitter
const pMap = require('p-map')
const Log = require('ipfs-log')

const Logger = require('logplease')
const logger = Logger.create('replicator', { color: Logger.Colors.Cyan })
Logger.setLogLevel('ERROR')

const getNext = e => e.next.concat(e.refs)
const flatMap = (res, val) => res.concat(val)
const notNull = entry => entry !== null && entry !== undefined
const uniqueValues = (res, val) => {
  res[val] = val
  return res
}

const batchSize = 8

class Replicator extends EventEmitter {
  constructor (store, concurrency) {
    super()
    this._store = store
    this._stats = {
      tasksRequested: 0,
      tasksStarted: 0,
      tasksProcessed: 0
    }
    this._buffer = []
    this._buffered = 0
    this._concurrency = concurrency || 32
    this._queue = {}
    this._fetching = {}
    this._fetched = {}
  }

  /**
   * Returns the number of tasks started during the life time
   * @return {[Integer]} [Number of tasks started]
   */
  get tasksRequested () {
    return this._stats.tasksRequested
  }

  /**
   * Returns the number of tasks started during the life time
   * @return {[Integer]} [Number of tasks running]
   */
  get tasksStarted () {
    return this._stats.tasksStarted
  }

  /**
   * Returns the number of tasks running currently
   * @return {[Integer]} [Number of tasks running]
   */
  get tasksRunning () {
    return this._stats.tasksStarted - this._stats.tasksProcessed
  }

  /**
   * Returns the number of tasks currently queued
   * @return {[Integer]} [Number of tasks queued]
   */
  get tasksQueued () {
    return Math.max(Object.keys(this._queue).length - this.tasksRunning, 0)
  }

  /**
   * Returns the number of tasks finished during the life time
   * @return {[Integer]} [Number of tasks finished]
   */
  get tasksFinished () {
    return this._stats.tasksProcessed
  }

  /**
   * Returns the hashes currently queued
   * @return {[Array<String>]} [Queued hashes]
   */
  getQueue () {
    return Object.values(this._queue)
  }

  /*
    Process new heads.
   */
  load (entries) {
    try {
      const previousQueueLength = Object.keys(this._queue).length
      entries.forEach(this._addToQueue.bind(this))
      if (previousQueueLength === 0 && entries.length > 0) {
        setTimeout(() => this._processQueue(), 0)
      }
    } catch (e) {
      console.error(e)
    }
  }

  stop () {
    // Remove event listeners
    this.removeAllListeners('load.added')
    this.removeAllListeners('load.end')
    this.removeAllListeners('load.progress')
  }

  _addToQueue (entry) {
    if (entry) {
      const hash = entry.hash || entry
      if (!this._store._oplog.has(hash) && !this._fetching[hash] && !this._queue[hash] && !this._fetched[hash]) {
        this._stats.tasksRequested += 1
        this._queue[hash] = entry
        if (entry.hash) {
          this.emit('load.added', entry)
        }
      }
    }
  }

  async _processQueue () {
      const items = Object.values(this._queue).slice(-(this._concurrency))
      // const items = Object.values(this._queue).slice(-1)
      // const items = Object.values(this._queue).slice(0, 1)
      items.forEach(entry => delete this._queue[entry.hash || entry])

      const processAndLoadNext = async (nexts) => {
        if ((items.length > 0 && this._buffer.length > 0) ||
        (this.tasksRunning === 0 && this._buffer.length > 0)) {
        // (Object.keys(this._queue).length === 0 && this._buffer.length > 0)) {
          const logs = this._buffer.slice()
          this._buffer = []
          this._buffered = 0
          if (this.onLoadCompleted) {
            await this.onLoadCompleted(logs)
          }
          this.emit('load.end', logs)
        }

        nexts = nexts.reduce(flatMap, [])

        if (nexts.length > 0) {
          this.load(nexts)
        }
      }

      const nexts = await pMap(items, e => this._processOne(e), { concurrency: this._concurrency })
      // const nexts = await pMap(items, e => this._processOne(e), { concurrency: 2 })
      // const nexts = await pMap(items, e => this._processOne(e), { concurrency: 1 })
      await processAndLoadNext(nexts)
      // this needs to happen after processAndLoadNext() call, because we check the nexts passed to processAndLoadNext() against this._fetching
      items.forEach(e => delete this._fetching[e.hash || e])
      items.forEach(e => delete this._fetched[e.hash || e])
      if (Object.keys(this._queue).length > 0) {
        setTimeout(() => this._processQueue(), 0)
      }
  }

  async _processOne (entry) {
    const hash = entry.hash || entry

    if (this._store._oplog.has(hash) || this._fetching[hash]) {
      return
    }

    this._stats.tasksStarted += 1

    // const entriesToExclude = Object.assign({}, this._fetching, this._queue, this._store._oplog._entryIndex._cache)
    // const entriesToExclude = Object.assign({}, this._fetching, this._store._oplog._entryIndex._cache)
    // const entriesToExclude = Object.assign({}, this._store._oplog._entryIndex._cache)
    // const exclude = Object.values(entriesToExclude)

    this._fetching[hash] = entry

    // Notify the store that we made progress
    const onProgressCallback = (hash, entry) => {
      // console.log(">>", entry.payload.value)
      this._fetched[hash] = entry
      this.emit('load.progress', this._id, hash, entry)
    }

    const shouldExclude = (h) => h && h !== hash && (this._store._oplog.has(h) || this._fetching[h] !== undefined || this._fetched[h] !== undefined || this._buffer.map(e => e.has(h)).includes(true))

    // Load the log from the entry hash
    // console.log("------------------", entry.payload ? entry.payload.value : entry)
    const log = await Log.fromEntryHash(
      this._store._ipfs,
      this._store.identity,
      hash,
      { 
        logId: this._store._oplog.id,
        access: this._store.access,
        length: -1,
        exclude: [],
        shouldExclude,
        concurrency: this._concurrency,
        // concurrency: 1,
        onProgressCallback
      }
    )
    // console.log("------------------", entry.payload ? entry.payload.value : entry)

    // Add the log to the internal buffer to be returned to the store
    this._buffer.push(log)
    this._buffered += log.length

    // Mark this task as processed
    this._stats.tasksProcessed += 1

    // console.log("------------------", entry.payload.value)
    // Return all next pointers
    const values = log.values
    const nexts = values.map(getNext).reduce(flatMap, [])
    // values.forEach(e => (delete this._fetched[e.hash]))
    return nexts
  }
}

module.exports = Replicator
