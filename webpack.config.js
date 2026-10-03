const path = require('path')
const fs = require('fs')
const webpack = require('webpack')

const {documentPath, RULES_CACHE} = require('./src/rulesSources.mjs')
const rulesSources = require('./assets/rules/sources.json')

const SW_TEMPLATE = path.resolve(__dirname, 'src/service-worker.js')

/**
 * Emits the service worker with this build's precache list baked in. Bundle
 * filenames are content-hashed and chunk ids move between builds, so the list
 * has to be generated rather than maintained by hand.
 *
 * Assets above `shellMaxBytes` are left out: the two map images are ~7MB
 * together and only one edition is ever used in a session, so they are cached
 * on first use instead of downloaded at install time. The limit sits above
 * PDF.js's worker, which the rules viewer cannot work offline without.
 *
 * The rulebooks are listed separately, as `rules`: they are not part of the
 * build (scripts/rules.mjs fetches them into dist/) and are kept in a cache of
 * their own that survives deploys.
 */
class ServiceWorkerPlugin {
  constructor({filename = 'sw.js', shellMaxBytes = 2 * 1024 * 1024, extra = [], rules = [], rulesCache}) {
    this.filename = filename
    this.shellMaxBytes = shellMaxBytes
    this.extra = extra
    this.rules = rules
    this.rulesCache = rulesCache
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
            .replace(/__RULES__/g, JSON.stringify(this.rules, null, 2))
            .replace(/__RULES_CACHE__/g, JSON.stringify(this.rulesCache))
          if (/__(VERSION|SHELL|RULES|RULES_CACHE)__/.test(source)) {
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
    entry: {
      main: './src/index.js',
      rules: './src/rules.js',
    },
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
        {
          // Icons referenced from PDF.js's viewer stylesheet.
          test: /\.(svg|gif)$/,
          type: 'asset/resource',
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
        extra: ['./', './index.html', './rules.html', './manifest.webmanifest', './icon-192.png', './icon-512.png'],
        rules: rulesSources.documents.map((doc) => './' + documentPath(doc)),
        rulesCache: RULES_CACHE,
      }),
    ],
  }
}
