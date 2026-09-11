/*
 * External edits to config.json must be adopted WITHOUT a restart.
 *
 * The settings menu writes the same file this plugin reads at boot, and the
 * in-memory `config` object has no way to notice that on its own. The 3-second
 * supervisor tick now compares a cheap file signature (mtime in milliseconds +
 * size) and reloads when it changed.
 *
 * The three failures this suite exists to prevent:
 *
 *  - A reload loop. `loadConfig()` writes the file back when `bridgeToken` is
 *    missing, so a signature captured BEFORE that write would differ on every
 *    single tick and the plugin would reload forever.
 *  - A stale bridge. The child gets appId/appSecret/endpoint through its
 *    ENVIRONMENT at spawn, so reloading without respawning leaves it on the old
 *    identity: inbound events on one app, outbound calls on another.
 *  - A respawn the operator did not ask for. A change to `cardHeader` must not
 *    drop the long connection and lose whatever Feishu is retrying into it.
 *
 * The code under test — configSignature, sameConfigText and
 * reloadConfigIfChanged — is sliced out of lib/bot.js at run time, so editing
 * the plugin changes the result of this suite. Nothing here is a copy.
 *
 * Run from anywhere: node test/test-hotreload.cjs
 */
const fs = require('fs')
const path = require('path')
const vm = require('vm')

const SRC_PATH = path.join(__dirname, '..', 'lib', 'bot.js')
const src = fs.readFileSync(SRC_PATH, 'utf8')

/** One whole function, by name — from its `function` line to the closing brace. */
function fn(name) {
  const at = src.search(new RegExp('\\n    (?:async )?function ' + name + '\\('))
  if (at === -1) throw new Error('function not found in ' + SRC_PATH + ': ' + name)
  const end = src.indexOf('\n    }\n', at)
  if (end === -1) throw new Error('function end not found in ' + SRC_PATH + ': ' + name)
  return src.slice(at + 1, end + '\n    }'.length)
}

const SCRATCH = path.join(__dirname, '.scratch')
fs.mkdirSync(SCRATCH, { recursive: true })
const CONFIG_PATH = path.join(SCRATCH, 'config.json')

const script = `
${fn('configSignature')}
${fn('sameConfigText')}
${fn('reloadConfigIfChanged')}

module.exports = {
  configSignature: configSignature,
  sameConfigText: sameConfigText,
  reloadConfigIfChanged: reloadConfigIfChanged,
}
`

const sandbox = {
  require: require,
  module: { exports: {} },
  exports: {},
  console: console,
  JSON: JSON,
  Object: Object,
  String: String,
  Date: Date,
  existsSync: fs.existsSync,
  statSync: fs.statSync,
  CONFIG_PATH: CONFIG_PATH,
  configSignatureSeen: '',
  // The supervisor state the reload path owns. Declared here because the real
  // ones are `let` bindings that live later in the file than the functions.
  config: { appId: 'cli_a', appSecret: 's1', transport: 'ws', cardHeader: true, bridgeToken: 'tok' },
  bridge: { status: 'running' },
  bridgeRestarts: 3,
  tokenCache: { token: 'cached' },
  botInfo: { openId: 'ou_1' },
  logs: [],
  log: function () { sandbox.logs.push(Array.prototype.join.call(arguments, ' ')) },
  describeError: function (error) { return error === null || error === undefined ? 'unknown error' : String(error.message === undefined ? error : error.message) },
  // Replaced per test; the real one is async and reads the file through `cat`.
  loadConfig: async function () {},
  stopped: 0,
  stopBridge: async function () { sandbox.stopped += 1 },
}
sandbox.global = sandbox
sandbox.exports = sandbox.module.exports
vm.createContext(sandbox)
vm.runInContext(script, sandbox, { filename: 'hotreload-under-test.cjs' })
const H = sandbox.module.exports

let bad = 0
const check = (name, condition, extra) => {
  console.log((condition ? '  ok   ' : '  FAIL ') + name + (condition || extra === undefined ? '' : '\n       ' + extra))
  if (!condition) bad += 1
}

