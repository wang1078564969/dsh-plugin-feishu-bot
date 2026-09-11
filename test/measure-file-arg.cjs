/*
 * Exact context cost of the `file` argument.
 *
 * The provider sees the JSON Schema that `defineTool` derives from the unified
 * DSL, not the DSL source, so the two are measured rather than guessed: the
 * same parameters converted with and without that one key.
 */
const fs = require('fs')

const path = require('path')
const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'bot.js'), 'utf8')
const start = src.indexOf('parameters: {', src.indexOf("name: 'feishu_bot'"))
if (start === -1) throw new Error('feishu_bot parameters not found')
let depth = 0
let end = -1
for (let i = src.indexOf('{', start); i < src.length; i += 1) {
  if (src[i] === '{') depth += 1
  else if (src[i] === '}') {
    depth -= 1
    if (depth === 0) { end = i; break }
  }
}
const literal = src.slice(src.indexOf('{', start), end + 1)
const parameters = eval('(' + literal + ')')

const { resolveDshTools } = require('./lib/dsh-tools.cjs')
const { defineTool } = require(resolveDshTools())

const describe = { type: 'string' }
const render = () => [{ type: 'text', text: 'x' }]
function sizeOf(params) {
  const tool = defineTool({ name: 'feishu_bot', description: 'x', parameters: params, output: { schema: describe, render } })
  return JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length
}

const withFile = sizeOf(parameters)
const without = { ...parameters }
delete without.file
const withoutFile = sizeOf(without)

console.log('with the file argument   : ' + withFile + ' chars')
console.log('without it               : ' + withoutFile + ' chars')
console.log('delta                    : +' + (withFile - withoutFile) + ' chars  (~' + Math.round((withFile - withoutFile) / 4) + ' tokens)')
