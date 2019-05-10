'use strict'

const glob = require('glob')
const webpack = require('webpack')
const path = require('path')

module.exports = {
  // TODO: put all tests in a .js file that webpack can use as entry point
  entry: glob.sync('./test/*.spec.js'),
  output: {
    filename: '../test/browser/bundle.js'
  },
  target: 'web',
  mode: 'production',
  devtool: 'source-map',
  node: {
    child_process: 'empty'
  },
  plugins: [
    new webpack.DefinePlugin({
      'process.env': {
        'NODE_ENV': JSON.stringify(process.env.NODE_ENV)
      }
    }),
    new webpack.IgnorePlugin(/mongo|redis/)
  ],
  externals: {
    fs: '{}',
    fatfs: '{}',
    runtimejs: '{}',
    // net: '{}',
    // tls: '{}',
    rimraf: '{ sync: () => {} }',
    'graceful-fs': '{}',
    'fs-extra': '{ copy: () => {} }',
    'fs.realpath': '{}'
    // 'child_process': {},
    // dns: '{}',
    // "node-gyp-build": '{}'
  },
  resolve: {
    modules: [
      'node_modules',
      path.resolve(__dirname, '../node_modules')
    ]
  },
  resolveLoader: {
    modules: [
      'node_modules',
      path.resolve(__dirname, '../node_modules')
    ],
    moduleExtensions: ['-loader']
  },
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            presets: [
              ['@babel/preset-env', { modules: false }]
            ],
            plugins: ['@babel/syntax-object-rest-spread', '@babel/transform-runtime', '@babel/plugin-transform-modules-commonjs']
          }
        }
      },
      {
        test: /signing|getPublic$/,
        loader: 'json-loader'
      }
    ]
  }
}
