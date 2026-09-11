/*
 * The row's entry point — deliberately tiny.
 *
 * TWO PROBLEMS, ONE FILE.
 *
 * 1. LIVE EDITS. Cordis imports a module ONCE and Node caches it, so a plugin
 *    whose implementation is imported at module scope freezes at the version
 *    that was on disk when the process started: editing it would change nothing
 *    until a full restart. So the implementation is imported HERE, inside
 *    apply(), with the file's modification time as a query string. Saving an
 *    edit and re-activating the row then picks the edit up — and `lib/bot.js`
 *    stays an ordinary ES module that anyone can read, import and test.
 *
 * 2. BOOT SAFETY. A failed row is not a private matter: the harness's final
 *    boot audit rethrows a failed plugin's error, so a row that throws while
 *    loading takes the WHOLE harness down. A chat bridge must never be able to
 *    do that, so a load failure is reported and swallowed here instead of
 *    propagated: the entry activates, contributes nothing, and says why in its
 *    own log. `test/run-all.cjs` is what catches a broken edit before it ships.
 *
 * `inject` must be declared HERE, on the module Cordis imports: the metadata of
 * a dynamically imported implementation is not read.
 */
import { appendFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const IMPLEMENTATION = join(HERE, 'bot.js')

/** Where the data lives, resolved the same way lib/bot.js resolves it. */
function dataDir() {
  if (process.env.DSH_FEISHU_DATA !== undefined && process.env.DSH_FEISHU_DATA !== '') return process.env.DSH_FEISHU_DATA
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, 'feishu-bot')
}

export const name = 'feishu-bot'
/*
 * `tools` is not optional decoration: `registerTool` reaches `ctx.tools` as a
 * PROPERTY, and Cordis' traceable service proxy refuses that unless the service
 * is declared here — `ctx.get('shell')` is the optional-read form and needs no
 * declaration, which is why only these two are listed. Omitting `tools` fails
 * the boot audit and takes the whole harness down with it.
 *
 * `connection` is deliberately NOT listed, and that is a load-bearing decision.
 * Cordis parks a fiber whose declared inject is unavailable:
 *
 *     _refresh() { for (const name of Object.keys(this.inject)) {
 *       if (!this._store[name]) { epoch = INACTIVE; break } } }
 *
 * `connection` ships with the WEB bundle, so declaring it would leave this
 * plugin permanently inactive in a headless profile — no bridge, no tool, and
 * no error either. The settings route below reads it with `ctx.get()`, which
 * Cordis documents as "read a service from the store without the inject
 * requirement", and simply does not mount when it is absent.
 */
export const inject = ['timer', 'tools']

/**
 * Mount the shipped settings page's API, if this deployment can carry it.
 *
 * The page itself is `lib/client.js`, declared by `dsh.client` in package.json
 * and served by the client module system — it needs no wiring here. What it
 * needs is a way home: a SHIPPED browser half has no `host.call`, so it talks to
 * this route instead, which the connection service wraps in the same
 * browser-cookie authentication the rest of the GUI uses.
 *
 * A raw `webServer` route would have been simpler and wrong: it applies no
 * authentication, and this endpoint reports whether the app secret is set.
 *
 * Failure to mount is reported, never thrown. A missing GUI route costs the
 * settings page; a thrown error here costs the whole harness, because the boot
 * audit rethrows a failed row.
 */
function mountSettingsApi(ctx, implementation) {
  const api = implementation.settingsApi
  if (api === null || api === undefined || typeof api.handler !== 'function') return
  let connection = null
  try {
    connection = ctx.get('connection')
  } catch (error) {
    connection = null
  }
  if (connection === null || connection === undefined || connection.fetch === undefined || typeof connection.fetch.register !== 'function') {
    console.error('[feishu-bot] the connection service is unavailable — the settings page will not load its configuration (the bot itself is unaffected)')
    return
  }
  try {
    ctx.effect(function () {
      return connection.fetch.register({
        path: api.path,
        methods: ['GET', 'POST'],
        requestBody: 'buffered',
        fetch: api.handler,
      })
    })
    api.mounted = true
  } catch (error) {
    console.error('[feishu-bot] could not mount the settings route at ' + String(api.path) + ': ' + String(error && error.message ? error.message : error))
  }
}

export async function apply(ctx) {
  let implementation = null
  try {
    const url = pathToFileURL(IMPLEMENTATION)
    try {
      url.searchParams.set('v', String((await stat(IMPLEMENTATION)).mtimeMs))
    } catch (error) {
      // No mtime means the file itself is gone; import the bare path so the
      // error below names the real problem instead of this one.
    }
    implementation = await import(url.href)
  } catch (error) {
    const detail = String(error && error.stack ? error.stack : error)
    console.error('[feishu-bot] cannot load ' + IMPLEMENTATION + ': ' + detail)
    try {
      appendFileSync(join(dataDir(), 'load-report.txt'), new Date().toISOString() + ' LOAD FAILED: ' + detail.split('\n').slice(0, 6).join(' | ') + '\n')
    } catch (nested) {
      // The data directory may not exist yet; the console line above is enough.
    }
    return
  }
  await implementation.apply(ctx)

  /*
   * Mount the settings route.
   *
   * `settingsApi.handler` was published by apply() just above, so reaching here
   * means the plugin really activated. The handler already speaks the connection
   * service's Fetch shape, so there is nothing to adapt — one less layer between
   * a request and the code that owns the config.
   */
  try {
    mountSettingsApi(ctx, implementation)
  } catch (error) {
    console.error('[feishu-bot] settings route wiring failed: ' + String(error && error.message ? error.message : error))
  }
}
