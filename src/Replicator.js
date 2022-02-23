const PQueue = require('p-queue').default
const Log = require('ipfs-log')

const getNextAndRefsUnion = e => [...new Set([...e.next, ...e.refs])]
const flatMap = (res, val) => res.concat(val)

const defaultConcurrency = 32

class Replicator {
  constructor (store, concurrency) {
    this._store = store
    this._concurrency = concurrency || defaultConcurrency

    // Tasks processing queue where each log sync request is
    // added as a task that fetches the log
    this._q = new PQueue({ concurrency: this._concurrency })

    /* Internal caches */

    // For storing fetched logs before "load is complete".
    // Cleared when processing is complete.
    this._logs = []
    // Index of hashes (CIDs) for checking which entries are currently being fetched.
    // Hashes are added to this cache before fetching a log starts and removed after
    // the log was fetched.
    this._fetching = {}
    // Index of hashes (CIDs) for checking which entries have been fetched.
    // Cleared when processing is complete.
    this._fetched = {}

    // Listen for an event when the task queue has emptied
    // and all tasks have been processed. We call the
    // onReplicationComplete callback which then updates the Store's
    // state (eg. index, replication state, etc)
    this._q.on('idle', async () => {
      const logs = this._logs.slice()
      this._logs = []
      if (this.onReplicationComplete && logs.length > 0 && this._store._oplog) {
        try {
          await this.onReplicationComplete(logs)
          // Remove from internal cache
          logs.forEach(log => log.values.forEach(e => delete this._fetched[e.hash]))
        } catch (e) {
          console.error(e)
        }
      }
    })
  }

  /**
   * Returns the number of replication tasks running currently
   * @return {[Integer]} [Number of replication tasks running]
   */
  get tasksRunning () {
    return this._q.pending
  }

  /**
   * Returns the number of replication tasks currently queued
   * @return {[Integer]} [Number of replication tasks queued]
   */
  get tasksQueued () {
    return this._q.size
  }

  /**
   * Returns the hashes currently queued or being processed
   * @return {[Array]} [Strings of hashes of entries currently queued or being processed]
   */
  get unfinished () {
    return Object.keys(this._fetching)
  }

  /*
    Process new heads.
    Param 'entries' is an Array of Entry instances or strings (of CIDs).
   */
  async load (entries) {
    try {
      // Add entries to the replication queue
      this._addToQueue(entries)
    } catch (e) {
      console.error(e)
    }
  }

  async _addToQueue (entries) {
    // Function to determine if an entry should be fetched (ie. do we have it somewhere already?)
    const shouldExclude = (h) => h && this._store._oplog && (this._store._oplog.has(h) || this._fetching[h] !== undefined || this._fetched[h])

    // A task to process a given entries
    const createReplicationTask = (e) => {
      // Add to internal "currently fetching" cache
      this._fetching[e.hash || e] = true
      // The returned function is the processing function / task
      // to run concurrently
      return async () => {
        // Call onReplicationProgress only for entries that have .hash field,
        // if it is a string don't call it (added internally from .next)
        if (e.hash && this.onReplicationQueued) {
          this.onReplicationQueued(e)
        }
        try {
          // Replicate the log starting from the entry's hash (CID)
          const log = await this._replicateLog(e)
          // Add the fetched log to the internal cache to wait
          // for "onReplicationComplete"
          this._logs.push(log)
        } catch (e) {
          console.error(e)
          throw e
        }
        // Remove from internal cache
        delete this._fetching[e.hash || e]
      }
    }

    if (entries.length > 0) {
      // Create a processing tasks from each entry/hash that we
      // should include based on the exclusion filter function
      const tasks = entries
        .filter((e) => !shouldExclude(e.hash || e))
        .map((e) => createReplicationTask(e))
      // Add the tasks to the processing queue
      if (tasks.length > 0) {
        this._q.addAll(tasks)
      }
    }
  }

  async stop () {
    // Clear the task queue
    this._q.clear()
    // Reset internal caches
    this._logs = []
    this._fetching = {}
    this._fetched = {}
  }

  async _replicateLog (entry) {
    const hash = entry.hash || entry

    // Notify the Store that we made progress
    const onProgressCallback = (entry) => {
      this._fetched[entry.hash] = true
      if (this.onReplicationProgress) {
        this.onReplicationProgress(entry)
      }
    }

    const shouldExclude = (h) => h && h !== hash && this._store._oplog && (this._store._oplog.has(h) || this._fetching[h] !== undefined || this._fetched[h] !== undefined)

    // Fetch and load a log from the entry hash
    const log = await Log.fromEntryHash(
      this._store._ipfs,
      this._store.identity,
      hash,
      {
        logId: this._store.id,
        access: this._store.access,
        length: -1,
        exclude: [],
        shouldExclude,
        concurrency: this._concurrency,
        onProgressCallback
      }
    )

    // Return all next pointers
    const nexts = log.values.map(getNextAndRefsUnion).reduce(flatMap, [])
    try {
      // Add the next (hashes) to the processing queue
      this._addToQueue(nexts)
    } catch (e) {
      console.error(e)
      throw e
    }
    // Return the log
    return log
  }
}

module.exports = Replicator
