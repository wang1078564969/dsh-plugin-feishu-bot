#!/usr/bin/env node
/*
 * test-workspace.cjs — regression suite for the `/ws` workspace-switching code
 * in ../host.js. It replaces a lost suite that lived in an unwritable scratch
 * directory; that suite's recorded run output is the spec: the same 58
 * assertions, in the same order.
 *
 * host.js is the body of `new AsyncFunction('ctx','harness','console','btoa',
 * 'atob', src)`, so it cannot be required and it has no imports. This suite
 * therefore:
 *
 *   1. reads ../host.js,
 *   2. slices the functions under test out of it BETWEEN STRING MARKERS
 *      (a missing marker throws, naming the marker),
 *   3. writes them, together with stubs for the deployment boundaries (ctx
 *      services, the shell, config.json / state.json, the logger), into
 *      ./.scratch/workspace-under-test.cjs,
 *   4. requires that generated harness and asserts on real behaviour.
 *
 * The harness is regenerated on every run, so editing host.js changes what this
 * suite tests. No implementation is copied into this file: the stubs stand for
 * things host.js reaches OUT to (a service registry, a shell, a config file),
 * never for the logic under test.
 *
 * Run it from anywhere:
 *     node test/test-workspace.cjs
 */

process.env.TZ = 'UTC' /* formatWhen() prints local time; this suite pins it */

const fs = require('fs')
const path = require('path')

const SOURCE = path.join(__dirname, '..', 'lib', 'bot.js')
const SCRATCH_DIR = path.join(__dirname, '.scratch')
const HARNESS = path.join(SCRATCH_DIR, 'workspace-under-test.cjs')

if (!fs.existsSync(SOURCE)) {
  console.error('cannot find the plugin source under test: ' + SOURCE)
  process.exit(1)
}
const src = fs.readFileSync(SOURCE, 'utf8')

/* Slice host.js between two literal markers. `endMarker` is matched after
 * `startMarker`; a one-line declaration can be sliced by passing only its own
 * text. A missing marker is a hard error, never a silent skip. */
function slice(startMarker, endMarker) {
  const a = src.indexOf(startMarker)
  if (a === -1) throw new Error('missing source marker: ' + JSON.stringify(startMarker))
  if (endMarker === undefined) return startMarker
  const b = src.indexOf(endMarker, a)
  if (b === -1) {
    throw new Error('missing source marker after ' + JSON.stringify(startMarker) + ': ' + JSON.stringify(endMarker))
  }
  return src.slice(a, b + endMarker.length)
}

/* ------- constants and small helpers, sliced verbatim -------
 * Markers stop at the line end wherever a value could change, so a new HOME or
 * a new array of defaults does not break the suite. */
/* The implementation resolves the home directory through node:os and derives
 * the session-log directory from $DSH_HOME. Rather than hard-code a constant
 * that no longer exists, the harness supplies the same builtins and slices the
 * real DSH_HOME / SESSIONS_GLOB declarations, so a change to either is picked
 * up here instead of silently emptying the mtime map. */
const HOME_DECL = [
  "const { homedir } = require('node:os')",
  "const { join, resolve } = require('node:path')",
  slice('const DSH_HOME = ', "join(homedir(), '.dsh')\n"),
  slice('const SESSIONS_GLOB = ', '\n'),
].join('\n')
const MAX_REMEMBERED_DECL = slice('const MAX_REMEMBERED_SESSIONS = ', '\n')
const DEFAULTS_DECL = slice('const DEFAULTS = {', '\n}')
const READ_MAX_BYTES_DECL = slice('    const READ_MAX_BYTES = ', '\n')
const TOUCHED_CACHE_DECL = slice('    let touchedCache = { at: 0, value: null }')
const describeErrorFn = slice('    function describeError(error) {', "return error.name === undefined ? message : error.name + ': ' + message\n    }")
const quoteFn = slice('    function quote(value) {', '+ "\'"\n    }')
const expandHomeFn = slice('    function expandHome(input) {', '      return raw\n    }')
const canonicalDirFn = slice('    async function canonicalDir(candidate) {', "return resolved === '' ? undefined : resolved\n    }")

/* ------- /ws argument handling ------- */
const parseWorkspaceArgFn = slice('    function parseWorkspaceArg(argument) {', '      return { query: pieces.join(\' \').trim(), fresh: fresh }\n    }')
const baseNameFn = slice('    function baseName(path) {', '      return index === -1 ? trimmed : trimmed.slice(index + 1)\n    }')
const workspacePathForFn = slice('    function workspacePathFor(entry) {', "      return String(config.workspacePath || '')\n    }")
const isDefaultWorkspaceFn = slice('    function isDefaultWorkspace(entry) {', "      return !(typeof entry.workspacePath === 'string' && entry.workspacePath !== '')\n    }")
const workspaceOptionsFn = slice('    function workspaceOptions(entry) {', '      return { current: current, options: options }\n    }')
const renderWorkspaceListFn = slice('    async function renderWorkspaceList(entry) {', "      return lines.join('\\n')\n    }")
const resolveWorkspaceArgFn = slice('    async function resolveWorkspaceArg(entry, arg) {', '      return { path: resolved }\n    }')

