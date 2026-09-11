/*
 * Run every suite in this directory and report one line each.
 *
 * Each suite slices the code under test out of host.js at run time, so this is
 * the whole regression check for a plugin edit:
 *
 *     node ~/.dsh/.feishu-bot/tests/run-all.cjs
 *
 * Exits non-zero if any suite fails, so it can gate a reload.
 */
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

const HERE = __dirname
const suites = fs.readdirSync(HERE)
  .filter(function (name) { return /^test-.*\.cjs$/.test(name) })
  .sort()

if (suites.length === 0) {
  console.error('no test-*.cjs suites found in ' + HERE)
  process.exit(2)
}

let failed = 0
let assertions = 0
for (const name of suites) {
  const run = spawnSync(process.execPath, [path.join(HERE, name)], { encoding: 'utf8', cwd: HERE })
  const out = (run.stdout || '') + (run.stderr || '')
  const ok = (out.match(/^ {2}ok {3}/gm) || []).length
  const bad = (out.match(/^ {2}FAIL /gm) || []).length
  assertions += ok
  const passed = run.status === 0 && bad === 0
  if (!passed) failed += 1
  console.log((passed ? '  PASS  ' : '  FAIL  ') + name.replace(/^test-|\.cjs$/g, '').padEnd(12) + ok + ' assertions' + (bad === 0 ? '' : ', ' + bad + ' FAILED'))
  if (!passed) console.log(out.split('\n').filter(function (line) { return line.indexOf('FAIL') !== -1 || line.indexOf('error') !== -1 }).slice(0, 12).join('\n'))
}

console.log('\n' + suites.length + ' suites, ' + assertions + ' assertions, ' + (failed === 0 ? 'all green' : failed + ' FAILED'))
process.exit(failed === 0 ? 0 : 1)
