/*
 * The safety properties the rest of the plugin depends on.
 *
 * These were all found by review rather than by a failure, and every one of
 * them is the kind that only shows up under a transient fault — a `cat` that
 * times out, two answers typed quickly, a `/stop` during a long turn. So the
 * faults are injected here on purpose instead of waited for.
 *
 * The code under test is sliced out of host.js; nothing is copied, so editing
 * the plugin is what changes these results.
 */
const fs = require('fs')
const path = require('path')

const SRC_PATH = path.join(__dirname, '..', 'lib', 'bot.js')
const SCRATCH = path.join(__dirname, '.scratch')
const src = fs.readFileSync(SRC_PATH, 'utf8')

function slice(a, b) {
  const i = src.indexOf(a)
  if (i === -1) throw new Error('marker missing in ' + SRC_PATH + ': ' + a)
  const j = src.indexOf(b, i)
  if (j === -1) throw new Error('end marker missing in ' + SRC_PATH + ': ' + b)
  return src.slice(i, j + b.length)
}

/** One whole function, by name — from its `function` line to the closing brace. */
function fn(name) {
  const at = src.search(new RegExp('\\n    (?:async )?function ' + name + '\\('))
  if (at === -1) throw new Error('function not found in ' + SRC_PATH + ': ' + name)
  const end = src.indexOf('\n    }\n', at)
  if (end === -1) throw new Error('function end not found in ' + SRC_PATH + ': ' + name)
  return src.slice(at + 1, end + '\n    }'.length)
}

const prelude = `
const CONFIG_PATH = '/x/config.json'
const STATE_PATH = '/x/state.json'
const LOG_PATH = '/x/plugin.log'
const READ_MAX_BYTES = 4194304
const LOG_ROTATE_BYTES = 1048576
const LOG_KEEP_LINES = 200
const DEFAULTS = { appId: '', appSecret: '', transport: 'ws', workspacePath: '/ws', replyMetrics: true, timeoutMs: 300000 }
let config = Object.assign({}, DEFAULTS)
let configFileKnown = true
let chats = {}
let stateFileKnown = false
let disposed = false
const logLines = []
const pendingLog = []
let logBytes = -1
let flushing = false
const said = []
function log() { said.push(Array.prototype.join.call(arguments, ' ')) }
function describeError(e) { return String(e && e.message ? e.message : e) }
function j(v) { try { return JSON.stringify(v) } catch (e) { return String(v) } }
function randomToken() { return 'token-from-test' }
// Scripted shell: \`shell.fail\` makes every command fail, \`shell.results\` answers by substring.
const shellCalls = []
let shellScript = function (command) { return { code: 0, stdout: '', stderr: '', timedOut: false, truncated: false } }
async function sh(command, stdin, timeoutMs, stdoutMaxBytes) {
  shellCalls.push({ command: command, stdin: stdin === undefined ? null : stdin, stdoutMaxBytes: stdoutMaxBytes === undefined ? null : stdoutMaxBytes })
  return shellScript(command)
}
const written = []
async function writeFileText(path, content) { written.push({ path: path, content: content }) }

${fn('quote')}
${fn('readFileText')}
${fn('sameConfigValue')}
${fn('explicitConfig')}
${fn('saveConfig')}
${fn('loadConfig')}
${fn('loadState')}
${fn('saveState')}
${fn('flushLog')}
${fn('parentSessionOf')}

// stubs for the /stop path
const svcAgents = { get: function () { return undefined } }
function svc(name) { if (name !== 'agents') throw new Error('unexpected service ' + name); return svcAgents }
const replied = []
async function replyRich(chatId, messageId, entry, body, footer) { replied.push({ chatId: chatId, body: body, footer: footer }) }
function metricsLine() { return 'M' }
function stripMentions(text) { return text.replace(/@_user_\\d+/g, '').replace(/\\s+/g, ' ').trim() }
function extractText(message) { return typeof message.content === 'string' ? message.content : '' }
function botWasMentioned() { return true }
${fn('tryStopOutOfBand')}

module.exports = {
  get config() { return config },
  get configFileKnown() { return configFileKnown },
  set configFileKnown(v) { configFileKnown = v },
  get chats() { return chats },
  set chats(v) { chats = v },
  get stateFileKnown() { return stateFileKnown },
  get disposed() { return disposed },
  set disposed(v) { disposed = v },
  get logBytes() { return logBytes },
  set logBytes(v) { logBytes = v },
  get pendingLog() { return pendingLog },
  get logLines() { return logLines },
  logLines: logLines,
  said: said,
  shellCalls: shellCalls,
  written: written,
  replied: replied,
  svcAgents: svcAgents,
  setShell: function (f) { shellScript = f },
  quote: quote,
  readFileText: readFileText,
  saveConfig: saveConfig,
  loadConfig: loadConfig,
  loadState: loadState,
  saveState: saveState,
  flushLog: flushLog,
  parentSessionOf: parentSessionOf,
  tryStopOutOfBand: tryStopOutOfBand,
}
`