/* ------- resuming the right session ------- */
const sessionIdForFn = slice('    function sessionIdFor(chatId, generation) {', "'-g' + generation : '')\n    }")
const rememberSessionFn = slice('    function rememberSession(entry, id) {', 'MAX_REMEMBERED_SESSIONS\n    }')
const rememberedSessionsFn = slice('    function rememberedSessions(entry) {', '      return entry.sessions\n    }')
const effectiveTimeoutFn = slice('    function effectiveTimeout() {', ': DEFAULTS.timeoutMs\n    }')
const withSessionSwapFn = slice('    async function withSessionSwap(chatId, entry, apply) {', '      return apply()\n    }')
const restartChatSessionFn = slice('    async function restartChatSession(chatId, entry) {', '        return entry.sessionId\n      })\n    }')
const switchChatSessionFn = slice('    async function switchChatSession(chatId, entry, targetId) {', '        return entry.sessionId\n      })\n    }')
const formatWhenFn = slice('    function formatWhen(ms) {', "pad(when.getHours()) + ':' + pad(when.getMinutes())\n    }")
const isBotSessionIdFn = slice('    function isBotSessionId(id) {', "      return id.indexOf('feishu-') === 0\n    }")
const sessionBusyFn = slice('    function sessionBusy(id) {', '      return svc(\'agents\').get(id) !== undefined && liveHandles.get(id) === undefined\n    }')
const otherChatOwnsFn = slice('    function otherChatOwns(sessionId, entry) {', '      return false\n    }')
const sessionTouchedAtFn = slice('    async function sessionTouchedAt() {', '      return touched\n    }')
const workspacePicksFn = slice('    async function workspacePicks(entry) {', '      return picks\n    }')
const latestSessionInFn = slice('    async function latestSessionIn(workspace, entry) {', '      return picks.get(workspace)\n    }')
const sessionTitlesFn = slice('    async function sessionTitles(ids) {', '      return titles\n    }')
const sessionLabelFn = slice('    function sessionLabel(row, title) {', "      return row.mine ? row.id : '（无标题）'\n    }")
const switchWorkspaceFn = slice('    async function switchWorkspace(chatId, entry, target, options) {', "      return { ok: true, message: lines.join('\\n') }\n    }")

