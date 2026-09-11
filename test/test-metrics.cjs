/*
 * The metrics footer: "⏱ elapsed · 📊 context · ⚡ cache hit".
 *
 * `fixtures/sess.jsonl` is a REDUCED session log: the recorded per-turn token
 * usage and context window of a real turn, with every other field dropped. It
 * used to be the transcript itself, which no published package should carry —
 * a transcript holds prompts, reasoning and paths, and the footer reads none of
 * it. The numbers in [1] are still the recorded ones, which is what the
 * assertions pin.
 *
 * Everything is resolved relative to this file, and the code under test is
 * sliced out of `lib/bot.js`.
 */
const fs = require('fs')
const path = require('path')

const SRC_PATH = path.join(__dirname, '..', 'lib', 'bot.js')
const FIXTURE = path.join(__dirname, 'fixtures', 'sess.jsonl')
const SCRATCH = path.join(__dirname, '.scratch')
const src = fs.readFileSync(SRC_PATH, 'utf8')

function slice(a, b) {
  const i = src.indexOf(a); const j = src.indexOf(b, i)
  if (i === -1 || j === -1) throw new Error('marker missing in ' + SRC_PATH + ': ' + (i === -1 ? a : b))
  return src.slice(i, j + b.length)
}

const block = slice('    const sessionUsage = new Map()', "      return parts.join(' · ')\n    }")
const prelude = `
let config = { replyMetrics: true }
const logged = []
function log() { logged.push(Array.prototype.join.call(arguments, ' ')) }
function describeError(e) { return String(e && e.message ? e.message : e) }
${block}
function setConfig(next) { config = next }
module.exports = { recordUsage, metricsLine, seedUsage, formatTokens, formatDuration, sessionUsage, setConfig }
`
fs.mkdirSync(SCRATCH, { recursive: true })
const HARNESS = path.join(SCRATCH, 'metrics-under-test.cjs')
fs.writeFileSync(HARNESS, prelude)
const M = require(HARNESS)

let bad = 0
const check = (n, c, x) => { console.log((c ? '  ok   ' : '  FAIL ') + n + (c || x === undefined ? '' : '\n       ' + x)); if (!c) bad += 1 }

const events = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
for (const e of events) M.recordUsage('s1', e)

console.log('\n[1] line built from the real session log')
const line = M.metricsLine('s1', Date.now() - 42300)
console.log('  ' + line)
check('elapsed', /⏱ 42\.3s/.test(line), line)
check('context 39.2k/1M', line.indexOf('📊 上下文 39.2k/1M') !== -1, line)
check('4% used', line.indexOf('(4%)') !== -1, line)
check('cache 99.2%', line.indexOf('⚡ 缓存命中 99.2%') !== -1, line)

console.log('\n[2] last sample wins (turn 2 step 1 replaces turn 1)')
M.recordUsage('s2', { type: 'assistant/message', data: { turn: 1, usage: { inputTokens: 1000, cacheReadTokens: 1000, outputTokens: 10 } } })
M.recordUsage('s2', { type: 'assistant/message', data: { turn: 2, usage: { inputTokens: 50, cacheReadTokens: 9950, outputTokens: 20 } } })
const l2 = M.metricsLine('s2', Date.now())
console.log('  ' + l2)
check('prompt = 50+9950', l2.indexOf('上下文 10k') !== -1, l2)
check('hit = 99.5%', l2.indexOf('99.5%') !== -1, l2)

console.log('\n[3] provider that reports no cache never claims 0%')
M.recordUsage('s3', { type: 'assistant/message', data: { usage: { inputTokens: 5000, outputTokens: 100 } } })
const l3 = M.metricsLine('s3', Date.now())
console.log('  ' + l3)
check('no cache segment', l3.indexOf('缓存') === -1, l3)
check('context present', l3.indexOf('上下文 5k') !== -1, l3)

console.log('\n[4] unknown session degrades to elapsed only')
const l4 = M.metricsLine('never-seen', Date.now() - 1500)
console.log('  ' + l4)
check('elapsed only', l4 === '⏱ 1.5s', l4)

console.log('\n[5] context window and percentage')
M.recordUsage('s5', { type: 'request/context', data: { contextWindow: 1000000 } })
M.recordUsage('s5', { type: 'assistant/message', data: { usage: { inputTokens: 20000, cacheReadTokens: 180000, outputTokens: 900 } } })
const l5 = M.metricsLine('s5', Date.now())
console.log('  ' + l5)
check('200k/1M = 20%', l5.indexOf('上下文 200k/1M (20%)') !== -1, l5)

console.log('\n[6] formatters')
check('999', M.formatTokens(999) === '999', M.formatTokens(999))
check('1000 -> 1k', M.formatTokens(1000) === '1k', M.formatTokens(1000))
check('39243 -> 39.2k', M.formatTokens(39243) === '39.2k', M.formatTokens(39243))
check('1000000 -> 1M', M.formatTokens(1000000) === '1M', M.formatTokens(1000000))
check('1500000 -> 1.5M', M.formatTokens(1500000) === '1.5M', M.formatTokens(1500000))
check('999ms', M.formatDuration(999) === '999ms', M.formatDuration(999))
check('42.35s', M.formatDuration(42350) === '42.4s', M.formatDuration(42350))
check('1m05s', M.formatDuration(65000) === '1m05s', M.formatDuration(65000))
check('2m30s', M.formatDuration(150000) === '2m30s', M.formatDuration(150000))

console.log('\n[7] switched off')
M.setConfig({ replyMetrics: false })
check('empty line when disabled', M.metricsLine('s1', Date.now()) === '', JSON.stringify(M.metricsLine('s1', Date.now())))

console.log('\n' + (bad === 0 ? 'ALL CHECKS PASSED' : bad + ' FAILED'))
process.exit(bad ? 1 : 0)
