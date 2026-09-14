const path = require('path')
const fs = require('fs')
const webpack = require('webpack')

const SW_TEMPLATE = path.resolve(__dirname, 'src/service-worker.js')

/**
 * Emits the service worker with this build's precache list baked in. Bundle
 * filenames are content-hashed and chunk ids move between builds, so the list
 * has to be generated rather than maintained by hand.
 *
 * Assets above `shellMaxBytes` are left out: the two map images are ~7MB
 * together and only one edition is ever used in a session, so they are cached
 * on first use instead of downloaded at install time.
 */
class ServiceWorkerPlugin {
  constructor({filename = 'sw.js', shellMaxBytes = 1024 * 1024, extra = []} = {}) {
    this.filename = filename
    this.shellMaxBytes = shellMaxBytes
    this.extra = extra
  }

  apply(compiler) {
    const {Compilation, sources} = compiler.webpack
    compiler.hooks.thisCompilation.tap('ServiceWorkerPlugin', (compilation) => {
      compilation.hooks.processAssets.tap(
        {name: 'ServiceWorkerPlugin', stage: Compilation.PROCESS_ASSETS_STAGE_REPORT},
        (assets) => {
          const emitted = Object.keys(assets)
            .filter((name) => name !== this.filename)
            .filter((name) => assets[name].size() <= this.shellMaxBytes)
            .map((name) => './' + name)
          const shell = [...this.extra, ...emitted].sort()
          const template = fs.readFileSync(SW_TEMPLATE, 'utf8')
          // Global: a string pattern would only replace the first occurrence.
          const source = template
            .replace(/__VERSION__/g, compilation.hash)
            .replace(/__SHELL__/g, JSON.stringify(shell, null, 2))
          if (source.includes('__VERSION__') || source.includes('__SHELL__')) {
            compilation.errors.push(new Error('ServiceWorkerPlugin: placeholders left unsubstituted'))
          }
          compilation.emitAsset(this.filename, new sources.RawSource(source))
        }
      )
    })
  }
}

module.exports = (_, argv = {}) => {
  const mode = argv.mode || process.env.NODE_ENV || 'development'
  const isProd = mode === 'production'

  return {
    mode,
    entry: './src/index.js',
    output: {
      filename: '[name].bundle.js',
      chunkFilename: '[name].bundle.js',
      path: path.resolve(__dirname, 'dist'),
    },
    devServer: {
      static: './dist',
      allowedHosts: 'all',
    },
    module: {
      rules: [
        {
          test: /\.css$/,
          use: ['style-loader', 'css-loader'],
        },
        {
          test: /\.(png|jpg)$/,
          use: ['file-loader'],
        },
      ],
    },
    optimization: {
      minimize: isProd,
    },
    plugins: [
      new webpack.DefinePlugin({__PROD__: JSON.stringify(isProd)}),
      // Hand-written files live in dist/ and are tracked, so webpack never sees
      // them; name them explicitly for the precache.
      new ServiceWorkerPlugin({
        extra: ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'],
      }),
    ],
  }
}