/* The generated harness: real source slices + stubs for the deployment's edges. */
const prelude = `/* GENERATED by tests/test-workspace.cjs -- do not edit, do not commit. */
${HOME_DECL}
${MAX_REMEMBERED_DECL}
${DEFAULTS_DECL}
${READ_MAX_BYTES_DECL}

/* --- the deployment's configuration: config.json on this machine --- */
let config = Object.assign({}, DEFAULTS, { workspacePath: '/work/beta' })

/* --- the log file (a boundary: host.js writes it, then rotates it) --- */
const logged = []
function log() { logged.push(Array.prototype.join.call(arguments, ' ')) }

${describeErrorFn}
${quoteFn}
${expandHomeFn}
${canonicalDirFn}

/* --- ctx services (a boundary: the process host provides these) --- */
const services = {}
function svc(name) {
  const found = services[name]
  if (found === undefined) throw new Error('service "' + name + '" is not mounted in this deployment')
  return found
}

/* --- mutable plugin state that the tests drive directly --- */
const chats = {
  oc_p2p: { sessionId: 'feishu-oc_p2p-g3', generation: 3, chatType: 'p2p', workspacePath: '/work/alpha' },
  oc_grp: { sessionId: 'feishu-oc_grp', generation: 0, chatType: 'group' },
}
const liveHandles = new Map()  /* agents THIS plugin holds */
const captures = new Map()     /* turns in flight, keyed by session id */
const deferredSwaps = new Map()
const LIVE = new Set()         /* sessions something ELSE (the GUI) holds */
${TOUCHED_CACHE_DECL}

/* --- state.json (a boundary) --- */
let saved = 0
async function saveState() { saved += 1 }

/* --- the shell (a boundary: ctx.get('shell')). Only two probes are answered:
 * the session-log stat sweep and the \`cd X && pwd -P\` directory probe.
 * Anything else fails hard, exactly like a command that is not installed. --- */
let statOutput = ''
let statCode = 0
async function sh(command) {
  if (command.indexOf('stat -f') !== -1) {
    return { code: statCode, stdout: statOutput, stderr: '', timedOut: false, truncated: false }
  }
  if (command.indexOf('&& pwd -P') !== -1) {
    const target = command.slice(command.indexOf("cd '") + 4, command.lastIndexOf("' && pwd -P"))
    const hit = WORKSPACES.filter(function (w) { return w.path === target })[0]
    if (hit === undefined) {
      return { code: 1, stdout: '', stderr: 'cd: no such file or directory: ' + target, timedOut: false, truncated: false }
    }
    return { code: 0, stdout: hit.path + '\\n', stderr: '', timedOut: false, truncated: false }
  }
  return { code: 127, stdout: '', stderr: 'not stubbed: ' + command, timedOut: false, truncated: false }
}

/* ------------------------------------------------------------------ *
 * fixtures
 * ------------------------------------------------------------------ */
function at(iso) { return Date.parse(iso) }

const CANGDAI = '/work/alpha'
const RONGZI = '/work/beta'
const DSH = '/work/DSH'
const EMPTY = '/work/Empty'
const P2P = 'feishu-oc_p2p-g3'
const GROUP = 'feishu-oc_grp'
const NEWEST_IN_CANGDAI = 'session-5fda381f'
const RESUMED_IN_CANGDAI = 'session-6f42599d'
const RESUMED_IN_RONGZI = 'session-f5437888'
const NEXT_IN_CANGDAI = 'session-35a12de1'
const OLDER_IN_RONGZI = 'session-a136dd83'
const CHILD = 'child-b45caa73'
const DSH_ONLY = 'session-oldds'

/* listSessions() order: CREATION time, newest first. */
const CORPUS = [
  { id: NEWEST_IN_CANGDAI, cwd: CANGDAI, createdAt: at('2025-01-20T11:00:00Z') },
  { id: P2P, cwd: CANGDAI, createdAt: at('2025-01-19T09:00:00Z') },
  { id: RESUMED_IN_CANGDAI, cwd: CANGDAI, createdAt: at('2025-01-18T15:00:00Z') },
  { id: GROUP, cwd: RONGZI, createdAt: at('2025-01-17T20:00:00Z') },
  { id: OLDER_IN_RONGZI, cwd: RONGZI, createdAt: at('2025-01-16T08:00:00Z') },
  { id: RESUMED_IN_RONGZI, cwd: RONGZI, createdAt: at('2025-01-15T12:00:00Z') },
  { id: CHILD, cwd: RONGZI, createdAt: at('2025-01-14T07:00:00Z'), origin: 'subagent' },
  { id: NEXT_IN_CANGDAI, cwd: CANGDAI, createdAt: at('2025-01-13T18:00:00Z') },
  { id: DSH_ONLY, cwd: DSH, createdAt: at('2025-01-12T10:00:00Z') },
]

/* When each session log was last written (stat -f "%m %N"), in ms.
 * Deliberately NOT the creation order: the session the user is in right now
 * was created before one that was started earlier and abandoned. */
const MTIMES = {}
MTIMES[RESUMED_IN_CANGDAI] = at('2025-03-14T09:30:00Z')
MTIMES[NEXT_IN_CANGDAI] = at('2025-03-14T08:15:00Z')
MTIMES[NEWEST_IN_CANGDAI] = at('2025-03-13T22:05:00Z')
MTIMES[RESUMED_IN_RONGZI] = at('2025-03-12T18:45:00Z')
MTIMES[OLDER_IN_RONGZI] = at('2025-03-12T10:00:00Z')
MTIMES[DSH_ONLY] = at('2025-03-01T07:07:00Z')

const TITLES = {}
TITLES[RESUMED_IN_CANGDAI] = '分析两份文档'
TITLES[RESUMED_IN_RONGZI] = 'beta原型'

/* The workspace registry, in registry order: that order IS the /ws numbering. */
const WORKSPACES = [
  { title: 'DSH', path: DSH },
  { title: 'alpha', path: CANGDAI },
  { title: 'beta', path: RONGZI },
  { title: 'Empty', path: EMPTY },
]

services.sessionQuery = {
  listSessions: async function () {
    return CORPUS.map(function (row) {
      return {
        header: { version: 3, id: row.id, cwd: row.cwd, createdAt: row.createdAt, agentPreset: 'standard', origin: row.origin },
        live: false,
        persisted: true,
      }
    })
  },
  readTitleSnapshots: async function (ids) {
    return ids.map(function (id) {
      return { status: 'fulfilled', sessionId: id, value: { session: { id: id }, title: { title: TITLES[id] } } }
    })
  },
}
services.agents = { get: function (id) { return LIVE.has(id) ? { id: id } : undefined } }
services.workspaceRegistry = { list: function () { return WORKSPACES.slice() } }

function statLines(times) {
  const lines = []
  const ids = Object.keys(times)
  for (let i = 0; i < ids.length; i += 1) {
    lines.push(Math.floor(times[ids[i]] / 1000) + ' /dsh/sessions/--x--/' + ids[i] + '/session.v3.jsonl.zstd')
  }
  return lines.join('\\n')
}
function buildStat(extra) {
  statOutput = statLines(Object.assign({}, MTIMES, extra === undefined ? {} : extra))
  statCode = 0
}
function setStat(text, code) {
  statOutput = text
  statCode = code === undefined ? 0 : code
}
function resetTouched() { touchedCache = { at: 0, value: null } }

/* ------------------------------------------------------------------ *
 * the code under test, sliced out of host.js
 * ------------------------------------------------------------------ */
${parseWorkspaceArgFn}
${baseNameFn}
${workspacePathForFn}
${isDefaultWorkspaceFn}
${workspaceOptionsFn}
${sessionIdForFn}
${rememberSessionFn}
${rememberedSessionsFn}
${effectiveTimeoutFn}
${withSessionSwapFn}
${restartChatSessionFn}
${switchChatSessionFn}
${formatWhenFn}
${isBotSessionIdFn}
${sessionBusyFn}
${otherChatOwnsFn}
${sessionTouchedAtFn}
${workspacePicksFn}
${latestSessionInFn}
${sessionTitlesFn}
${sessionLabelFn}
${renderWorkspaceListFn}
${resolveWorkspaceArgFn}
${switchWorkspaceFn}

function reset() {
  logged.length = 0
  LIVE.clear()
  liveHandles.clear()
  captures.clear()
  deferredSwaps.clear()
  saved = 0
  chats.oc_p2p.sessionId = P2P
  chats.oc_p2p.generation = 3
  chats.oc_p2p.workspacePath = CANGDAI
  delete chats.oc_p2p.sessions
  chats.oc_grp.sessionId = GROUP
  chats.oc_grp.generation = 0
  delete chats.oc_grp.workspacePath
  delete chats.oc_grp.sessions
  buildStat()
  resetTouched()
}
buildStat()

module.exports = {
  chats, liveHandles, captures, deferredSwaps, config, logged, LIVE, services,
  MTIMES, TITLES, WORKSPACES, CORPUS, at,
  CANGDAI, RONGZI, DSH, EMPTY, P2P, GROUP,
  NEWEST_IN_CANGDAI, RESUMED_IN_CANGDAI, RESUMED_IN_RONGZI, NEXT_IN_CANGDAI,
  OLDER_IN_RONGZI, CHILD, DSH_ONLY,
  saved: function () { return saved },
  setStat, buildStat, resetTouched, reset,
  parseWorkspaceArg, baseName, workspacePathFor, isDefaultWorkspace, workspaceOptions,
  renderWorkspaceList, resolveWorkspaceArg, sessionIdFor, rememberedSessions,
  formatWhen, isBotSessionId, sessionBusy, otherChatOwns, sessionTouchedAt,
  workspacePicks, latestSessionIn, sessionTitles, sessionLabel, switchWorkspace,
  restartChatSession, switchChatSession,
}
`

