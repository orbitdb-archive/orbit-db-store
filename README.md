# orbit-db-store

Base class for [orbit-db](https://github.com/haadcode/orbit-db) data stores.

**Work in progress!**

TODO:
- describe indices and how they work
- install instructions, more API usage examples

### Used in
- [orbit-db-kvstore](https://github.com/haadcode/orbit-db-kvstore)
- [orbit-db-eventstore](https://github.com/haadcode/orbit-db-eventstore)
- [orbit-db-feedstore](https://github.com/haadcode/orbit-db-feedstore)
- [orbit-db-counterstore](https://github.com/haadcode/orbit-db-counterstore)

### Events
A store has an event emitter which emits the following events. You can attach to the events at `store.events`. All events contain the name of the emitting store as the first parameter.

- `load` before initializing the store from cache and 
- `ready` after the store has been initialized
- `sync` before merging the store with another store
- `updated` after the store was merged with another store AND new items were added to the store
- `data` after an entry was added locally to the store
- `close` after the store was uninitialized and closed

Example:
```javascript
store.events.on('load', (name) => console.log('Loading', name))
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
