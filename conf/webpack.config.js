'use strict'

const path = require('path')

module.exports = {
  entry: './src/Store.js',
  output: {
    libraryTarget: 'var',
    library: 'Store',
    filename: 'orbit-db-store.min.js'
  },
  target: 'web',
  mode: 'production',
  devtool: 'source-map',
  plugins: [
  ],
  resolve: {
    modules: [
      'node_modules',
      path.resolve(__dirname, '../node_modules')
    ],
    fallback: {
      path: require.resolve('path-browserify')
    }
  },
  resolveLoader: {
    modules: [
      'node_modules',
      path.resolve(__dirname, '../node_modules')
    ]
  }
}
