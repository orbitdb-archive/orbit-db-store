# orbit-db-store

[![npm version](https://badge.fury.io/js/orbit-db-store.svg)](https://badge.fury.io/js/orbit-db-store) [![Gitter](https://img.shields.io/gitter/room/nwjs/nw.js.svg)](https://gitter.im/orbitdb/Lobby) [![Matrix](https://img.shields.io/badge/matrix-%23orbitdb%3Apermaweb.io-blue.svg)](https://riot.permaweb.io/#/room/#orbitdb:permaweb.io) [![Discord](https://img.shields.io/discord/475789330380488707?color=blueviolet&label=discord)](https://discord.gg/cscuf5T)

Base class for [orbit-db](https://github.com/orbitdb/orbit-db) data stores. You generally don't need to use this module if you want to use `orbit-db`. This module contains shared methods between all data stores in `orbit-db` and can be used as a base class for a new data model.

### Used in
- [orbit-db-kvstore](https://github.com/orbitdb/orbit-db-kvstore)
- [orbit-db-eventstore](https://github.com/orbitdb/orbit-db-eventstore)
- [orbit-db-feedstore](https://github.com/orbitdb/orbit-db-feedstore)
- [orbit-db-counterstore](https://github.com/orbitdb/orbit-db-counterstore)
- [orbit-db-docstore](https://github.com/orbitdb/orbit-db-docstore)

### Requirements

- Node.js >= 8.0.0

## Table of Contents

<!-- toc -->

- [API](#api)
  * [constructor(ipfs, peerId, address, options)](#constructoripfs-peerid-address-options)
  * [Public methods](#public-methods)
    + [load([amount])](#loadamount)
    + [loadMoreFrom(amount, entries)](#loadmorefromamount-entries)
    + [saveSnapshot()](#savesnapshot)
    + [loadFromSnapshot()](#loadfromsnapshot)
    + [close()](#close)
    + [drop()](#drop)
    + [sync(heads)](#syncheads)
  * [Properties](#properties)
    + [address](#address)
    + [key](#key)
    + [all](#all)
    + [type](#type)
    + [replicationStatus](#replicationstatus)
  * [Events](#events)
  * [Private methods](#private-methods)
    + [_addOperation(data)](#_addoperationdata)
  * [Creating Custom Data Stores](#creating-custom-data-stores)
- [Contributing](#contributing)
- [License](#license)

<!-- tocstop -->

## API

### constructor(ipfs, identity, address, options)

**ipfs** can be an [IPFS](https://github.com/ipfs/js-ipfs) instance or an [IPFS-API](https://github.com/ipfs/js-ipfs) instance. **identity** is an instance of [Identity](https://github.com/orbitdb/orbit-db-identity-provider/). **address** is the OrbitDB address to be used for the store.

`options` is an object with the following required properties:

- `cache`: A [Cache](https://github.com/orbitdb/orbit-db-cache) instance to use for storing heads and snapshots.
- `Index` : By default it uses an instance of [Index](https://github.com/orbitdb/orbit-db-store/blob/master/src/Index.js).

the following properties are optional:

- `maxHistory` (Integer): The number of entries to load (Default: `-1`).
- `referenceCount` (Integer): The number of previous ipfs-log entries a new entry should reference (Default: `64`).
- `replicationConcurrency` (Integer): The number of concurrent replication processes (Default: `128`).
- `accessController` (Object): An instance of AccessController with the following [interface](https://github.com/orbitdb/orbit-db-access-controllers/blob/master/src/access-controller-interface.js). See [orbit-db-access-controllers](https://github.com/orbitdb/orbit-db-access-controllers) for more information on how to create custom access controllers. By default only the owner will have write access.
- `onClose` (Function): A function to be called with a string of the OrbitDB address of the database that is closing.

### Public methods

#### load([amount])
> Load the database using locally persisted state.

Returns a **Promise** that resolves once complete. Provide an `amount` argument to specify how many entries to load.

#### loadMoreFrom(amount, entries)
> TODO

```javascript
//TODO
db.loadMoreFrom()
```

#### saveSnapshot()
> Save the current state of the database locally.

Returns a **Promise** that resolves to an array containing an object with the following properties:

- `path` of the snapshot file
- `hash` representing the IPFS Multihash (as a Base58 encoded string) of the snapshot file
- `size` of the snapshot file

#### loadFromSnapshot()
> Load the state of the database from a snapshot.

Returns a **Promise** that resolves to a store instance once it has been loaded.

#### close()
> Uninitialize the store.

Returns a **promise** that resolves once complete. Emits `close` after the store has been uninitialized.

#### drop()
> Remove the database locally.

Returns a **promise** that resolves once complete. This doesn't remove or delete the database from peers who have replicated the database.

#### sync(heads)
> Sync this database with entries from **heads** where **heads** is an array of ipfs-log Entries.

Usually, you don't need to call this method manually as OrbitDB takes care of this for you.

### Properties

#### address
> Get the address of this database.

Returns an object `{ root: <manifestHash>, path: <path> }`. Convert to a string with `db.address.toString()`.

```javascript
console.log(db.address.toString())
// /orbitdb/zdpuB383kQWjyCd5nv4FKqZwe2FH4nqxBBE7kzoDrmdtZ6GPu/databaseName
```

##### `identity`

Each store has an `identity` property containing the public key used with this store to sign and access entries. This `publicKey` property of `identity` is the peer/node/user key.

```javascript
console.log(db.identity.publicKey)
// 042c07044e7ea51a489c02854db5e09f0191690dc59db0afd95328c9db614a2976e088cab7c86d7e48183191258fc59dc699653508ce25bf0369d67f33d5d77839
```

#### all
> Get all of the entries in the store index

Returns an array of all store entries within the index.

```javascript
db.all
```

#### type
> Get the store type

Returns a string of the type of datastore model of the current instance.

```javascript
console.log(db.type) // "eventlog"
```

#### replicationStatus
> Get database replication status information such as total number of entries and loading progress.

Returns an instance of [ReplicationInfo](https://github.com/orbitdb/orbit-db-store/blob/master/src/replication-info.js).

```javascript
console.log(db.replicationStatus)
// { buffered: 0, queued: 0, progress: 2, max: 5 }
```

### Events

  Store has an `events` ([EventEmitter](https://nodejs.org/api/events.html)) object that emits events that describe what's happening in the database.

  - `load` - (address, heads)

    Emitted before loading the database history. **address** is a string of the OrbitDB address being loaded. **heads** is an array of ipfs-log Entries from which the history is loaded from. **heads** is omitted when this event is emitted as a result of `loadFromSnapshot`.

    ```javascript
    db.events.on('load', (address, heads) => ... )
    db.load()
    ```

  - `ready` - (address, heads)

    Emitted after fully loading the database history. **address** is a string of the OrbitDB address that emitted the event. **heads** is an array of ipfs-log Entries.

    ```javascript
    db.events.on('ready', (address, heads) => ... )
    db.load()
    ```

  - `load.progress` - (address, hash, entry, progress, total)

    Emitted for each entry during load. **address** is a string of the OrbitDB address that emitted the event. **hash** is the multihash of the entry that was just loaded. **entry** is the ipfs-log Entry that was loaded. **Progress** is the current load count. **Total** is the maximum load count (ie. length of the full database). These are useful eg. for displaying a load progress percentage.

    ```javascript
    db.events.on('load.progress', (address, hash, entry, progress, total) => ... )
    db.load()
    ```

  - `replicate` - (address, entry)

    Emitted before replicating a part of the database. **address** is a string of the OrbitDB address that emitted the event. **entry** is the ipfs-log Entry that is being processed.

    ```javascript
    db.events.on('replicate', (address, entry) => ... )
    ```

  - `replicate.progress` - (address, hash, entry, progress, total)

    Emitted while replicating a database. **address** is a string of the OrbitDB address of the database that emitted the event. **hash** is the multihash of the entry that was just replicated. **entry** is the ipfs-log Entry that was replicated. **progress** is an integer representing the current progress. **total** is an integer representing the remaining operations.

    ```javascript
    db.events.on('replicate.progress', (address, hash, entry, progress, total) => ... )
    ```

  - `replicated` - (address, count)

    Emitted after the database was synced with an update from a peer database. **address** is a string of the OrbitDB address that emitted the event. **count** number of items replicated. **count** is omitted when this event is emitted as a result of `loadFromSnapshot`.

    ```javascript
    db.events.on('replicated', (address, count) => ... )
    ```

  - `write` - (address, entry, heads)

    Emitted after an entry was added locally to the database. **address** is a string of the OrbitDB address that emitted the event. **entry** is the Entry that was added. **heads** is an array of ipfs-log Entries.

    ```javascript
    db.events.on('write', (address, entry, heads) => ... )
    ```

  - `closed` - (address)

    Emitted once the database has finished closing. **address** is a string of the OrbitDB address that emitted the event.

    ```javascript
    db.events.on('closed', (address) => ... )
    db.close()
    ```

### Private methods

#### _addOperation(data)
> Add an entry to the store.

Returns a **Promise** that resolves to the IPFS Multihash of the added entry. Takes `data` as a parameter which can be of any type.

```javascript
this._addOperation({
  op: 'PUT',
  key: 'greeting',
  value: 'hello world!'
});
```

### Creating Custom Data Stores
You can create a custom data stores that stores data in a way you need it to. To do this, you need to import `orbit-db-store` to your custom store and extend your store class from orbit-db-store's `Store`. Below is the `orbit-db-kvstore` which is a custom data store for `orbit-db`.

*TODO: describe indices and how they work*

```javascript
const Store         = require('orbit-db-store');
const KeyValueIndex = require('./KeyValueIndex');

class KeyValueStore extends Store {
  constructor(ipfs, identity, address, options) {
    Object.assign(options || {}, { Index: KeyValueIndex });
    super(ipfs, identity, address, options)
  }

  get(key) {
    return this._index.get(key);
  }

  set(key, data) {
    this.put(key, data);
  }

  put(key, data) {
    return this._addOperation({
      op: 'PUT',
      key: key,
      value: data,
      meta: {
        ts: new Date().getTime()
      }
    });
  }

  del(key) {
    return this._addOperation({
      op: 'DEL',
      key: key,
      value: null,
      meta: {
        ts: new Date().getTime()
      }
    });
  }
}

module.exports = KeyValueStore;
```

## Contributing

See [orbit-db's contributing guideline](https://github.com/orbitdb/orbit-db#contributing).

## License

[MIT](LICENSE) ©️ 2016-2018 Protocol Labs Inc., Haja Networks Oy