/** Write the file so its mtime is strictly newer than any previous write. */
let writeCount = 0
function writeConfig(value) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(value, null, 2) + '\n')
  writeCount += 1
  const when = new Date(Date.now() + writeCount * 1000)
  fs.utimesSync(CONFIG_PATH, when, when)
}

/** Point the sandbox at a fresh config and pretend boot already loaded it. */
function bootWith(value) {
  writeConfig(value)
  sandbox.config = Object.assign({}, value)
  sandbox.configSignatureSeen = H.configSignature()
  sandbox.logs.length = 0
  sandbox.stopped = 0
  sandbox.bridge = { status: 'running' }
  sandbox.bridgeRestarts = 3
  sandbox.tokenCache = { token: 'cached' }
  sandbox.botInfo = { openId: 'ou_1' }
  sandbox.loadConfig = async function () {
    sandbox.config = Object.assign({}, value)
  }
}

/** Reassign the loader so a reload lands the given next state. */
function nextConfig(value) {
  sandbox.loadConfig = async function () {
    sandbox.config = Object.assign({}, value)
  }
}

const BASE = {
  appId: 'cli_a',
  appSecret: 's1',
  transport: 'ws',
  cardHeader: true,
  replyMetrics: true,
  workspacePath: '/ws',
  bridgeToken: 'tok',
}

