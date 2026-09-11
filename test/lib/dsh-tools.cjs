/*
 * Locate the DSH tool DSL for the measurement scripts.
 *
 * A plugin package declares `@deepseek-ai/dsh-tools` as a peer dependency: the
 * harness provides it, the package does not install it. So a measurement run
 * resolves it the same way the harness would — from wherever DSH lives — and
 * says what to do when it cannot.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

function resolveDshTools() {
  try {
    return require.resolve('@deepseek-ai/dsh-tools')
  } catch (error) { /* not visible from here; try $DSH_HOME next */ }
  const home = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh')
  const candidate = path.join(home, 'profiles', 'node_modules', '@deepseek-ai', 'dsh-tools', 'lib', 'index.js')
  if (fs.existsSync(candidate)) return candidate
  throw new Error('cannot find @deepseek-ai/dsh-tools — run this from a DSH checkout, or set DSH_HOME to the directory holding your profiles/')
}

module.exports = { resolveDshTools: resolveDshTools }
