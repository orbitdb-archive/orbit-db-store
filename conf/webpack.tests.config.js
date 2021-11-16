'use strict'

const glob = require('glob')
const webpack = require('webpack')
const path = require('path')
const NodePolyfillPlugin = require('node-polyfill-webpack-plugin')

module.exports = {
  // TODO: put all tests in a .js file that webpack can use as entry point
  entry: glob.sync('./test/*.spec.js'),
  output: {
    filename: '../test/browser/bundle.js'
  },
  target: 'web',
  mode: 'production',
  devtool: 'source-map',
  plugins: [
    new webpack.DefinePlugin({
      'process.env': {
        NODE_ENV: JSON.stringify('development')
      }
    }),
    new webpack.IgnorePlugin({ resourceRegExp: /mongo|redis/}),
    new NodePolyfillPlugin()
  ],
  externals: {
    fs: '{ existsSync: () => true }',
    fatfs: '{}',
    runtimejs: '{}',
    rimraf: '{ sync: () => {} }',
    'graceful-fs': '{}',
    'fs-extra': '{ copy: () => {} }',
    'fs.realpath': '{}'
  },
  resolve: {
    modules: [
      'node_modules',
      path.resolve(__dirname, '../node_modules')
    ],
    fallback: {
      assert: require.resolve('assert/'),
      path: require.resolve('path-browserify'),
      stream: require.resolve('stream-browserify')
    }
  },
  resolveLoader: {
    modules: [
      'node_modules',
      path.resolve(__dirname, '../node_modules')
    ]
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
            plugins: [
              '@babel/syntax-object-rest-spread',
              '@babel/transform-runtime',
              '@babel/plugin-transform-modules-commonjs'
            ]
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
