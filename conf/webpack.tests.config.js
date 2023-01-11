import glob from 'glob'
import webpack from 'webpack'
import { createRequire } from 'module'

export default (env, argv) => {
  const require = createRequire(import.meta.url)

  return {
    // TODO: put all tests in a .js file that webpack can use as entry point
    entry: glob.sync('./test/*.spec.js'),
    output: {
      filename: '../test/browser/bundle.js'
    },
    target: 'web',
    mode: 'production',
    devtool: 'source-map',
    plugins: [
      new webpack.ProvidePlugin({
        process: 'process/browser.js',
        Buffer: ['buffer', 'Buffer']
      })
    ],
    experiments: {
      topLevelAwait: true
    },
    resolve: {
      modules: [
        'node_modules'
      ],
      fallback: {
        assert: require.resolve('assert/'),
        path: require.resolve('path-browserify'),
        stream: require.resolve('stream-browserify')
      }
    },
    externals: {
      fs: '{ existsSync: () => true }',
      'fs-extra': '{ copy: () => {} }',
    },
    module: {
      rules: [
        {
          test: /\.m?js$/,
          exclude: /node_modules/,
          use: {
            loader: 'babel-loader',
            options: {
              presets: ['@babel/preset-env']
            }
          }
        }
      ]
    }
  }
}
