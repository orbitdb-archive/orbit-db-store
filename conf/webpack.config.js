import path from 'path'
import webpack from 'webpack'
import { fileURLToPath } from 'url'

export default (env, argv) => {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)

  return {
    mode: 'production',
    entry: './src/Store.js',
    output: {
      libraryTarget: 'var',
      library: 'Store',
      filename: '../dist/orbit-db-store.min.js'
    },
    target: 'web',
    devtool: 'source-map',
    externals: {
      fs: '{}',
      mkdirp: '{}'
    },
    plugins: [
      new webpack.DefinePlugin({
        'process.env.NODE_ENV': JSON.stringify('production')
      })
    ],
    resolve: {
      modules: [
        'node_modules'
      ],
      fallback: {
        path: require.resolve('path-browserify')
      }
    },
    resolveLoader: {
      modules: [
        'node_modules',
        path.resolve(__dirname, '../node_modules')
      ],
      extensions: ['.js', '.json'],
      mainFields: ['loader', 'main']
    }
  }
}