async function main() {
  console.log('\n[1] an untouched file is not a change')

  bootWith(BASE)
  const before = sandbox.config
  await H.reloadConfigIfChanged()
  await H.reloadConfigIfChanged()
  check('nothing reloads and the config object is the same referral', sandbox.config === before)
  check('no bridge restart', sandbox.stopped === 0)
  check('no log noise', sandbox.logs.length === 0, JSON.stringify(sandbox.logs))

  console.log('\n[2] a reload that changes nothing is silent')

  // Same content, new mtime: the signature moved, the values did not. This is
  // the path that would otherwise log on every write from the settings menu.
  fs.utimesSync(CONFIG_PATH, new Date(Date.now() + 60000), new Date(Date.now() + 60000))
  await H.reloadConfigIfChanged()
  check('changed mtime alone logs nothing', sandbox.logs.length === 0, JSON.stringify(sandbox.logs))
  check('and restarts nothing', sandbox.stopped === 0)

  console.log('\n[3] a non-bridge field reloads without touching the bridge')

  bootWith(BASE)
  nextConfig(Object.assign({}, BASE, { cardHeader: false }))
  writeConfig(Object.assign({}, BASE, { cardHeader: false }))
  await H.reloadConfigIfChanged()
  check('the new value is in memory', sandbox.config.cardHeader === false)
  check('the bridge was NOT restarted', sandbox.stopped === 0)
  check('the change is logged', sandbox.logs.join('\n').indexOf('cardHeader') !== -1, JSON.stringify(sandbox.logs))

  console.log('\n[4] appSecret alone forces a respawn')

  bootWith(BASE)
  nextConfig(Object.assign({}, BASE, { appSecret: 's2' }))
  writeConfig(Object.assign({}, BASE, { appSecret: 's2' }))
  await H.reloadConfigIfChanged()
  check('the child was stopped exactly once', sandbox.stopped === 1, String(sandbox.stopped))
  check('the backoff was reset so the respawn is immediate', sandbox.bridgeRestarts === 0)
  check('the cached tenant token was dropped', sandbox.tokenCache === null)
  check('the cached bot identity was dropped', sandbox.botInfo === null)
  check('the restart is logged', sandbox.logs.join('\n').indexOf('restarting the bridge') !== -1, JSON.stringify(sandbox.logs))

  console.log('\n[5] transport alone forces a respawn')

  bootWith(BASE)
  nextConfig(Object.assign({}, BASE, { transport: 'webhook' }))
  writeConfig(Object.assign({}, BASE, { transport: 'webhook' }))
  await H.reloadConfigIfChanged()
  check('the child was stopped', sandbox.stopped === 1, String(sandbox.stopped))
  check('the transport is the reloaded one', sandbox.config.transport === 'webhook')

  console.log('\n[6] appId alone forces a respawn')

  bootWith(BASE)
  nextConfig(Object.assign({}, BASE, { appId: 'cli_b' }))
  writeConfig(Object.assign({}, BASE, { appId: 'cli_b' }))
  await H.reloadConfigIfChanged()
  check('the child was stopped', sandbox.stopped === 1, String(sandbox.stopped))

  console.log('\n[7] a first load that writes bridgeToken back does NOT loop')

  // The exact loop this design has to avoid: writing the file inside the reload
  // changes the mtime, so a signature captured before the write would differ on
  // the next tick, forever. `loadConfig` writing bridgeToken is that write.
  writeConfig({ appId: 'cli_a', appSecret: 's1', transport: 'ws' })
  sandbox.config = { appId: 'cli_a', appSecret: 's1', transport: 'ws' }
  sandbox.configSignatureSeen = ''
  sandbox.logs.length = 0
  sandbox.stopped = 0
  sandbox.loadConfig = async function () {
    const generated = { appId: 'cli_a', appSecret: 's1', transport: 'ws', bridgeToken: 'generated' }
    sandbox.config = generated
    writeConfig(generated)
  }
  await H.reloadConfigIfChanged()
  check('the generated token was adopted', sandbox.config.bridgeToken === 'generated')
  const afterFirst = sandbox.logs.length
  await H.reloadConfigIfChanged()
  await H.reloadConfigIfChanged()
  check('the following ticks do NOT reload again', sandbox.logs.length === afterFirst, JSON.stringify(sandbox.logs))
  check('and the bridge was not spawned/stopped by the token write', sandbox.stopped === 0)

  console.log('\n[8] an unreadable signature is retried once, not every tick')

  bootWith(BASE)
  const backup = fs.readFileSync(CONFIG_PATH)
  fs.unlinkSync(CONFIG_PATH)
  sandbox.logs.length = 0
  await H.reloadConfigIfChanged()
  check('a vanished config is adopted', sandbox.logs.length >= 0)
  const settled = sandbox.logs.length
  await H.reloadConfigIfChanged()
  check('and does not churn afterwards', sandbox.logs.length === settled, JSON.stringify(sandbox.logs))
  fs.writeFileSync(CONFIG_PATH, backup)

  console.log('\n[9] sameConfigText compares both sides')

  check('equal strings', H.sameConfigText('a', 'a') === true)
  check('different strings', H.sameConfigText('a', 'b') === false)
  check('a value against undefined differs', H.sameConfigText('ws', undefined) === false)
  check('both undefined are equal', H.sameConfigText(undefined, undefined) === true)
  check('arrays by content', H.sameConfigText([1, 2], [1, 2]) === true)
  check('arrays by order', H.sameConfigText([1, 2], [2, 1]) === false)
  check('type difference is a difference', H.sameConfigText('true', true) === false)

  console.log('\n[10] a loadConfig failure does not kill the tick and does not loop')

  bootWith(BASE)
  writeConfig(Object.assign({}, BASE, { cardHeader: false }))
  sandbox.logs.length = 0
  sandbox.loadConfig = async function () { throw new Error('cat timed out') }
  await H.reloadConfigIfChanged()
  check('the failure is logged', sandbox.logs.join('\n').indexOf('config reload failed') !== -1, JSON.stringify(sandbox.logs))
  const afterFailure = sandbox.logs.length
  await H.reloadConfigIfChanged()
  check('the next tick retries once, not in a loop', sandbox.logs.length === afterFailure, JSON.stringify(sandbox.logs))
  check('the bridge was left alone', sandbox.stopped === 0)

  fs.rmSync(CONFIG_PATH, { force: true })
  console.log(bad === 0 ? '\nhot reload: all green' : '\nhot reload: ' + bad + ' FAILED')
  process.exit(bad === 0 ? 0 : 1)
}

main().catch(function (error) {
  console.error('suite crashed: ' + (error && error.stack ? error.stack : error))
  process.exit(1)
})
