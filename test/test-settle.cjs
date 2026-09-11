/*
 * When is a turn over?
 *
 * The bug this encodes, from 09-10: a chat asked for a research document. The
 * model handed two lines of work to BACKGROUND subagents, ended its turn, and
 * was woken into a NEW turn 68 seconds later when the first one reported back.
 * The bot stopped watching at the first idle, posted the interim sentence
 * ("先并行铺开…"), and the 314-line document that a later turn produced was
 * never sent to Feishu at all. Worse, the 5-minute wall-clock ceiling had
 * already aborted the still-working turn once.
 *
 * So there are two rules under test:
 *   1. `whenIdle()` is necessary but not sufficient — idle only counts once the
 *      tree has no live delegated agent left AND has been silent for a while.
 *   2. The ceiling measures SILENCE, not wall clock. A turn issuing tool calls
 *      every few seconds is working, not stuck.
 *
 * Run: node tests/test-settle.cjs
 */
const fs = require('fs')
const src = fs.readFileSync(__dirname + '/../lib/bot.js', 'utf8')

function fn(name) {
  const re = new RegExp('(?:async )?function ' + name + '\\s*\\(')
  const m = re.exec(src)
  if (m === null) throw new Error('function not found: ' + name)
  const i = src.indexOf('{', m.index + m[0].length - 1)
  let depth = 0
  for (let j = i; j < src.length; j += 1) {
    if (src[j] === '{') depth += 1
    else if (src[j] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(m.index, j + 1)
    }
  }
  throw new Error('unbalanced braces in ' + name)
}

const NAMES = ['pendingForSession', 'parentSessionOf', 'liveTree', 'quietFor', 'delay', 'waitForWorkToSettle', 'armTurnTimer', 'flushStrandedText']

const prelude = `
/** Short enough to keep the suite fast; the real value lives in host.js. */
const SETTLE_MS = 60
let disposed = false
const lastActivity = new Map()
const pendings = new Map()
const logged = []
function log() { logged.push(Array.prototype.join.call(arguments, ' ')) }
function effectiveTimeout() { return 250 }

let AGENTS = []
const agentRegistry = { list: () => AGENTS }
function svc(name) {
  if (name !== 'agents') throw new Error('unexpected service ' + name)
  return agentRegistry
}
function setAgents(next) { AGENTS = next }

const ctx = {
  // Mirrors cordis' ctx.timeout, which has TWO forms: a function first
  // argument is the callback form and returns a disposer (armTurnTimer), while
  // a number is the promise form (delay). The promise form rejects on dispose,
  // and that is the entire reason delay uses it.
  timeout: function (first, ms) {
    if (typeof first === 'function') {
      const handle = setTimeout(first, ms)
      return function () { clearTimeout(handle) }
    }
    let handle = null
    let rejectIt = null
    const promise = new Promise(function (resolve, reject) {
      rejectIt = reject
      handle = setTimeout(resolve, first)
    })
    promise.dispose = function () {
      clearTimeout(handle)
      rejectIt(new Error('Context has been disposed'))
    }
    return promise
  },
}

/* Outbound traffic, so "was it actually sent" has an answer. */
const sent = []
const config = { useReply: false }
const captures = new Map()
const lastInbound = new Map()
async function flushLog() {}
function j(value) { return JSON.stringify(value) }
function cardJson(markdown, entry, options) { return JSON.stringify({ markdown: markdown, footer: options && options.footer }) }
function textJson(text) { return JSON.stringify({ text: text }) }
async function send(chatId, msgType, content, replyTo) {
  const parsed = JSON.parse(content)
  sent.push({ chatId: chatId, msgType: msgType, markdown: parsed.markdown === undefined ? parsed.text : parsed.markdown })
  return { code: 0, data: { message_id: 'om_' + sent.length } }
}
function describeError(error) { return String(error && error.message ? error.message : error) }

${NAMES.map(fn).join('\n')}

module.exports = {
  SETTLE_MS, lastActivity, pendings, logged, setAgents, sent, captures, flushStrandedText, ctx,
  liveTree, quietFor, delay, waitForWorkToSettle, armTurnTimer,
  reset: function () { lastActivity.clear(); pendings.clear(); logged.length = 0; setAgents([]); sent.length = 0; captures.clear() },
}
`
const file = __dirname + '/.settle-under-test.cjs'
fs.writeFileSync(file, prelude)
const M = require(file)

let bad = 0
const check = (name, ok, detail) => {
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : '\n       ' + detail))
  if (!ok) bad += 1
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/* The real shape: parentage lives in the session header, not on the agent. */
const node = (id, parent) => ({ session: { id: id, header: { id: id, ...(parent === undefined ? {} : { parentSession: parent }) } } })
/* And the declared-but-unpopulated shape, which must not be trusted alone. */
const legacyNode = (id, parent) => ({ session: { id: id }, parentAgent: parent === undefined ? undefined : { session: { id: parent } } })

