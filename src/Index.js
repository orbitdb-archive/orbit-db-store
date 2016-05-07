'use strict';

class Index {
  constructor(id) {
    this.id = id;
    this._index = [];
  }

  get() {
    return this._index;
  }

  updateIndex(oplog, entries) {
    this._index = oplog.ops;
  }
}

module.exports = Index;
