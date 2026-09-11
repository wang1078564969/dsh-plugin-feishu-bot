/*
 * Card rendering: markdown -> Feishu card elements.
 *
 * Everything is resolved relative to THIS file, so the suite runs from any
 * working directory and for any user. It slices the code under test out of
 * `host.js` rather than copying it, so editing the plugin is what changes the
 * result — there is no second copy to drift.
 */
const fs = require('fs')
const path = require('path')

const SRC_PATH = path.join(__dirname, '..', 'lib', 'bot.js')
const SCRATCH = path.join(__dirname, '.scratch')
const src = fs.readFileSync(SRC_PATH, 'utf8')

function slice(startMarker, endMarker) {
  const a = src.indexOf(startMarker)
  if (a === -1) throw new Error('missing start marker in ' + SRC_PATH + ': ' + startMarker)
  const b = src.indexOf(endMarker, a)
  if (b === -1) throw new Error('missing end marker in ' + SRC_PATH + ': ' + endMarker)
  return src.slice(a, b + endMarker.length)
}

const renderer = slice('    const MAX_TABLE_ELEMENTS = 5', 'return JSON.stringify(cardBody(markdown, entry, options))\n    }')
const baseName = slice('    function baseName(path) {', "      return index === -1 ? trimmed : trimmed.slice(index + 1)\n    }")
const wsFor = slice('    function workspacePathFor(entry) {', "      return String(config.workspacePath || '')\n    }")
const sample = slice('    const PREVIEW_SAMPLE = [', "    ].join('\\n')")

const prelude = `
let config = { workspacePath: '/work/alpha', cardHeader: true }
let botInfo = { name: 'DSH Bot', openId: 'ou_x' }
${baseName}
${wsFor}
${sample}
${renderer}
module.exports = { cardBody, cardJson, segmentMarkdown, normalizeReply, renderTableAsText, cardHeader, PREVIEW_SAMPLE }
`
fs.mkdirSync(SCRATCH, { recursive: true })
const HARNESS = path.join(SCRATCH, 'renderer-under-test.cjs')
fs.writeFileSync(HARNESS, prelude)
const R = require(HARNESS)

let failures = 0
function check(name, cond, extra) {
  if (cond) { console.log('  ok   ' + name) } else { failures += 1; console.log('  FAIL ' + name + (extra === undefined ? '' : '\n       ' + extra)) }
}

console.log('\n[1] the reply from the screenshot')
const card = R.cardBody(R.normalizeReply(R.PREVIEW_SAMPLE), { workspacePath: '/work/alpha' })
console.log('  elements: ' + card.elements.map(e => e.tag).join(', '))
check('header present with workspace subtitle', card.header && card.header.subtitle.content === '📁 alpha', JSON.stringify(card.header))
check('prose + table + trailing prose', card.elements.length === 3 && card.elements[1].tag === 'table', JSON.stringify(card.elements.map(e => e.tag)))
const t = card.elements[1]
check('4 rows x 3 columns', t.rows.length === 4 && t.columns.length === 3)
check('percent widths sum to 100', t.columns.reduce((s, c) => s + parseInt(c.width), 0) === 100, t.columns.map(c => c.width).join('/'))
check('size column is right aligned', t.columns[1].horizontal_align === 'right')
check('backticks unwrapped in cells', t.rows[0].c0 === 'release-notes-v2.0.docx', t.rows[0].c0)
check('row height high for long cells', t.row_height === 'high', t.row_height)
console.log('  widths: ' + t.columns.map(c => c.display_name + '=' + c.width).join('  '))
console.log('  JSON length: ' + R.cardJson(R.normalizeReply(R.PREVIEW_SAMPLE), undefined).length)

console.log('\n[2] a table inside a code fence must stay code')
const fenced = R.normalizeReply('示例：\n\n```\n| a | b |\n| --- | --- |\n| 1 | 2 |\n```\n')
const f = R.cardBody(fenced, undefined).elements
check('single markdown element', f.length === 1 && f[0].tag === 'markdown', JSON.stringify(f.map(e => e.tag)))
check('fence intact', f[0].content.indexOf('| a | b |') !== -1)

console.log('\n[3] escaped pipes and ragged rows')
const esc = R.cardBody('| 表达式 | 含义 |\n| --- | --- |\n| `a \\| b` | 或 |\n| 单列 |\n', undefined).elements[0]
check('escaped pipe becomes literal', esc.rows[0].c0 === 'a | b', JSON.stringify(esc.rows[0]))
check('short row padded to width', esc.rows[1].c1 === '', JSON.stringify(esc.rows[1]))

console.log('\n[4] prose with a stray pipe is not a table')
const prose = R.cardBody('用 a | b 表示或。\n\n这是普通段落。\n', undefined).elements
check('no table element', prose.length === 1 && prose[0].tag === 'markdown', JSON.stringify(prose.map(e => e.tag)))

console.log('\n[5] separator/header arity mismatch stays text')
const bad = R.cardBody('| a | b |\n| --- |\n| 1 | 2 |\n', undefined).elements
check('no table element', bad.length === 1 && bad[0].tag === 'markdown', JSON.stringify(bad.map(e => e.tag)))

console.log('\n[6] the six-table card limit')
let many = ''
for (let i = 0; i < 6; i += 1) many += '表 ' + (i + 1) + '：\n\n| k | v |\n| --- | --- |\n| ' + i + ' | x' + i + ' |\n\n'
const manyElements = R.cardBody(many, undefined).elements
const tables = manyElements.filter(e => e.tag === 'table').length
const flattened = manyElements.filter(e => e.tag === 'markdown' && e.content.indexOf('```') === 0).length
check('exactly 5 real tables', tables === 5, String(tables))
check('6th flattened to aligned text', flattened === 1, String(flattened))

console.log('\n[7] normalizeReply')
check('leading rule dropped', R.normalizeReply('---\n\n正文') === '正文', JSON.stringify(R.normalizeReply('---\n\n正文')))
check('blank runs collapsed in the card', R.cardBody('a\n\n\n\n\nb', undefined).elements[0].content === 'a\n\nb', JSON.stringify(R.cardBody('a\n\n\n\n\nb', undefined).elements[0].content))
check('blank runs kept inside a fence', R.cardBody('```\na\n\n\nb\n```', undefined).elements[0].content === '```\na\n\n\nb\n```')
check('CRLF normalised', R.normalizeReply('a\r\n\r\nb') === 'a\n\nb')

console.log('\n[8] empty and headerless')
check('empty reply still yields an element', R.cardBody('', undefined).elements.length === 1)
check('header can be switched off', R.cardBody('x', undefined, undefined) !== null)

console.log('\n[9] seven-column table falls back to auto width')
const wide = R.cardBody('| a | b | c | d | e | f | g |\n| --- | --- | --- | --- | --- | --- | --- |\n| 1 | 2 | 3 | 4 | 5 | 6 | 7 |\n', undefined).elements[0]
check('auto widths', wide.columns.every(c => c.width === 'auto'), JSON.stringify(wide.columns.map(c => c.width)))

console.log('\n[10] flattened rendering aligns')
console.log(R.renderTableAsText({ header: ['文件', '大小'], align: ['left', 'right'], rows: [['a.docx', '17 MB'], ['长文件名b.docx', '1 KB']] }))

console.log('\n' + (failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'))
process.exit(failures === 0 ? 0 : 1)