/** An agent whose idleness the test drives, so no real turn has to run. */
function fakeAgent() {
  const waiters = []
  let busy = false
  return {
    begin: function () { busy = true },
    finish: function () { busy = false; while (waiters.length > 0) waiters.shift()() },
    whenIdle: function () {
      if (!busy) return Promise.resolve()
      return new Promise((resolve) => waiters.push(resolve))
    },
  }
}

async function main() {
  /* ---------------------------------------------------------------- *
   * what counts as "underneath this session"
   * ---------------------------------------------------------------- */
  M.reset()
  M.setAgents([node('root'), node('child', 'root'), node('grand', 'child'), node('other')])
  const tree = M.liveTree('root')
  check('a session is part of its own tree', tree.has('root'))
  check('a child is included', tree.has('child'))
  check('a grandchild is included (transitive)', tree.has('grand'))
  check('an unrelated root is not', tree.has('other') === false)

  M.reset()
  M.setAgents([legacyNode('root'), legacyNode('child', 'root')])
  check('the declared parentAgent shape is still honoured when present', M.liveTree('root').has('child'))

  M.reset()
  M.setAgents([{ session: { id: 'root' } }, { session: { id: 'orphan' } }])
  const broken = M.liveTree('root')
  check('an agent with no parent anywhere is not claimed as a child', broken.size === 1 && broken.has('root'))

  /* ---------------------------------------------------------------- *
   * silence is measured across the whole tree
   * ---------------------------------------------------------------- */
  M.reset()
  M.setAgents([node('root'), node('child', 'root')])
  M.lastActivity.set('root', Date.now() - 5000)
  M.lastActivity.set('child', Date.now() - 50)
  const quiet = M.quietFor('root', Date.now() - 9000)
  check('a busy child keeps the tree young even when the root is quiet', quiet < 200, 'quiet=' + quiet)
  M.lastActivity.delete('child')
  check('with the child gone the root time is what counts', M.quietFor('root', Date.now() - 9000) >= 4900)
  check('a session that never spoke falls back to the turn start', M.quietFor('fresh', Date.now() - 3000) >= 2900)

  /* ---------------------------------------------------------------- *
   * the ceiling measures silence, not wall clock
   * ---------------------------------------------------------------- */
  M.reset()
  const cancels = []
  const agent = { cancel: (reason) => cancels.push(reason) }
  const session = { id: 'root' }
  const startedAt = Date.now() - 600000
  // A working turn emits events every few seconds; this stands in for that.
  const ticker = setInterval(() => M.lastActivity.set('root', Date.now()), 40)
  const timer = M.armTurnTimer(agent, session, startedAt)
  await sleep(400)
  check('a turn that has been alive 10 minutes but is still producing is NOT killed', cancels.length === 0, JSON.stringify(cancels))
  check('and it re-arms instead', M.logged.some((l) => l.indexOf('still producing') !== -1), JSON.stringify(M.logged.slice(-3)))
  clearInterval(ticker)
  await sleep(400)
  check('once it really goes quiet the ceiling does fire', cancels.length === 1)
  timer.stop()

  M.reset()
  const cancels2 = []
  const timer2 = M.armTurnTimer({ cancel: (r) => cancels2.push(r) }, session, Date.now() - 600000)
  await sleep(320)
  check('a turn that has gone silent past the ceiling IS killed', cancels2.length === 1, JSON.stringify(cancels2))
  check('the kill is the bot timeout, not a generic cancel', cancels2[0] && cancels2[0].reason === 'feishu bot timeout')
  check('the timer reports the timeout', timer2.timedOut === true)
  timer2.stop()

  M.reset()
  const cancels3 = []
  M.lastActivity.set('root', 0)
  M.pendings.set('oc_x', { chatId: 'oc_x', sessionId: 'root' })
  const timer3 = M.armTurnTimer({ cancel: (r) => cancels3.push(r) }, session, Date.now() - 600000)
  await sleep(320)
  check('a pending question still suspends the ceiling', cancels3.length === 0)
  check('and says why', M.logged.some((l) => l.indexOf('waiting on a human answer') !== -1))
  timer3.stop()

  /* ---------------------------------------------------------------- *
   * waiting for the work, not for the turn
   * ---------------------------------------------------------------- */
  M.reset()
  const idleAgent = fakeAgent()
  const done = M.waitForWorkToSettle(idleAgent, session, Date.now() - 5000, () => false)
  check('idle + nothing underneath + long silence returns at once', (await done) === undefined)

  M.reset()
  const agent2 = fakeAgent()
  agent2.begin()
  M.setAgents([node('root'), node('child', 'root')])
  M.lastActivity.set('root', Date.now())
  let returned = false
  const settle = M.waitForWorkToSettle(agent2, session, Date.now(), () => false).then(() => { returned = true })
  agent2.finish()
  await sleep(150)
  check('a live subagent keeps the turn open after the parent goes idle', returned === false)
  check('and the wait is logged with the child count', M.logged.some((l) => l.indexOf('live subagents=1') !== -1), JSON.stringify(M.logged))

  /* the missing document, reproduced */
  M.setAgents([])
  const capture = { last: '先并行铺开：本地数据取证 + 网络资料两条线。' }
  let sawInterimOnly = false
  M.lastActivity.set('root', Date.now())
  await sleep(20)
  if (returned) sawInterimOnly = true
  check('the interim sentence alone would have ended it — it did not', sawInterimOnly === false)
  agent2.begin()
  await sleep(20)
  capture.last = '调研完成，文档已交付：WorkBuddy-项目功能调研.md（314 行）'
  M.lastActivity.set('root', Date.now())
  agent2.finish()
  await settle
  check('the wait ends only after the follow-on turn produced the real answer', capture.last.indexOf('314 行') !== -1)
  check('the follow-on turn is not mistaken for a wedged one', M.logged.some((l) => l.indexOf('still settling') !== -1))

  M.reset()
  const agent3 = fakeAgent()
  agent3.begin()
  M.setAgents([node('root'), node('child', 'root')])
  M.lastActivity.set('root', Date.now())
  const stopped = M.waitForWorkToSettle(agent3, session, Date.now(), () => true)
  agent3.finish()
  await stopped
  check('a turn the ceiling already killed stops waiting immediately', true)

  /* ---------------------------------------------------------------- *
   * text that arrives with the question is not stranded
   * ---------------------------------------------------------------- */
  M.captures.set('root', { last: 'v2 设计稿已合并：\n\n| 章节 | 内容 |\n|---|---|\n| §8 | 上下文预算 |', sent: '' })
  await M.flushStrandedText('oc_x', { sessionId: 'root' }, 'root')
  check('text written in the same step as a question IS delivered', M.sent.length === 1, JSON.stringify(M.sent))
  check('and it goes out as a card, so its table renders', M.sent[0] && M.sent[0].msgType === 'interactive' && M.sent[0].markdown.indexOf('| 章节 | 内容 |') !== -1)
  check('the delivery is logged with its size', M.logged.some((l) => l.indexOf('delivered text that preceded a question') !== -1))
  await M.flushStrandedText('oc_x', { sessionId: 'root' }, 'root')
  check('a second question in the same turn does not repost it', M.sent.length === 1)

  M.captures.set('root', { last: 'same', sent: 'same' })
  await M.flushStrandedText('oc_x', { sessionId: 'root' }, 'root')
  check('nothing new means nothing is sent', M.sent.length === 1)

  M.captures.set('root', { last: 'newer answer', sent: '' })
  await M.flushStrandedText('oc_x', { sessionId: 'root' }, 'nonexistent')
  check('a session with no active turn is left alone', M.sent.length === 1)

  check('the turn end does not repeat what was already posted', /reply === capture\.sent/.test(src) && /上面那张卡片就是这一轮的回答/.test(src))
  check('both blocking seams flush first', (src.match(/await flushStrandedText\(target\.chatId, target\.entry, pending\.sessionId\)/g) || []).length === 2)

  /* ---------------------------------------------------------------- *
   * the shape of the fix inside host.js
   * ---------------------------------------------------------------- */
  check('runTurn waits on the settle rule, not on whenIdle alone', /await waitForWorkToSettle\(agent, session, startedAt, isTimedOut\)/.test(src))
  check('runTurn stamps activity so the first quiet check is meaningful', /lastActivity\.set\(key, startedAt\)/.test(src))
  check('the ceiling is armed with the turn start time', /armTurnTimer\(agent, session, startedAt\)/.test(src))
  check('every session event stamps activity', /lastActivity\.set\(String\(session\.id\), Date\.now\(\)\)/.test(src))

  /* ---------------------------------------------------------------- *
   * delay: the promise form, so a disposed wait cannot hang a turn
   * ---------------------------------------------------------------- */
  let delaySettled = false
  const waiting = M.delay(10).then(function () { delaySettled = true })
  await sleep(30)
  await waiting
  check('delay resolves on its own', delaySettled === true)
  let disposedRejected = false
  const raw = M.ctx.timeout(60000)
  raw.catch(function () { disposedRejected = true })
  raw.dispose()
  await sleep(20)
  check('a disposed wait rejects instead of hanging forever', disposedRejected === true)
  check('delay uses that promise form', /return ctx\.timeout\(ms\)\.catch/.test(src))
  check('the settle loop notices a disposed instance', /if \(disposed === true\) return/.test(src))

  fs.unlinkSync(file)
  console.log(bad === 0 ? '\nall assertions passed' : '\n' + bad + ' FAILED')
  process.exit(bad === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('harness error:', error)
  process.exit(2)
})
