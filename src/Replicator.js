'use strict'

const EventEmitter = require('events').EventEmitter

class Replicator extends EventEmitter {
  constructor (loader, interval = 700) {
    super()
    this._loader = loader
    this._oplog = null
    this._interval = interval
    this._timer = null
  }

  start () {
    this._timer = setInterval(() => this._checkReplicationStatus(), this._interval)
  }

  stop () {
    clearInterval(this._timer)
  }

  /**
   * Set the [log] this [Replicator] should replicate.
   * @param  {[type]} log [description]
   * @event  {replicate}  [Emitted when Replicator has requested a log to be loaded from an entry.]
   */
  replicate (log) {
    this._oplog = log
  }

  async _checkReplicationStatus () {
    if (!this._oplog)
      return

    if (this._loader._queue.length === 0) {
      const sorted = this._oplog.tails
        .filter(e => e.next.length > 0)
        .sort((a, b) => a.clock.time - b.clock.time)

      const tails = sorted
        .reduce((res, acc) => res.concat(acc.next), [])
        .reduce((res, acc) => {
          if (!res.includes(acc))
            res.push(acc)
          return res
        }, [])

      tails.forEach(entry => {
        this._loader.load([entry])
      })
    }
  }
}

module.exports = Replicator
