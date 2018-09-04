'use strict'

const Log = require('ipfs-log')
const Logger = require('logplease')
const ReadableStream = require('readable-stream')

const logger = Logger.create('orbit-db.store.snapshotManager', { color: Logger.Colors.Blue })
Logger.setLogLevel('ERROR')

const toArrayBuffer = (buf) => {
  const ab = new ArrayBuffer(buf.length)
  const view = new Uint8Array(ab)
  for (var i = 0; i < buf.length; ++i) {
    view[i] = buf[i]
  }

  return ab
}

const addToStream = (rs, val) => {
  const str = new Buffer(JSON.stringify(val))
  const size = new Uint16Array([str.length])
  rs.push(new Buffer(size.buffer))
  rs.push(str)
}

class SnapshotManager {
  constructor(ipfs, store, cache, replicator) {
    super()

    if (!ipfs) throw new Error('Ipfs instance not defined')
    if (!store) throw new Error('Store instance not defined')
    if (!cache) throw new Error('Cache instance not defined')
    if (!replicator) throw new Error('Replicator instance not defined')

    this._ipfs = ipfs
    this._store = store
    cache = cache
    this._replicator = replicator
  }

  async saveSnapshot (ipfs, log, unfinished, storeType) {
    if (!ipfs) throw new Error('Ipfs instance not defined, could not save snapshot')
    if (!log) throw new Error('Oplog not defined, could not save snapshot')
    if (!storeType) throw new Error('Store type not defined, could not save snapshot')

    const snapshotData = log.toSnapshot()
    const header = Buffer.from(JSON.stringify({
      id: snapshotData.id,
      heads: snapshotData.heads,
      size: snapshotData.values.length,
      type: storeType,
    }))

    const stream = new ReadableStream()
    const size = new Uint16Array([header.length])
    const padding = new Buffer(size.buffer)
    stream.push(padding)
    stream.push(header)
    snapshotData.values.forEach(addToStream)
    stream.push(null) // tell the stream we're finished

    const snapshot = await this._ipfs.files.add(rs)
    await cache.set('snapshot', snapshot[snapshot.length - 1])
    await cache.set('queue', unfinished)

    logger.debug(`Saved snapshot: ${snapshot[snapshot.length - 1].hash}, queue length: ${unfinished.length}`)

    return snapshot
  }

  _parseSnapshotHeader (buffer) {
    const headerSize = parseInt(new Uint16Array(toArrayBuffer(buffer.slice(0, 2))))
    const offset = 2
    let header
    try {
      header = JSON.parse(buffer.slice(offset, headerSize + offset))
    } catch (e) {
      // TODO: Decide how to handle JSON parsing errors here
    }

    return {
      header,
      size: headerSize
    }
  }

  _parseSnapshotBody (headerSize, buffer) {
    const values = []
    const padding = 2
    const offset = padding + headerSize

    while (offset < buffer.length) {
      const length = parseInt(new Uint16Array(toArrayBuffer(buffer.slice(offset, offset + padding))))
      offset += padding
      try {
        const chunk = buffer.slice(offset, offset + length)
        const data = JSON.parse(chunk)
        values.push(data)
      } catch (e) {
        // TODO: Decide how to handle JSON parsing errors here
      }
      offset += length
    }

    return values
  }

  async _parseSnapshotDataStream (stream) {
    return new Promise((resolve, reject) => {
      let buffer = new Buffer(0)
      let queue = []
      const watermark = 20000
      const bufferData = data => {
        if (queue.length < watermark) {
          queue.push(data)
        } else {
          const enqueued = Buffer.concat(queue)
          buffer = Buffer.concat([buffer, enqueued])
          queue = []
        }
      }

      const done = () => {
        if (queue.length > 0) {
          const enqueued = Buffer.concat(queue)
          buffer = Buffer.concat([buffer, enqueued])
        }

        const { header, size: headerSize } = this._parseSnapshotHeader(buffer)
        const values = this._parseSnapshotBody(headerSize, buffer)
        if (header) {
          const { heads, id, type } = header
          resolve({ values, id, heads, type })
        } else {
          resolve({ values, id: null, heads: null, type: null })
        }
      }

      stream.on('data', bufferData)
      stream.on('end', done)
    })
  }

  async loadSnapshot (ipfs, cache, queue, address) {
    const snapshot = await cache.get('snapshot')
    if (!snapshot) throw new Error(`Snapshot for ${address} not found!`)
    const stream = await ipfs.files.catReadableStream(snapshot.hash)
    return this._parseSnapshotDataStream(stream)
  }
}

module.exports = SnapshotManager
