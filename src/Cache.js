'use strict';

const fs   = require('fs');
const path = require('path');

// const defaultFilepath = path.resolve('./orbit-db-cache.json');
// let filePath = defaultFilepath;
let filePath;
let cache = {};

class Cache {
  static set(key, value) {
    return new Promise((resolve, reject) => {
      cache[key] = value;
      if(filePath) {
        fs.writeFile(filePath, JSON.stringify(cache, null, 2) + "\n", resolve);
      } else {
        resolve();
      }
    })
  }

  static get(key) {
    return cache[key];
  }

  static loadCache(cacheFile) {
    cache = {};
    return new Promise((resolve, reject) => {
      if(cacheFile) {
        filePath = cacheFile;
        fs.exists(cacheFile, (res) => {
          if(res) {
            cache = JSON.parse(fs.readFileSync(cacheFile));
            resolve();
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  static reset() {
    cache = {};
  }
}

module.exports = Cache;
