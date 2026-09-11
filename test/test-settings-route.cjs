/*
 * The settings route: the one place the shipped GUI page can read and write
 * config.json.
 *
 * A SHIPPED browser half has no `host.call` — that builtin belongs to the
 * dynamic Cordis runner — so `lib/client.js` talks to this route instead, and
 * the route is therefore a SECURITY BOUNDARY, not just plumbing. The connection
 * service supplies the browser-cookie authentication and the Host fence; what
 * this suite pins down is everything the handler itself must get right:
 *
 *  - the app secret is never sent, in any field, under any request;
 *  - `bridgeToken` can be neither read nor written through it;
 *  - an empty secret means "leave it alone", so a form that never received the
 *    secret cannot erase it;
 *  - a write reports the configuration AS PERSISTED, and never claims a change
 *    the file did not take;
 *  - every reply is lossless JSON, because the client guard rejects
 *    `undefined` outright (JSON.stringify would have dropped it silently).
 *
 * The handler, its validator and its view builder are sliced out of lib/bot.js
 * at run time against a throwaway config file, so editing the plugin is what
 * changes these results. Nothing here is a copy of the plugin.
 *
 * Run from anywhere: node test/test-settings-route.cjs
 */
const fs = require('fs'), path = require('path'), os = require('os')

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'feicfg-route-'))
const CONFIG = path.join(DATA, 'config.json')
fs.writeFileSync(CONFIG, JSON.stringify({ appId: 'cli_real', appSecret: 'super-secret-value', workspacePath: '/Users/x/work', permissionPreset: 'danger-full-access', bridgeToken: 'tok-123' }, null, 2) + '\n')

const SRC_PATH = path.join(__dirname, '..', 'lib', 'bot.js')
const src = fs.readFileSync(SRC_PATH, 'utf8')

// Pull the pieces the route needs, by span, so the test tracks the real file.
function span(from, to) {
  const a = src.indexOf(from); const b = src.indexOf(to, a)
  if (a === -1 || b === -1) throw new Error('missing span ' + from + ' .. ' + to)
  return src.slice(a, b)
}
const code = [
  span('    const SETTINGS_MAX_BODY', '    /* ------------------------------------------------------------------ *\n     * runtime wiring'),
  'module.exports = { settingsRequest: settingsRequest, settingsView: settingsView, validateSettingsPatch: validateSettingsPatch }',
].join('\n')

const harness = path.join(DATA, 'route-under-test.cjs')
fs.writeFileSync(harness, `
const CONFIG_PATH = ${JSON.stringify(CONFIG)}
const DEFAULTS = { appId: '', appSecret: '', transport: 'ws', workspacePath: '', agentPreset: 'standard', permissionPreset: '', groupRequireMention: true, replyStyle: 'card', acknowledge: true, cardHeader: true, replyMetrics: true }
let config = Object.assign({}, DEFAULTS, JSON.parse(require('fs').readFileSync(CONFIG_PATH, 'utf8')))
let configRevisionValue = 0
function configRevision() { return configRevisionValue }
function bumpConfigRevision() { configRevisionValue += 1 }
const logs = []
function log(line) { logs.push(line) }
function describeError(e) { return String(e && e.message ? e.message : e) }
async function saveConfig() {
  const explicit = {}
  for (const k of Object.keys(config)) if (JSON.stringify(config[k]) !== JSON.stringify(DEFAULTS[k])) explicit[k] = config[k]
  require('fs').writeFileSync(CONFIG_PATH, JSON.stringify(explicit, null, 2) + '\\n')
  return true
}
${code}
`)
const M = require(harness)

// cloneJson-equivalent strictness from dsh-cordis-host-runner.
function assertLossless(value, at, seen) {
  const s = seen || new Set()
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') { if (!Number.isFinite(value) || Object.is(value, -0)) throw new Error(at + ' bad number'); return }
  if (typeof value !== 'object' || s.has(value)) throw new Error(at + ' is not lossless JSON (' + (value === undefined ? 'undefined' : typeof value) + ')')
  if (Array.isArray(value)) { value.forEach((v, i) => assertLossless(v, at + '[' + i + ']', s)); return }
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) throw new Error(at + ' is a class instance')
  s.add(value)
  for (const e of Object.entries(value)) assertLossless(e[1], at + '.' + e[0], s)
  s.delete(value)
}

