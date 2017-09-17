'use strict'

const path = require('path')
const multihash = require('multihashes')

function parseAddress (address, id = '') {
  if (!address) 
    throw new Error(`not a valid orbit-db address: ${address}`)

  const parts = address
    .split('/')
    .filter((e, i) => !((i === 0 || i === 1) && address.indexOf('/orbit') === 0 && e === 'orbitdb'))
    .filter(e => e !== '' && e !== ' ')

  // Check if a multihash (db owner id) was given as part of the address
  const hash = parts[0].indexOf('Qm') > -1 ? multihash.fromB58String(parts[0]) : null
  let isMultihash = false
  try {
    multihash.validate(hash)
    isMultihash = true
  } catch (e) {
    // It's ok if validate throws, we consider it not the db owner id
  }

  let addr = {
    protocol: '/orbitdb',
    root: isMultihash ? multihash.toB58String(hash) : id,
    name: isMultihash ? parts.slice(1, parts.length).join('/') : parts.join('/'),
  }

  return path.join(addr.protocol, addr.root, addr.name)
}

module.exports = parseAddress
