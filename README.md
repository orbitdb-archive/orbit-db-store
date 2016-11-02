# orbit-db-store

[![npm version](https://badge.fury.io/js/orbit-db-store.svg)](https://badge.fury.io/js/orbit-db-store)

Base class for [orbit-db](https://github.com/haadcode/orbit-db) data stores.

### Used in
- [orbit-db-kvstore](https://github.com/haadcode/orbit-db-kvstore)
- [orbit-db-eventstore](https://github.com/haadcode/orbit-db-eventstore)
- [orbit-db-feedstore](https://github.com/haadcode/orbit-db-feedstore)
- [orbit-db-counterstore](https://github.com/haadcode/orbit-db-counterstore)
- [orbit-db-docstore](https://github.com/shamb0t/orbit-db-docstore)

### Requirements
- Node.js >= 6.0
- npm >= 3.0

### events

  Store has an `events` ([EventEmitter](https://nodejs.org/api/events.html)) object that emits events that describe what's happening in the database.

  - `data` - (dbname, event)
    
    Emitted after an entry was added to the database

    ```javascript
    db.events.on('data', (dbname, event) => ... )
    ```

  - `sync` - (dbname)

    Emitted before starting a database sync with a peer.

    ```javascript
    db.events.on('sync', (dbname) => ... )
    ```

  - `load` - (dbname, hash)

    Emitted before loading the database history. *hash* is the hash from which the history is loaded from.

    ```javascript
    db.events.on('load', (dbname, hash) => ... )
    ```

  - `history` - (dbname, entries)

    Emitted after loading the database history. *entries* is an Array of entries that were loaded.

    ```javascript
    db.events.on('history', (dbname, entries) => ... )
    ```

  - `ready` - (dbname)

    Emitted after fully loading the database history.

    ```javascript
    db.events.on('ready', (dbname) => ... )
    ```

  - `write` - (dbname, hash)

    Emitted after an entry was added locally to the database. *hash* is the IPFS hash of the latest state of the database.

    ```javascript
    db.events.on('write', (dbname, hash) => ... )
    ```

### API
#### Public methods
##### `use()` 
Initialize the store by creating an operations log and loading the latest know local state of the log. Must be called before the store can be used. Emits `load` before init and `ready` after init. Returns a *Promise*.

##### `sync(hash)`
Merge the local store with another store. Takes an IPFS `hash` as an argument from which the other store is loaded from. Emits `sync` before loading the other store and `updated` after the merge **IF** new items were added to the store. Returns a *Promise*.

##### `close()`
Uninitialize the store. Emits `close` after the store has been uninitialized.

##### `delete()`
Remove all items from the local store. This doesn't remove or delete any entries in the distributed operations log.

#### Private methods
##### `_addOperation(data)`
Add an entry to the store. Takes `data` as a parameter which can be of any type.
```javascript
this._addOperation({
  op: 'PUT',
  key: 'greeting',
  value: 'hello world!'
});
```

### Creating Custom Data Stores
You can create a custom data stores that stores data in a way you need it to. To do this, you need to import `orbit-db-store` to your custom store and extend your store ckass from orbit-db-store's `Store`. Below is the `orbit-db-kvstore` which is a custom data store for `orbit-db`.

*TODO: describe indices and how they work*

```javascript
const Store         = require('orbit-db-store');
const KeyValueIndex = require('./KeyValueIndex');

class KeyValueStore extends Store {
  constructor(ipfs, id, dbname, options) {
    Object.assign(options || {}, { Index: KeyValueIndex });
    super(ipfs, id, dbname, options)
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

See [orbit-db's contributing guideline](https://github.com/haadcode/orbit-db#contributing).

## License

[MIT](LICENSE) ©️ 2016 Haadcode