fs.mkdirSync(SCRATCH_DIR, { recursive: true })
fs.writeFileSync(HARNESS, prelude)
const R = require(HARNESS)

/* ------------------------------------------------------------------ *
 * assertions
 * ------------------------------------------------------------------ */
let failures = 0
function check(name, condition, detail) {
  if (condition) {
    console.log('  ok   ' + name)
  } else {
    failures += 1
    console.log('  FAIL ' + name)
    if (detail !== undefined) console.log('       ' + detail)
  }
}
const show = function (value) {
  return typeof value === 'string' ? value : JSON.stringify(value)
}
const count = function (haystack, needle) {
  return haystack.split(needle).length - 1
}

const MtimesFallbackLine = 'session mtimes unavailable (exit 1); /ws falls back to creation time'

async function suite() {
  /* ---- /ws argument parsing ------------------------------------- */
  {
    const parsed = R.parseWorkspaceArg('alpha')
    check('a bare query has no flag', parsed.query === 'alpha' && parsed.fresh === false, show(parsed))
  }
  {
    const parsed = R.parseWorkspaceArg('alpha new')
    check('a trailing new is the flag', parsed.query === 'alpha' && parsed.fresh === true, show(parsed))
  }
  {
    const parsed = R.parseWorkspaceArg('alpha fresh')
    check('fresh is accepted too', parsed.query === 'alpha' && parsed.fresh === true, show(parsed))
  }
  {
    const parsed = R.parseWorkspaceArg('new')
    check('a trailing new IS the query when alone', parsed.query === 'new' && parsed.fresh === false, show(parsed))
  }
  {
    const parsed = R.parseWorkspaceArg('/work/my project new')
    check('a path with spaces keeps its shape', parsed.query === '/work/my project' && parsed.fresh === true, show(parsed))
  }
  {
    const parsed = R.parseWorkspaceArg('new alpha')
    check('the flag is only read at the end', parsed.query === 'new alpha' && parsed.fresh === false, show(parsed))
  }

  /* ---- which session a workspace would resume -------------------- */
  R.reset()
  const entry = R.chats.oc_p2p
  const picks = await R.workspacePicks(entry)
  const cangdai = picks.get(R.CANGDAI)
  const rongzi = picks.get(R.RONGZI)
  const dsh = picks.get(R.DSH)

  check(
    'alpha resumes by LAST USED, not by creation order',
    cangdai !== undefined && cangdai.id === R.RESUMED_IN_CANGDAI && cangdai.createdAt === R.at('2025-01-18T15:00:00Z'),
    'pick=' + show(cangdai) + ' newest CREATED in alpha is ' + R.NEWEST_IN_CANGDAI + ' (created ' + R.at('2025-01-20T11:00:00Z') + ', last used ' + R.at('2025-03-13T22:05:00Z') + ')'
  )
  check(
    'beta likewise',
    rongzi !== undefined && rongzi.id === R.RESUMED_IN_RONGZI && rongzi.createdAt === R.at('2025-01-15T12:00:00Z'),
    'pick=' + show(rongzi)
  )
  check(
    'the pick carries the time it was last used',
    cangdai.at === R.at('2025-03-14T09:30:00Z') && rongzi.at === R.at('2025-03-12T18:45:00Z') && dsh.at === R.at('2025-03-01T07:07:00Z'),
    'alpha.at=' + cangdai.at + ' beta.at=' + rongzi.at + ' DSH.at=' + dsh.at
  )
  check('DSH has one session and it is picked', dsh !== undefined && dsh.id === R.DSH_ONLY, show(dsh))

  /* A session this chat is on must never be offered back to it, even when it
   * is the most recently used one in the workspace. */
  R.buildStat({ [R.P2P]: R.at('2025-03-20T00:00:00Z') })
  R.resetTouched()
  const ownPicks = await R.workspacePicks(entry)
  check(
    "this chat's own session is never the pick",
    ownPicks.get(R.CANGDAI).id === R.RESUMED_IN_CANGDAI && ownPicks.get(R.CANGDAI).id !== R.P2P,
    'pick=' + show(ownPicks.get(R.CANGDAI)) + ' with ' + R.P2P + ' at the top of the mtimes'
  )

  /* ... nor a session this plugin minted for ANOTHER chat... */
  R.buildStat({ [R.GROUP]: R.at('2025-03-20T00:00:00Z') })
  R.resetTouched()
  const groupPicks = await R.workspacePicks(entry)
  check(
    "another chat's session is never the pick",
    groupPicks.get(R.RONGZI).id === R.RESUMED_IN_RONGZI && groupPicks.get(R.RONGZI).id !== R.GROUP,
    'pick=' + show(groupPicks.get(R.RONGZI)) + ' with ' + R.GROUP + ' at the top of the mtimes'
  )

  /* ... nor a delegated child, however recently it wrote... */
  R.buildStat({ [R.CHILD]: R.at('2025-03-20T00:00:00Z') })
  R.resetTouched()
  const childPicks = await R.workspacePicks(entry)
  check(
    'a delegated child is never the pick',
    childPicks.get(R.RONGZI).id === R.RESUMED_IN_RONGZI,
    'pick=' + show(childPicks.get(R.RONGZI)) + ' with ' + R.CHILD + ' at the top of the mtimes'
  )

  /* ... but a session the GUI holds is shared, not skipped. */
  R.buildStat()
  R.resetTouched()
  R.LIVE.add(R.RESUMED_IN_CANGDAI)
  const livePicks = await R.workspacePicks(entry)
  check(
    'a session the GUI is driving is STILL picked',
    livePicks.get(R.CANGDAI).id === R.RESUMED_IN_CANGDAI && livePicks.get(R.CANGDAI).live === true,
    show(livePicks.get(R.CANGDAI))
  )
  check(
    'and it is flagged as live elsewhere',
    livePicks.get(R.CANGDAI).live === true && livePicks.get(R.RONGZI).live === false,
    'alpha.live=' + livePicks.get(R.CANGDAI).live + ' beta.live=' + livePicks.get(R.RONGZI).live
  )
  R.liveHandles.set(R.RESUMED_IN_CANGDAI, { dispose: async function () {} })
  R.resetTouched()
  const ownHandlePicks = await R.workspacePicks(entry)
  check(
    'a session nobody else holds is not flagged',
    ownHandlePicks.get(R.RONGZI).live === false && ownHandlePicks.get(R.DSH).live === false && ownHandlePicks.get(R.CANGDAI).live === false,
    'beta.live=' + ownHandlePicks.get(R.RONGZI).live + ' DSH.live=' + ownHandlePicks.get(R.DSH).live + ' alpha.live=' + ownHandlePicks.get(R.CANGDAI).live + ' (the last one is held by THIS plugin)'
  )

  /* ---- switching INTO a session the GUI already has open ------ */
  R.reset()
  entry.workspacePath = R.DSH
  R.LIVE.add(R.RESUMED_IN_CANGDAI)
  const intoLive = await R.switchWorkspace('oc_p2p', entry, R.CANGDAI)
  check(
    'switching INTO a GUI-open session warns instead of refusing',
    intoLive.ok === true && entry.sessionId === R.RESUMED_IN_CANGDAI,
    'ok=' + intoLive.ok + ' sessionId=' + entry.sessionId + '\n' + intoLive.message
  )
  check(
    'the warning is in the reply',
    intoLive.message.indexOf('⚠️ 该会话此刻在 GUI 里也开着') !== -1 && intoLive.message.indexOf('建议一次只在一处说') !== -1,
    show(intoLive.message)
  )
  /* the switch above moved this chat ONTO that session; put the chat back where
   * it was so the session is somebody else's again, not its own */
  R.reset()
  entry.workspacePath = R.DSH
  R.LIVE.add(R.RESUMED_IN_CANGDAI)
  const liveListing = await R.renderWorkspaceList(entry)
  check(
    'the listing marks a GUI-open session',
    liveListing.indexOf('    ↳ 接着 03-14 09:30 那次会话（GUI 里也开着）') !== -1,
    show(liveListing)
  )

  /* ---- when the mtimes cannot be read at all ------------------- */
  R.reset()
  R.setStat('', 1)
  R.resetTouched()
  const noMtimes = await R.workspacePicks(entry)
  check(
    'without mtimes it falls back to creation order',
    noMtimes.get(R.CANGDAI).id === R.NEWEST_IN_CANGDAI && noMtimes.get(R.CANGDAI).at === R.at('2025-01-20T11:00:00Z'),
    show(noMtimes.get(R.CANGDAI))
  )
  check(
    'a failed stat is logged, not thrown',
    R.logged.indexOf(MtimesFallbackLine) !== -1,
    show(R.logged)
  )
  check(
    'a failing stat still yields picks',
    noMtimes.size === 3 && noMtimes.get(R.RONGZI).id === R.OLDER_IN_RONGZI && noMtimes.get(R.DSH).id === R.DSH_ONLY,
    'size=' + noMtimes.size + ' beta=' + show(noMtimes.get(R.RONGZI)) + ' DSH=' + show(noMtimes.get(R.DSH))
  )
  await R.workspacePicks(entry)
  check(
    'the failure is logged once',
    count(R.logged.join('\n'), MtimesFallbackLine) === 1,
    show(R.logged)
  )

  R.setStat(
    [
      'garbage-without-a-space',
      ' abc /dsh/sessions/--x--/' + R.RESUMED_IN_CANGDAI + '/session.v3.jsonl.zstd',
      '1 x',
      Math.floor(R.at('2025-03-14T08:15:00Z') / 1000) + ' /dsh/sessions/--x--/' + R.NEXT_IN_CANGDAI + '/session.v3.jsonl.zstd',
    ].join('\n'),
    0
  )
  R.resetTouched()
  R.logged.length = 0 /* the fallback line from the failure above must not count here */
  const messy = await R.workspacePicks(entry)
  check(
    'unparsable stat lines are ignored',
    messy.get(R.CANGDAI).id === R.NEXT_IN_CANGDAI &&
      messy.get(R.CANGDAI).at === R.at('2025-03-14T08:15:00Z') &&
      messy.get(R.RONGZI).id === R.OLDER_IN_RONGZI &&
      R.logged.every(function (line) { return line.indexOf('session mtimes') === -1 }),
    'alpha=' + show(messy.get(R.CANGDAI)) + ' beta=' + show(messy.get(R.RONGZI)) + ' logged=' + show(R.logged)
  )

  R.buildStat()
  R.resetTouched()
  const emptyPick = await R.latestSessionIn(R.EMPTY, entry)
  check(
    'latestSessionIn returns undefined for a workspace with no sessions',
    emptyPick === undefined,
    show(emptyPick)
  )

  /* ---- switching resumes the last-used session ----------------- */
  R.reset()
  delete entry.workspacePath /* currently on the deployment default */
  const disposed = []
  R.liveHandles.set(R.P2P, { dispose: async function () { disposed.push(R.P2P) } })
  const resumed = await R.switchWorkspace('oc_p2p', entry, R.CANGDAI)
  check(
    'switching resumes the last-used session',
    resumed.ok === true && entry.sessionId === R.RESUMED_IN_CANGDAI,
    'ok=' + resumed.ok + ' sessionId=' + entry.sessionId
  )
  check(
    'it went through the guarded swap',
    disposed.length === 1 &&
      disposed[0] === R.P2P &&
      R.liveHandles.has(R.P2P) === false &&
      R.logged.every(function (line) { return line.indexOf('swap deferred') === -1 }),
    'disposed=' + show(disposed) + ' liveHandles=' + show(Array.from(R.liveHandles.keys())) + ' logged=' + show(R.logged)
  )
  const remembered = R.rememberedSessions(entry).map(function (saved) { return saved.id })
  check(
    'the old session is remembered',
    remembered.length === 1 && remembered[0] === R.P2P,
    show(remembered)
  )
  check(
    'the reply names the session it attached to',
    resumed.message.indexOf('会话 ID：' + R.RESUMED_IN_CANGDAI) !== -1,
    show(resumed.message)
  )
  check(
    'the reply says when that session was last used',
    resumed.message.indexOf('接着最近用过的会话：分析两份文档（03-14 09:30）') !== -1 &&
      resumed.message.indexOf('01-18') === -1,
    'expected the 2025-03-14T09:30Z mtime (03-14 09:30), not the 2025-01-18 creation time\n' + show(resumed.message)
  )
  check(
    'the reply shows the title when there is one',
    resumed.message.indexOf('接着最近用过的会话：分析两份文档（') !== -1 &&
      resumed.message.indexOf('接着最近用过的会话：' + R.RESUMED_IN_CANGDAI) === -1 &&
      resumed.message.indexOf('（无标题）') === -1,
    show(resumed.message)
  )
  check(
    'the reply offers the escape hatch',
    resumed.message.indexOf('想从零开始就发 /new。') !== -1,
    show(resumed.message)
  )
  check(
    'the workspace override is recorded',
    entry.workspacePath === R.CANGDAI && R.workspacePathFor(entry) === R.CANGDAI && R.isDefaultWorkspace(entry) === false,
    'workspacePath=' + show(entry.workspacePath) + ' isDefault=' + R.isDefaultWorkspace(entry)
  )
  check(
    'the switch is persisted',
    R.saved() === 1 &&
      R.logged.indexOf('workspace switch chat=oc_p2p -> /work/alpha session=' + R.RESUMED_IN_CANGDAI + ' (override) (resumed)') !== -1,
    'saveState calls=' + R.saved() + ' logged=' + show(R.logged)
  )

  /* ---- /ws <workspace> new ------------------------------------- */
  R.reset()
  delete entry.workspacePath
  const fresh = await R.switchWorkspace('oc_p2p', entry, R.CANGDAI, { fresh: true })
  check(
    'fresh asks for a brand-new session',
    fresh.ok === true && entry.sessionId === 'feishu-oc_p2p-g4' && entry.generation === 4,
    'ok=' + fresh.ok + ' sessionId=' + entry.sessionId + ' generation=' + entry.generation
  )
  check(
    'fresh does not inherit the other session',
    entry.sessionId !== R.RESUMED_IN_CANGDAI &&
      fresh.message.indexOf(R.RESUMED_IN_CANGDAI) === -1 &&
      fresh.message.indexOf('接着最近用过的会话') === -1,
    show(fresh.message)
  )
  check(
    'fresh says the context was reset',
    fresh.message.indexOf('新会话：feishu-oc_p2p-g4（上下文已重置，仅本会话生效）') !== -1,
    show(fresh.message)
  )
  check(
    'fresh logs why it did not resume',
    R.logged.indexOf('workspace switch chat=oc_p2p -> /work/alpha session=feishu-oc_p2p-g4 (override) (fresh)') !== -1 &&
      R.logged.every(function (line) { return line.indexOf('(no session to resume)') === -1 }),
    show(R.logged)
  )

  /* ---- a workspace with nothing to resume ---------------------- */
  R.reset()
  const intoEmpty = await R.switchWorkspace('oc_p2p', entry, R.EMPTY)
  check(
    'a workspace with nothing to resume gets a new session',
    intoEmpty.ok === true && entry.sessionId === 'feishu-oc_p2p-g4' && entry.workspacePath === R.EMPTY,
    'ok=' + intoEmpty.ok + ' sessionId=' + entry.sessionId + ' workspacePath=' + show(entry.workspacePath)
  )
  check(
    'and says so',
    intoEmpty.message.indexOf('新会话：feishu-oc_p2p-g4（上下文已重置，仅本会话生效）') !== -1 &&
      R.logged.indexOf('workspace switch chat=oc_p2p -> /work/Empty session=feishu-oc_p2p-g4 (override) (no session to resume)') !== -1,
    show(intoEmpty.message) + '\nlogged=' + show(R.logged)
  )

  /* ---- switching to the workspace the chat is already in ------- */
  R.reset()
  const same = await R.switchWorkspace('oc_p2p', entry, R.CANGDAI)
  check(
    'switching to the current workspace is a no-op',
    same.ok === true && entry.sessionId === R.P2P && entry.generation === 3 && R.saved() === 0 && R.logged.length === 0,
    'ok=' + same.ok + ' sessionId=' + entry.sessionId + ' generation=' + entry.generation + ' saveState calls=' + R.saved() + ' logged=' + show(R.logged)
  )
  check(
    'and points at /s and /new instead',
    same.message === '已经在这个工作区了：/work/alpha\n（换会话用 /s，开新会话用 /new）',
    show(same.message)
  )

  /* ---- a directory that is not there, and the default ---------- */
  R.reset()
  const missing = await R.switchWorkspace('oc_p2p', entry, 'nope')
  check(
    'a missing directory is refused',
    missing.ok === false && missing.message === '目录不存在：nope' && entry.sessionId === R.P2P && R.saved() === 0,
    'ok=' + missing.ok + ' message=' + show(missing.message) + ' sessionId=' + entry.sessionId
  )

  R.reset()
  const toDefault = await R.switchWorkspace('oc_p2p', entry, R.RONGZI)
  check(
    'switching to the default clears the override',
    entry.workspacePath === undefined && R.isDefaultWorkspace(entry) === true && R.workspacePathFor(entry) === R.config.workspacePath,
    'workspacePath=' + show(entry.workspacePath) + ' isDefault=' + R.isDefaultWorkspace(entry) + ' effective=' + R.workspacePathFor(entry)
  )
  check(
    'and resumes there too',
    toDefault.ok === true && entry.sessionId === R.RESUMED_IN_RONGZI && toDefault.message.indexOf('接着最近用过的会话：beta原型（03-12 18:45）') !== -1,
    'sessionId=' + entry.sessionId + '\n' + show(toDefault.message)
  )

  /* ---- a session another chat was switched onto ---------------- */
  R.reset()
  R.chats.oc_grp.sessionId = R.RESUMED_IN_CANGDAI
  const foreign = await R.workspacePicks(entry)
  check(
    'a session another chat was switched onto is excluded',
    foreign.get(R.CANGDAI).id === R.NEXT_IN_CANGDAI &&
      foreign.get(R.CANGDAI).at === R.at('2025-03-14T08:15:00Z') &&
      foreign.get(R.CANGDAI).id !== R.RESUMED_IN_CANGDAI &&
      R.logged.indexOf('session picks skipped: feishu-oc_p2p-g3 = this chat | session-6f42599d = another chat (switched) | feishu-oc_grp = another chat | child-b45caa73 = subagent') !== -1,
    'pick=' + show(foreign.get(R.CANGDAI)) + '\nlogged=' + show(R.logged)
  )

  /* ---- the /ws listing ----------------------------------------- */
  R.reset()
  const listing = await R.renderWorkspaceList(entry)
  check(
    'the listing keeps every workspace and its path',
    listing.indexOf('📁 工作区（4）') === 0 &&
      [R.DSH, R.CANGDAI, R.RONGZI, R.EMPTY].every(function (p) { return listing.indexOf('\n    ' + p) !== -1 }),
    show(listing)
  )
  check(
    'the current workspace is marked',
    listing.indexOf('2. alpha   ← 当前\n    /work/alpha') !== -1,
    show(listing)
  )
  check(
    'each workspace says what it would resume',
    count(listing, '    ↳ ') === 4 &&
      listing.indexOf('    ↳ 接着 03-01 07:07 那次会话') !== -1 &&
      listing.indexOf('    ↳ 接着 03-12 18:45 那次会话') !== -1 &&
      listing.indexOf('    ↳ 就是当前工作区') !== -1 &&
      listing.indexOf('    ↳ 没有可用会话，过去会开一个') !== -1,
    show(listing)
  )
  check(
    'the current row does not claim it would switch',
    listing.indexOf('    /work/alpha\n    ↳ 就是当前工作区') !== -1 &&
      listing.indexOf('03-14 09:30') === -1,
    'the current workspace must not be offered back, even though it has a session used at 03-14 09:30\n' + show(listing)
  )
  check(
    'a resumable workspace shows the time',
    listing.indexOf('    ↳ 接着 03-12 18:45 那次会话') !== -1 && listing.indexOf('01-15') === -1,
    'expected the 2025-03-12T18:45Z mtime (03-12 18:45), not the 2025-01-15 creation time\n' + show(listing)
  )
  check(
    'an empty workspace says it would start one',
    listing.indexOf('    /work/Empty\n    ↳ 没有可用会话，过去会开一个') !== -1,
    show(listing)
  )
  check(
    'the footer documents the flag',
    listing.indexOf('默认接着该工作区最近用过的会话；想开全新的加 new，例如 /ws 2 new') !== -1 &&
      listing.indexOf('/ws default  恢复默认：' + R.config.workspacePath) !== -1,
    show(listing)
  )
  check(
    'the old "switch opens a new session" line is gone',
    count(listing, '没有可用会话，过去会开一个') === 1 && listing.indexOf('    ↳ 就是当前工作区') !== -1,
    'only the workspace with no history may offer a new session; every other row must resume\n' + show(listing)
  )

  /* ---- resolving a /ws argument -------------------------------- */
  R.reset()
  const byIndex = await R.resolveWorkspaceArg(entry, '3')
  check(
    'an index resolves to a path',
    byIndex.error === undefined && byIndex.path === R.RONGZI,
    show(byIndex)
  )
  const byName = await R.resolveWorkspaceArg(entry, 'alpha')
  const byLowerCaseName = await R.resolveWorkspaceArg(entry, 'empty')
  check(
    'a name resolves to a path',
    byName.error === undefined && byName.path === R.CANGDAI && byLowerCaseName.error === undefined && byLowerCaseName.path === R.EMPTY,
    'alpha -> ' + show(byName) + ' empty -> ' + show(byLowerCaseName)
  )
  const outOfRange = await R.resolveWorkspaceArg(entry, '9')
  check(
    'an out-of-range index lists the workspaces',
    outOfRange.path === undefined &&
      outOfRange.error.indexOf('序号 9 超出范围（共 4 个）\n\n📁 工作区（4）') === 0 &&
      outOfRange.error.indexOf('    ↳ 接着 03-12 18:45 那次会话') !== -1,
    show(outOfRange)
  )
  const unknown = await R.resolveWorkspaceArg(entry, 'nope')
  check(
    'an unknown path lists the workspaces',
    unknown.path === undefined &&
      unknown.error.indexOf('找不到目录：“nope”\n需要是一个已存在的绝对路径（支持 ~）。当前可选：\n\n📁 工作区（4）') === 0,
    show(unknown)
  )
}

suite().then(
  function () {
    console.log('')
    console.log(failures === 0 ? 'all assertions passed' : failures + ' FAILED')
    process.exit(failures === 0 ? 0 : 1)
  },
  function (error) {
    failures += 1
    console.log('  FAIL the suite ran to completion')
    console.log('       ' + String(error && error.stack ? error.stack : error).split('\n').join('\n       '))
    console.log('')
    console.log(failures + ' FAILED')
    process.exit(1)
  }
)
