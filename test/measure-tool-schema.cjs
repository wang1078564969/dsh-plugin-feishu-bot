/*
 * Exact context cost of the `feishu_bot` tool.
 *
 * The provider never sees the DSL in host.js: it sees the JSON Schema that
 * `defineTool` derives from it, re-sent on EVERY model request of EVERY
 * session. So the shipped total is measured the same way the provider gets it,
 * and this script also ranks each parameter by what deleting its description
 * would save — which is how a cut is chosen instead of guessed.
 *
 * Usage:  node tests/measure-tool-schema.cjs [--rank]
 */
const fs = require('fs')
const path = require('path')

const SRC_PATH = path.join(__dirname, '..', 'lib', 'bot.js')
const src = fs.readFileSync(SRC_PATH, 'utf8')

/* --- the tool literal, sliced out of the real source ------------------- */
const nameAt = src.indexOf("name: 'feishu_bot'")
if (nameAt === -1) throw new Error('feishu_bot tool not found in ' + SRC_PATH)

function literalAfter(marker) {
  const at = src.indexOf(marker, nameAt)
  if (at === -1) throw new Error('marker missing in ' + SRC_PATH + ': ' + marker)
  const open = src.indexOf('{', at)
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  throw new Error('unterminated literal after ' + marker)
}

const descriptionAt = src.indexOf('description:', nameAt)
const descriptionEnd = src.indexOf("',", descriptionAt)
const description = src.slice(src.indexOf("'", descriptionAt) + 1, descriptionEnd)
const parameters = eval('(' + literalAfter('parameters: {') + ')')

const { resolveDshTools } = require('./lib/dsh-tools.cjs')
const { defineTool } = require(resolveDshTools())
const render = () => [{ type: 'text', text: 'x' }]

function sizeOf(params, desc) {
  const tool = defineTool({ name: 'feishu_bot', description: desc, parameters: params, output: { schema: { type: 'string' }, render } })
  return JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length
}

const total = sizeOf(parameters, description)
console.log('host.js                                  : ' + SRC_PATH)
console.log('tool.description                         : ' + description.length + ' chars')
console.log('parameters only                          : ' + sizeOf({}, '') + ' chars (empty-bag floor)')
console.log('SHIPPED SCHEMA TOTAL                     : ' + total + ' chars  (~' + Math.round(total / 4) + ' tokens at 4 chars/token)')

const keys = Object.keys(parameters)
let sum = 0
const ranked = []
for (const key of keys) {
  const one = parameters[key]
  const d = typeof one.description === 'string' ? one.description : ''
  sum += d.length
  const without = { ...parameters }
  delete without[key]
  ranked.push({ key, chars: d.length, delta: total - sizeOf(without, description) })
}
console.log('parameters                               : ' + keys.length)
console.log('sum of parameter descriptions            : ' + sum + ' chars')

if (process.argv.indexOf('--rank') !== -1) {
  ranked.sort((a, b) => b.delta - a.delta)
  console.log('\nwhat deleting each key costs (-chars):')
  for (const row of ranked) console.log('  -' + String(row.delta).padStart(4) + '  ' + row.key + (row.chars === 0 ? '' : '   (description ' + row.chars + ')'))
}