fs.mkdirSync(SCRATCH, { recursive: true })
const HARNESS = path.join(SCRATCH, 'hardening-under-test.cjs')
fs.writeFileSync(HARNESS, prelude)
const H = require(HARNESS)

let bad = 0
const check = (n, c, x) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c || x === undefined ? '' : '\n       ' + x)); if (!c) bad += 1 }

async function main() {
  console.log('\n[1] readFileText: absent is not the same answer as unreadable')
  H.setShell(() => ({ code: 3, stdout: '', stderr: '', timedOut: false, truncated: false }))
  check('a missing file returns undefined', (await H.readFileText('/x/nope')) === undefined)
  H.setShell(() => ({ code: 1, stdout: '', stderr: 'Permission denied', timedOut: false, truncated: false }))
  let threw = ''
  try { await H.readFileText('/x/denied') } catch (error) { threw = error.message }
  check('a failed read THROWS instead of looking absent', threw.indexOf('cannot read /x/denied') !== -1, threw)
  H.setShell(() => ({ code: 0, stdout: 'x', stderr: '', timedOut: false, truncated: true }))
  threw = ''
  try { await H.readFileText('/x/big') } catch (error) { threw = error.message }
  check('a truncated read throws too', threw.indexOf('partial read') !== -1, threw)
  H.setShell(() => ({ code: 0, stdout: 'body', stderr: '', timedOut: false, truncated: false }))
  check('a whole read returns the text', (await H.readFileText('/x/fine')) === 'body')

  console.log('\n[2] a config that cannot be read is never written back')
  H.setShell((command) => {
    const target = command.indexOf('config.json') !== -1 ? 'config' : command.indexOf('state.json') !== -1 ? 'state' : 'other'
    if (target !== 'config') return { code: 0, stdout: '', stderr: '', timedOut: false, truncated: false }
    return { code: 1, stdout: '', stderr: 'timed out', timedOut: true, truncated: false }
  })
  H.written.length = 0
  await H.loadConfig()
  check('defaults are used in memory', H.config.appId === '' && H.config.transport === 'ws', JSON.stringify(H.config))
  check('a bridge token still exists in memory', H.config.bridgeToken === 'token-from-test', String(H.config.bridgeToken))
  check('NOTHING was written over config.json', H.written.length === 0, JSON.stringify(H.written))
  check('saveConfig reports the refusal', (await H.saveConfig()) === false)
  check('the refusal is logged', H.said.join('\n').indexOf('config save refused') !== -1, H.said.join('\n'))

  console.log('\n[3] a readable config still round-trips only the operator choices')
  H.setShell((command) => {
    if (command.indexOf('config.json') !== -1) return { code: 0, stdout: '{"appId":"cli_x","appSecret":"s","timeoutMs":300000,"workspacePath":"/real"}', stderr: '', timedOut: false, truncated: false }
    return { code: 0, stdout: '', stderr: '', timedOut: false, truncated: false }
  })
  H.written.length = 0
  await H.loadConfig()
  check('the file is honoured', H.config.appId === 'cli_x' && H.config.workspacePath === '/real', JSON.stringify(H.config))
  check('saveConfig works again', (await H.saveConfig()) === true)
  const saved = JSON.parse(H.written[H.written.length - 1].content)
  check('appId kept', saved.appId === 'cli_x', JSON.stringify(saved))
  check('a value equal to the default is not frozen into the file', saved.timeoutMs === undefined, JSON.stringify(saved))

  console.log('\n[4] a state file that cannot be read is never overwritten')
  H.setShell((command) => {
    if (command.indexOf('state.json') === -1) return { code: 0, stdout: '', stderr: '', timedOut: false, truncated: false }
    return { code: 1, stdout: '', stderr: 'boom', timedOut: false, truncated: false }
  })
  H.chats = { oc_keep: { sessionId: 's1' } }
  H.written.length = 0
  check('loadState reports failure', (await H.loadState()) === false)
  check('the chat map is untouched', H.chats.oc_keep !== undefined, JSON.stringify(H.chats))
  await H.saveState()
  check('saveState wrote NOTHING', H.written.length === 0, JSON.stringify(H.written.map(w => w.path)))
  check('the skip is logged', H.said.join('\n').indexOf('state save skipped') !== -1)

  console.log('\n[5] a state file that becomes readable again is saved')
  H.setShell((command) => {
    if (command.indexOf('state.json') !== -1) return { code: 0, stdout: '{"chats":{"oc_a":{"sessionId":"s9"}}}', stderr: '', timedOut: false, truncated: false }
    return { code: 0, stdout: '', stderr: '', timedOut: false, truncated: false }
  })
  H.written.length = 0
  await H.saveState()
  check('the write happened after the re-read', H.written.length === 1, JSON.stringify(H.written.map(w => w.path)))
  const state = JSON.parse(H.written[0].content)
  check('and it carries the REAL file contents, not the empty map', state.chats.oc_a !== undefined, JSON.stringify(state))

  console.log('\n[5b] a disposed instance stops writing state.json')
  H.disposed = true
  H.written.length = 0
  await H.saveState()
  check('a reloaded (disposed) instance does not overwrite a newer map', H.written.length === 0, JSON.stringify(H.written.map(w => w.path)))
  check('and says why', H.said.join('\n').indexOf('was disposed') !== -1)
  H.disposed = false

  console.log('\n[6] flushLog costs one size probe per process, not one per flush')
  H.setShell((command) => {
    if (command.indexOf('wc -c') !== -1) return { code: 0, stdout: '100\n', stderr: '', timedOut: false, truncated: false }
    return { code: 0, stdout: '', stderr: '', timedOut: false, truncated: false }
  })
  H.logBytes = -1
  H.pendingLog.length = 0
  H.shellCalls.length = 0
  for (let i = 0; i < 20; i += 1) {
    H.pendingLog.push('line ' + i)
    await H.flushLog()
  }
  const probes = H.shellCalls.filter(c => c.command.indexOf('wc -c') !== -1).length
  const appends = H.shellCalls.filter(c => c.command.indexOf('cat >>') !== -1).length
  check('20 flushes, 1 wc', probes === 1, String(probes))
  check('20 appends', appends === 20, String(appends))
  check('the byte counter tracks what was appended', H.logBytes > 100, String(H.logBytes))

  console.log('\n[7] a failed append keeps the lines instead of losing them')
  H.pendingLog.length = 0
  H.pendingLog.push('precious')
  H.setShell((command) => {
    if (command.indexOf('cat >>') !== -1) return { code: 1, stdout: '', stderr: 'disk full', timedOut: false, truncated: false }
    return { code: 0, stdout: '', stderr: '', timedOut: false, truncated: false }
  })
  await H.flushLog()
  check('the batch is still pending', H.pendingLog.indexOf('precious') !== -1, JSON.stringify(H.pendingLog))
  H.setShell(() => ({ code: 0, stdout: '', stderr: '', timedOut: false, truncated: false }))
  await H.flushLog()
  check('and a later flush writes it', H.pendingLog.length === 0, JSON.stringify(H.pendingLog))

  console.log('\n[8] rotation keeps the recent tail instead of emptying the file')
  H.logLines.length = 0
  for (let i = 0; i < 500; i += 1) H.logLines.push('old line ' + i)
  H.pendingLog.length = 0
  H.pendingLog.push('newest line')
  H.logBytes = 1048576
  H.written.length = 0
  H.setShell(() => ({ code: 0, stdout: '', stderr: '', timedOut: false, truncated: false }))
  await H.flushLog()
  check('the file was rewritten once', H.written.length === 1, JSON.stringify(H.written.map(w => w.path)))
  const rotated = H.written[0].content
  check('a rotation marker is at the top', rotated.indexOf('--- rotated at') === 0, rotated.slice(0, 40))
  check('the NEWEST lines survive', rotated.indexOf('old line 499') !== -1)
  check('the bulk is gone', rotated.indexOf('old line 0\n') === -1)
  check('the counter reflects the new file', H.logBytes === rotated.length + 'newest line\n'.length, String(H.logBytes))

  console.log('\n[9] parentSessionOf tolerates a missing agent')
  check('undefined', H.parentSessionOf(undefined) === undefined)
  check('null', H.parentSessionOf(null) === undefined)
  check('an agent with no session', H.parentSessionOf({}) === undefined)
  check('the header relation is read', H.parentSessionOf({ session: { header: { parentSession: 'p1' } } }) === 'p1')

  console.log('\n[10] /stop is answered without waiting for the running turn')
  H.chats = { oc_1: { sessionId: 's-running' } }
  H.replied.length = 0
  const cancelled = []
  H.svcAgents.get = function (id) { return id === 's-running' ? { cancel: function (o) { cancelled.push(o) } } : undefined }
  const handled = await H.tryStopOutOfBand({ chat_id: 'oc_1', chat_type: 'p2p', message_id: 'm1', content: '/stop' }, {})
  check('it is handled out of band', handled === true)
  check('the agent was cancelled', cancelled.length === 1 && cancelled[0].kind === 'user', JSON.stringify(cancelled))
  check('the chat got a reply', H.replied.length === 1 && H.replied[0].body === '已请求中断。', JSON.stringify(H.replied))
  check('an ordinary message is NOT intercepted', (await H.tryStopOutOfBand({ chat_id: 'oc_1', chat_type: 'p2p', message_id: 'm2', content: '你好' }, {})) === false)
  check('a chat that never spoke is NOT intercepted', (await H.tryStopOutOfBand({ chat_id: 'oc_new', chat_type: 'p2p', message_id: 'm3', content: '/stop' }, {})) === false)
  H.svcAgents.get = function () { return undefined }
  await H.tryStopOutOfBand({ chat_id: 'oc_1', chat_type: 'p2p', message_id: 'm4', content: '/stop' }, {})
  check('an idle chat says so', H.replied[H.replied.length - 1].body === '当前没有正在运行的任务。', JSON.stringify(H.replied[H.replied.length - 1]))

  console.log('\n' + (bad === 0 ? 'all assertions passed' : bad + ' FAILED'))
  process.exit(bad === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('HARNESS ERROR: ' + (error && error.stack ? error.stack : error))
  process.exit(2)
})