const req = (method, body) => ({ method, text: async () => (body === undefined ? '' : JSON.stringify(body)) })

;(async () => {
  let bad = 0
  const check = (name, ok, extra) => { console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || extra === undefined ? '' : '\n       ' + extra)); if (!ok) bad += 1 }

  console.log('[1] GET')
  let res = await M.settingsRequest(req('GET'))
  let body = await res.json()
  check('status 200', res.status === 200, String(res.status))
  try { assertLossless(body, 'GET body'); check('payload is lossless JSON', true) } catch (e) { check('payload is lossless JSON', false, e.message) }
  check('appSecret never sent', body.fields.appSecret === null && JSON.stringify(body).indexOf('super-secret-value') === -1)
  check('reports the secret as set', Array.isArray(body.secretsSet) && body.secretsSet.indexOf('appSecret') >= 0)
  check('the real value came through', body.fields.appId === 'cli_real', JSON.stringify(body.fields.appId))
  check('every editable key present', ['appId','appSecret','transport','workspacePath','agentPreset','permissionPreset','groupRequireMention','replyStyle','acknowledge','cardHeader','replyMetrics'].every((k) => k in body.fields))
  check('bridgeToken NOT exposed as a field', !('bridgeToken' in body.fields))

  console.log('\n[2] POST a valid change')
  res = await M.settingsRequest(req('POST', { updates: { cardHeader: false, replyStyle: 'text' } }))
  body = await res.json()
  check('status 200', res.status === 200, String(res.status))
  check('ok', body.ok === true)
  check('saved', body.saved === true)
  check('not bridge-affecting', body.bridgeAffected === false)
  const onDisk = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
  check('cardHeader persisted', onDisk.cardHeader === false, JSON.stringify(onDisk))
  check('replyStyle persisted', onDisk.replyStyle === 'text')
  check('bridgeToken survived the write', onDisk.bridgeToken === 'tok-123')
  check('appSecret survived the write', onDisk.appSecret === 'super-secret-value')
  check('revision advanced', body.revision > 0, String(body.revision))

  console.log('\n[3] POST bridge-affecting')
  res = await M.settingsRequest(req('POST', { updates: { transport: 'both' } }))
  body = await res.json()
  check('flagged as bridge-affecting', body.bridgeAffected === true)
  check('transport persisted', JSON.parse(fs.readFileSync(CONFIG, 'utf8')).transport === 'both')

  console.log('\n[4] refusals')
  res = await M.settingsRequest(req('POST', { updates: { transport: 'nonsense' } }))
  check('a bad transport is refused', res.status === 400, String(res.status))
  res = await M.settingsRequest(req('POST', { updates: { appSecret: '' } }))
  check('an empty secret is refused, not applied', res.status === 400, String(res.status))
  res = await M.settingsRequest(req('POST', { updates: { workspacePath: 'relative/path' } }))
  check('a relative workspace is refused', res.status === 400, String(res.status))
  res = await M.settingsRequest(req('POST', { updates: { bridgeToken: 'hijack' } }))
  check('bridgeToken cannot be written', res.status === 400 && JSON.parse(fs.readFileSync(CONFIG, 'utf8')).bridgeToken === 'tok-123')
  res = await M.settingsRequest(req('PUT'))
  check('PUT is 405', res.status === 405, String(res.status))
  res = await M.settingsRequest({ method: 'POST', text: async () => 'not json' })
  check('malformed JSON is 400', res.status === 400, String(res.status))

  console.log('\n[5] the secret is still intact after every attempt')
  check('appSecret untouched on disk', JSON.parse(fs.readFileSync(CONFIG, 'utf8')).appSecret === 'super-secret-value')

  fs.rmSync(DATA, { recursive: true, force: true })
  console.log(bad === 0 ? '\nsettings route: all green' : '\nsettings route: ' + bad + ' FAILED')
  process.exit(bad === 0 ? 0 : 1)
})().catch((e) => { console.log('THREW: ' + (e.stack || e)); process.exit(1) })
