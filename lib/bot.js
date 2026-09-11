/*
 * The Feishu/Lark <-> DSH bridge.
 *
 * This file is the whole implementation; `index.js` is a three-line entry that
 * imports it with a cache-busting query so that editing this file and
 * re-activating the row takes effect without a restart.
 *
 * It is a normal ES module: it runs in the DSH host process as a Cordis plugin
 * and may use Node builtins directly.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

/*
 * The tool registry, as the code below expects it. In a dynamic Cordis package
 * this arrived as the sandbox's `harness` global; here it is just the two real
 * functions. `registerTool` takes the ctx explicitly because the tool must be
 * owned by the CALLING fiber, not by this module.
 */
const harness = {
  defineTool: defineTool,
  registerTool: function (target, tool) {
    target.tools.register(tool)
  },
}

/*
 * `btoa`/`atob` over Buffer's BINARY encoding, not Node's global UTF-8 pair:
 * they only handle ciphertext, and re-encoding bytes as text would corrupt it.
 */
function btoa(binary) {
  return Buffer.from(binary, 'binary').toString('base64')
}
function atob(base64) {
  return Buffer.from(base64, 'base64').toString('binary')
}

/* ------------------------------------------------------------------ *
 * where things live
 *
 * Nothing here is user-specific. The data directory is derived at import
 * time from the environment, so the same package runs for any account on any
 * machine, and an operator can move the state with one variable.
 * ------------------------------------------------------------------ */

/** This package's own directory: the bridge script lives beside this file. */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

/** `$DSH_HOME`, defaulting to `~/.dsh` exactly as the harness does. */
const DSH_HOME = process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
  ? resolve(process.env.DSH_HOME)
  : join(homedir(), '.dsh')

/**
 * Where `config.json`, `state.json` and `plugin.log` live.
 *
 * Precedence: `$DSH_FEISHU_DATA`, then `$DSH_HOME/feishu-bot`. A pre-package
 * installation kept them in `$DSH_HOME/.feishu-bot`; that directory is adopted
 * ONCE by copying its files over, because a renamed data directory must not
 * look to the bot like "no chats yet" — that reads as an empty state file and
 * the next save would make it true.
 */
function resolveDataDir() {
  const explicit = process.env.DSH_FEISHU_DATA
  if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit.trim())
  const current = join(DSH_HOME, 'feishu-bot')
  if (existsSync(current)) return current
  const legacy = join(DSH_HOME, '.feishu-bot')
  if (existsSync(legacy)) {
    try {
      mkdirSync(current, { recursive: true })
      for (const name of ['config.json', 'state.json', 'plugin.log']) {
        const from = join(legacy, name)
        if (existsSync(from)) copyFileSync(from, join(current, name))
      }
      process.stderr.write('[feishu-bot] moved state from ' + legacy + ' to ' + current + '\n')
    } catch (error) {
      process.stderr.write('[feishu-bot] could not move state from ' + legacy + ': ' + String(error) + '\n')
      return legacy
    }
  }
  return current
}

const DIR = resolveDataDir()
mkdirSync(DIR, { recursive: true })
const CONFIG_PATH = join(DIR, 'config.json')
const STATE_PATH = join(DIR, 'state.json')
const LOG_PATH = join(DIR, 'plugin.log')
const BRIDGE_PATH = join(PACKAGE_DIR, 'bridge.mjs')
const API = 'https://open.feishu.cn/open-apis'
const ROUTE = '/feishu/events'
/** DSH keeps its session logs here; `/ws` reads their mtimes to find the newest. */
const SESSIONS_GLOB = join(DSH_HOME, 'sessions')
const LOG_ROTATE_BYTES = 1048576
/** How many recent lines a rotation carries over instead of losing them. */
const LOG_KEEP_LINES = 200
/** How many past sessions one chat keeps switchable via `/s`. */
const MAX_REMEMBERED_SESSIONS = 20

/** A slash line whose first token could name a human command (not a filesystem path). */
const COMMAND_LINE = /^\/[A-Za-z][A-Za-z0-9_-]*$/

/** How much of a question's `detail` (a plan review puts the whole plan there) reaches the card. */
const DETAIL_MAX_CHARS = 8000

/**
 * How long a chat waits, after the turn looks finished, for a follow-on turn.
 *
 * A background subagent that reports back wakes its parent into a NEW turn;
 * delivering at the first idle posts the interim sentence and loses the answer.
 * This is the window that catches the notice already in flight — a live child
 * is waited for separately, however long it takes.
 */
const SETTLE_MS = 15000

const DEFAULTS = {
  appId: '',
  appSecret: '',
  verificationToken: '',
  encryptKey: '',
  transport: 'ws',
  // The directory a chat works in unless it overrides it with `/ws`. The
  // harness's own working directory is the only guess that means anything for
  // an arbitrary installation; a personal path would be wrong for everyone else.
  workspacePath: process.cwd(),
  agentPreset: 'standard',
  // Empty means "leave the deployment's own permission policy alone" — the
  // plugin drives real agent turns, so it must not silently widen or narrow
  // what the operator configured. See README "Security".
  permissionPreset: '',
  groupRequireMention: true,
  replyStyle: 'card',
  acknowledge: true,
  useReply: true,
  cardHeader: true,
  replyMetrics: true,
  maxReplyChars: 6000,
  // Per-turn ceiling. A stuck turn is silent from the chat's point of view, so
  // this is the only thing that ends one; 15 minutes of dead air is not a
  // usable chat experience, 5 is enough for a long tool chain.
  timeoutMs: 300000,
  allowedChatIds: [],
  blockedUserIds: [],
}

export const name = 'feishu-bot'
export const inject = ['timer', 'tools']

export async function apply(ctx) {
    /* ------------------------------------------------------------------ *
     * logging: an in-memory ring for the tool plus an append-only tail file
     * ------------------------------------------------------------------ */
    const logLines = []
    const pendingLog = []
    function j(value) {
      try {
        return JSON.stringify(value)
      } catch (error) {
        return String(value)
      }
    }
    function log() {
      const parts = []
      for (let i = 0; i < arguments.length; i += 1) {
        const value = arguments[i]
        parts.push(typeof value === 'string' ? value : j(value))
      }
      const text = parts.join(' ')
      const stamped = new Date().toISOString() + ' ' + text
      logLines.push(stamped)
      if (logLines.length > 400) logLines.splice(0, logLines.length - 400)
      pendingLog.push(stamped)
      if (pendingLog.length > 400) pendingLog.splice(0, pendingLog.length - 400)
      console.log('[feishu-bot]', text)
    }

    /* ------------------------------------------------------------------ *
     * services
     * ------------------------------------------------------------------ */
    const shell = ctx.get('shell')
    const webServer = ctx.get('webServer')
    if (shell === undefined) {
      console.error('[feishu-bot] the shell service is unavailable; cannot run curl or the bridge')
      return
    }
    function svc(name) {
      const found = ctx.get(name)
      if (found === undefined) throw new Error('service "' + name + '" is not mounted in this deployment')
      return found
    }
    function quote(value) {
      return "'" + String(value).split("'").join("'\\''") + "'"
    }

    /**
     * Run one bash command through the shell service; never throws on a nonzero exit.
     * `stdoutMaxBytes` matters: bash-local caps stdout at 64 KB by default and
     * truncates silently apart from the `truncated` flag, so any read that can
     * exceed it must ask for more and check.
     */
    async function sh(command, stdin, timeoutMs, stdoutMaxBytes) {
      const spec = shell.resolve({
        command: command,
        workdir: DIR,
        timeoutMs: timeoutMs === undefined ? 60000 : timeoutMs,
        ...(stdin === undefined ? {} : { stdin: stdin }),
        ...(stdoutMaxBytes === undefined ? {} : { stdoutMaxBytes: stdoutMaxBytes }),
      })
      const result = await shell.run(spec)
      return {
        code: result.exitCode,
        stdout: result.stdout === undefined ? '' : result.stdout.text,
        stderr: result.stderr === undefined ? '' : result.stderr.text,
        timedOut: result.timedOut === true,
        truncated: result.stdout === undefined ? false : result.stdout.truncated === true,
      }
    }

    /** Largest read this plugin will accept from one command. */
    const READ_MAX_BYTES = 4194304

    /**
     * Read one file as text. `undefined` means "there is no such file" and
     * NOTHING else; every other failure throws.
     *
     * The distinction is the whole point, and it is not cosmetic. A caller that
     * cannot tell "state.json does not exist yet" from "state.json could not be
     * read this time" starts from an empty chat map, works fine, and then
     * persists that empty map over the real one — every chat binding, session
     * id and workspace override gone from one transient timeout. The same
     * ambiguity on config.json is worse: the defaults carry no credentials, so
     * the auto-generated bridgeToken write would erase appId, appSecret,
     * encryptKey and every other operator choice.
     *
     * A truncated read is refused for the same reason it always was: parsing
     * the first 4 MB of a longer file would silently half-apply it.
     */
    async function readFileText(path) {
      // `test -f ... || exit 3` is what makes "absent" a separate answer from
      // "unreadable": 3 is this function's own sentinel and never comes from cat.
      const result = await sh('test -f ' + quote(path) + ' || exit 3; cat ' + quote(path) + ' 2>/dev/null', undefined, 60000, READ_MAX_BYTES)
      if (result.code === 3) return undefined
      if (result.truncated) {
        throw new Error('refusing a partial read of ' + path + ': it exceeds ' + READ_MAX_BYTES + ' bytes')
      }
      if (result.timedOut) throw new Error('timed out reading ' + path)
      if (result.code !== 0) {
        throw new Error('cannot read ' + path + ' (exit ' + result.code + '): ' + (result.stderr === undefined ? '' : result.stderr.trim().slice(0, 200)))
      }
      return result.stdout
    }

    async function writeFileText(path, content) {
      const result = await sh('umask 077; cat > ' + quote(path), content)
      if (result.code !== 0) throw new Error('failed to write ' + path + ': ' + (result.stderr || result.stdout))
    }

    /**
     * Append the not-yet-written log lines, rotating the file first when it
     * grew too large.
     *
     * Three things this must not do, each of which it used to:
     *
     *  - Ask the filesystem how big the file is. That was a `wc` PROCESS per
     *    flush, and the bot flushes at least twice per answered message plus
     *    once per 3-second tick. The size is tracked in memory instead, seeded
     *    by one `wc` per process.
     *  - Empty the file to rotate it. The last few hundred lines are the ones a
     *    diagnosis reads, and a chatty bridge could push the log past the limit
     *    in about a minute — so truncating meant the evidence was destroyed
     *    continuously. Rotation now keeps the recent tail.
     *  - Drop the batch before it is written. A failed append keeps the lines
     *    pending (the ring in log() still bounds them) so the next flush retries.
     */
    let logBytes = -1
    let flushing = false
    async function flushLog() {
      if (flushing) return
      if (pendingLog.length === 0) return
      flushing = true
      const batch = pendingLog.join('\n') + '\n'
      try {
        if (logBytes < 0) {
          const size = await sh('wc -c < ' + quote(LOG_PATH) + ' 2>/dev/null')
          const seen = size.code === 0 ? Number(size.stdout.trim()) : NaN
          logBytes = isFinite(seen) && seen > 0 ? seen : 0
        }
        if (logBytes + batch.length > LOG_ROTATE_BYTES) {
          const body = '--- rotated at ' + new Date().toISOString() + ' ---\n' + logLines.slice(-LOG_KEEP_LINES).join('\n') + '\n'
          await writeFileText(LOG_PATH, body)
          logBytes = body.length
        }
        const append = await sh('umask 077; cat >> ' + quote(LOG_PATH), batch)
        if (append.code !== 0) {
          // Keep the lines: they are already out of pendingLog's hands only if
          // this succeeds, and the ring in log() bounds how long they can wait.
          throw new Error('log append failed (exit ' + append.code + '): ' + append.stderr.trim().slice(0, 200))
        }
        logBytes += batch.length
        pendingLog.length = 0
      } catch (error) {
        /* diagnostics must never break the bot; the batch stays pending */
      } finally {
        flushing = false
      }
    }

    /**
     * The typert gateway validates `args` with a host-realm plain-object check
     * (`prototype === null || prototype === Object.prototype`). An object
     * literal here carries THIS vm realm's Object.prototype, so it is rejected
     * as "not a plain object"; a null-prototype bag satisfies the same check
     * using only standard ECMAScript.
     */
    function callArgs(entries) {
      const bag = Object.create(null)
      const keys = Object.keys(entries)
      for (let i = 0; i < keys.length; i += 1) bag[keys[i]] = entries[keys[i]]
      return bag
    }

    /* ------------------------------------------------------------------ *
     * configuration + durable chat state
     * ------------------------------------------------------------------ */
    let config = Object.assign({}, DEFAULTS)

    function randomToken() {
      let out = ''
      for (let i = 0; i < 4; i += 1) out += Math.random().toString(36).slice(2, 12)
      return out
    }

    function redact(value) {
      if (typeof value !== 'string' || value === '') return ''
      if (value.length <= 8) return '***'
      return value.slice(0, 4) + '…' + value.slice(-4)
    }

    function credentialsPresent() {
      return typeof config.appId === 'string' && config.appId !== '' && typeof config.appSecret === 'string' && config.appSecret !== ''
    }

    function describeError(error) {
      if (error === undefined || error === null) return 'unknown error'
      const message = error.message === undefined ? String(error) : String(error.message)
      return error.name === undefined ? message : error.name + ': ' + message
    }

    async function loadConfig() {
      let raw
      try {
        raw = await readFileText(CONFIG_PATH)
      } catch (error) {
        // A config that EXISTS but could not be read. Running on the defaults
        // in memory is fine; writing them back is not, so `configFileKnown`
        // stops saveConfig() from erasing the operator's file.
        configFileKnown = false
        config = Object.assign({}, DEFAULTS)
        config.bridgeToken = randomToken()
        log('config.json could not be read (' + describeError(error) + '); using defaults IN MEMORY ONLY and refusing to write the file back')
        return
      }
      configFileKnown = true
      let parsed = {}
      if (raw !== undefined && raw.trim() !== '') {
        try {
          parsed = JSON.parse(raw)
        } catch (error) {
          log('config.json is not valid JSON, using defaults: ' + describeError(error))
        }
      }
      config = Object.assign({}, DEFAULTS, parsed === null || typeof parsed !== 'object' ? {} : parsed)
      if (typeof config.bridgeToken !== 'string' || config.bridgeToken === '') {
        config.bridgeToken = randomToken()
        await saveConfig()
      }
      if (!Array.isArray(config.allowedChatIds)) config.allowedChatIds = []
      if (!Array.isArray(config.blockedUserIds)) config.blockedUserIds = []
      if (config.encryptKey === undefined || config.encryptKey === null) config.encryptKey = ''
      if (config.verificationToken === undefined || config.verificationToken === null) config.verificationToken = ''
    }

    /** False once a read of config.json failed, until one succeeds again. */
    let configFileKnown = true

    async function saveConfig() {
      if (!configFileKnown) {
        log('config save refused: ' + CONFIG_PATH + ' was never read successfully, so writing would replace it with defaults')
        return false
      }
      await writeFileText(CONFIG_PATH, JSON.stringify(explicitConfig(), null, 2) + '\n')
      return true
    }

    /**
     * The values worth writing back to config.json: only those that actually
     * differ from the shipped defaults, i.e. the operator's real choices.
     *
     * Writing the MERGED config instead — which is what this used to do —
     * freezes today's defaults into the file forever, so a later change to
     * DEFAULTS can never take effect on an existing installation. That is not
     * hypothetical: a 15-minute `timeoutMs` default got snapshotted this way
     * and quietly overrode the 5-minute replacement.
     */
    function explicitConfig() {
      const out = {}
      const keys = Object.keys(config)
      for (let i = 0; i < keys.length; i += 1) {
        const key = keys[i]
        if (!sameConfigValue(config[key], DEFAULTS[key])) out[key] = config[key]
      }
      return out
    }

    /** Scalar equality, plus array comparison for the two list fields. */
    function sameConfigValue(a, b) {
      if (a === b) return true
      if (Array.isArray(a) || Array.isArray(b)) return j(a) === j(b)
      return false
    }

    let chats = {}
    /**
     * True once this instance's fiber was disposed — the row was reloaded, or
     * the harness is shutting down.
     *
     * The teardown effect cannot stop the turn already inside `enqueue`, and
     * that turn ends with `saveState()`, which writes the WHOLE chat map. If the
     * live instance has since written a newer one — a chat it met after the
     * reload, a `/new` or `/ws` swap — a stale whole-file write erases it, and
     * the next restart loads the older map. So the dead instance stops writing.
     */
    let disposed = false
    /**
     * Whether state.json has been read successfully at least once.
     *
     * It gates the WRITE, not the read: a state file that could not be read is
     * never replaced by the in-memory map, because that map is empty and would
     * take every chat binding with it. The write is retried after a fresh read
     * instead, so one bad `cat` costs a delayed save rather than the file.
     */
    let stateFileKnown = false

    async function loadState() {
      let raw
      try {
        raw = await readFileText(STATE_PATH)
      } catch (error) {
        stateFileKnown = false
        log('state.json could not be read (' + describeError(error) + '); keeping the current chat map and refusing to overwrite the file')
        return false
      }
      stateFileKnown = true
      if (raw === undefined || raw.trim() === '') return true
      try {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && parsed.chats && typeof parsed.chats === 'object') chats = parsed.chats
      } catch (error) {
        log('state.json unreadable, starting fresh: ' + describeError(error))
      }
      return true
    }

    async function saveState() {
      if (disposed === true) {
        log('state save skipped: this instance was disposed (a reload already owns ' + STATE_PATH + ')')
        return
      }
      if (!stateFileKnown) {
        // Try the read again before giving up on this save: a transient failure
        // must not turn into a permanent inability to remember anything.
        if (await loadState() === false) {
          log('state save skipped: ' + STATE_PATH + ' is still unreadable')
          return
        }
      }
      try {
        await writeFileText(STATE_PATH, JSON.stringify({ chats: chats, savedAt: Date.now() }, null, 2) + '\n')
      } catch (error) {
        log('state save failed: ' + describeError(error))
      }
    }

    /* ------------------------------------------------------------------ *
     * Feishu Open API over curl (the sandbox has no fetch and no crypto)
     * ------------------------------------------------------------------ */
    let tokenCache = null
    let botInfo = null

    async function apiCall(method, path, body, token) {
      const argv = ['curl', '-sS', '-X', method, quote(API + path)]
      if (token !== undefined) argv.push('-H', quote('Authorization: Bearer ' + token))
      argv.push('-H', quote('Content-Type: application/json; charset=utf-8'))
      argv.push('--max-time', '45')
      if (body !== undefined) argv.push('--data-binary', '@-')
      const result = await sh(argv.join(' '), body === undefined ? undefined : JSON.stringify(body), 90000)
      if (result.code !== 0) {
        throw new Error('curl exit ' + result.code + ': ' + (result.stderr || result.stdout).slice(0, 300))
      }
      let parsed
      try {
        parsed = JSON.parse(result.stdout)
      } catch (error) {
        throw new Error('Feishu returned non-JSON: ' + result.stdout.slice(0, 300))
      }
      return parsed
    }

    async function tenantToken() {
      if (tokenCache !== null && Date.now() < tokenCache.expiresAt) return tokenCache.token
      if (!credentialsPresent()) throw new Error('appId/appSecret are not configured in ' + CONFIG_PATH)
      const response = await apiCall('POST', '/auth/v3/tenant_access_token/internal', {
        app_id: config.appId,
        app_secret: config.appSecret,
      })
      if (response.code !== 0 || typeof response.tenant_access_token !== 'string') {
        throw new Error('tenant_access_token failed: code=' + response.code + ' msg=' + response.msg)
      }
      const ttl = typeof response.expire === 'number' ? response.expire : 7200
      tokenCache = {
        token: response.tenant_access_token,
        expiresAt: Date.now() + Math.max(60, ttl - 300) * 1000,
      }
      return tokenCache.token
    }

    /** Self-test the credentials and learn the bot identity used for @-mention matching. */
    async function refreshBotInfo() {
      if (!credentialsPresent()) {
        log('credentials not configured yet — edit ' + CONFIG_PATH + ' then use the feishu_bot tool with action "restart", or restart the plugin')
        return false
      }
      try {
        const token = await tenantToken()
        const response = await apiCall('GET', '/bot/v3/info', undefined, token)
        if (response.code === 0 && response.bot) {
          botInfo = {
            openId: response.bot.open_id === undefined ? '' : response.bot.open_id,
            name: response.bot.app_name === undefined ? '' : response.bot.app_name,
          }
          log('credentials OK — bot "' + botInfo.name + '" (' + botInfo.openId + ')')
          return true
        }
        log('bot/v3/info failed: ' + j(response))
      } catch (error) {
        log('credential check failed: ' + describeError(error))
      }
      return false
    }

    /* ------------------------------------------------------------------ *
     * reply metrics
     *
     * Every provider request reports exact token usage, and the deployment's
     * own projections read it the same way: a step's prompt is its uncached
     * input plus its cache reads and writes (see the token-meter package's
     * `contextPressure` projection). Those samples ride on `assistant/message`
     * events and the routed model's capacity on `request/context`, so one
     * listener keeps a last-known record per session and any reply can render
     * the line without touching the log again. Nothing here is estimated.
     * ------------------------------------------------------------------ */
    const sessionUsage = new Map()

    function emptyUsage() {
      return {
        contextWindow: 0,
        promptTokens: 0,
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        cacheReported: false,
      }
    }

    function tokenCount(value) {
      return typeof value === 'number' && isFinite(value) && value > 0 ? Math.round(value) : 0
    }

    /** Fold one durable event into the session's last-known usage record. */
    function recordUsage(sessionId, event) {
      const key = String(sessionId)
      const record = sessionUsage.get(key) === undefined ? emptyUsage() : sessionUsage.get(key)

      if (event.type === 'request/context') {
        const window = event.data === undefined ? undefined : event.data.contextWindow
        if (typeof window !== 'number' || window <= 0) return
        record.contextWindow = window
        sessionUsage.set(key, record)
        return
      }
      if (event.type !== 'assistant/message') return
      const usage = event.data === undefined ? undefined : event.data.usage
      if (usage === undefined || usage === null) return

      const uncached = tokenCount(usage.inputTokens)
      const read = tokenCount(usage.cacheReadTokens)
      const write = tokenCount(usage.cacheWriteTokens)
      record.uncachedInputTokens = uncached
      record.cacheReadTokens = read
      record.cacheWriteTokens = write
      record.outputTokens = tokenCount(usage.outputTokens)
      record.promptTokens = uncached + read + write
      // Absent buckets mean the provider does not report caching at all, which
      // is not the same claim as a zero hit rate.
      if (usage.cacheReadTokens !== undefined || usage.cacheWriteTokens !== undefined) record.cacheReported = true
      sessionUsage.set(key, record)
    }

    /**
     * A resumed session already carries usage in its durable log, so read it
     * once per session: without this the first reply after a plugin restart
     * would be metrics-blind until a request of its own reported usage.
     */
    function seedUsage(session) {
      const key = String(session.id)
      if (sessionUsage.has(key)) return
      try {
        const events = session.snapshotEvents(0)
        for (let i = 0; i < events.length; i += 1) recordUsage(session.id, events[i])
      } catch (error) {
        log('usage seed failed: ' + describeError(error))
      }
    }

    function formatTokens(value) {
      const scaled = function (candidate) {
        return candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)
      }
      if (value < 1000) return String(value)
      if (value < 1000000) return scaled(value / 1000) + 'k'
      return scaled(value / 1000000) + 'M'
    }

    function formatDuration(ms) {
      if (ms < 1000) return ms + 'ms'
      if (ms < 60000) return Math.round(ms / 100) / 10 + 's'
      const minutes = Math.floor(ms / 60000)
      const seconds = Math.round((ms % 60000) / 1000)
      return minutes + 'm' + (seconds < 10 ? '0' : '') + seconds + 's'
    }

    /**
     * One grey line under a reply: how long it took, how full the context is,
     * and how much of that prompt the provider served from cache.
     * @returns '' when metrics are switched off, the line otherwise.
     */
    function metricsLine(sessionId, startedAt) {
      if (config.replyMetrics === false) return ''
      const parts = ['⏱ ' + formatDuration(Math.max(0, Date.now() - startedAt))]
      const record = sessionUsage.get(String(sessionId))
      if (record === undefined || record.promptTokens <= 0) return parts.join(' · ')

      let context = '📊 上下文 ' + formatTokens(record.promptTokens)
      if (record.contextWindow > 0) {
        const percent = Math.min(100, Math.round((record.promptTokens / record.contextWindow) * 100))
        context += '/' + formatTokens(record.contextWindow) + ' (' + percent + '%)'
      }
      parts.push(context)
      if (record.cacheReported) {
        parts.push('⚡ 缓存命中 ' + Math.round((record.cacheReadTokens / record.promptTokens) * 1000) / 10 + '%')
      }
      return parts.join(' · ')
    }

    /* ------------------------------------------------------------------ *
     * reply rendering: markdown → card elements
     *
     * Feishu's markdown component renders headings, lists, quotes and code
     * blocks but NOT tables: a pipe table arrives as raw text (seen on a live
     * reply). Card JSON has a first-class `table` component, so tables are
     * lifted out of the markdown and rebuilt as that component while the
     * surrounding prose stays markdown. A `table` must be a direct child of
     * `elements`, which is exactly where this puts it.
     * ------------------------------------------------------------------ */
    const MAX_TABLE_ELEMENTS = 5 // platform limit per card
    const FENCE_LINE = /^\s{0,3}(`{3,}|~{3,})/
    const TABLE_SEPARATOR_CELL = /^:?-+:?$/
    const LEADING_RULE = /^(?:-{3,}|\*{3,}|_{3,})\n+/

    /** Split one markdown table row on unescaped pipes; `\|` becomes a literal pipe. */
    function splitTableRow(line) {
      let body = String(line).trim()
      if (body.charAt(0) === '|') body = body.slice(1)
      if (body.charAt(body.length - 1) === '|') body = body.slice(0, -1)
      const cells = []
      let current = ''
      for (let i = 0; i < body.length; i += 1) {
        const ch = body.charAt(i)
        if (ch === '\\' && body.charAt(i + 1) === '|') {
          current += '|'
          i += 1
          continue
        }
        if (ch === '|') {
          cells.push(current.trim())
          current = ''
          continue
        }
        current += ch
      }
      cells.push(current.trim())
      return cells
    }

    function isTableSeparator(cells) {
      if (cells.length === 0) return false
      for (let i = 0; i < cells.length; i += 1) {
        if (!TABLE_SEPARATOR_CELL.test(cells[i])) return false
      }
      return true
    }

    /**
     * Read a GitHub-style table starting at `lines[start]`, or undefined when
     * this is ordinary prose. The separator row is what makes it a table, so
     * prose with a stray pipe is never swallowed.
     */
    function readTableAt(lines, start) {
      if (start + 1 >= lines.length) return undefined
      if (lines[start].indexOf('|') === -1) return undefined
      const header = splitTableRow(lines[start])
      if (header.length < 2) return undefined
      const separator = splitTableRow(lines[start + 1])
      if (separator.length !== header.length || !isTableSeparator(separator)) return undefined

      const align = []
      for (let i = 0; i < separator.length; i += 1) {
        const cell = separator[i]
        const left = cell.charAt(0) === ':'
        const right = cell.charAt(cell.length - 1) === ':'
        align.push(left && right ? 'center' : right ? 'right' : 'left')
      }

      const rows = []
      let index = start + 2
      while (index < lines.length) {
        const line = lines[index]
        if (line.trim() === '' || line.indexOf('|') === -1 || FENCE_LINE.test(line)) break
        rows.push(splitTableRow(line))
        index += 1
      }
      if (rows.length === 0) return undefined
      return { table: { header: header, align: align, rows: rows }, next: index }
    }

    /**
     * Markdown → ordered segments. Text is grouped so a run of prose becomes a
     * single markdown element; each table becomes its own element. Blank-line
     * runs collapse outside code fences, where they are content.
     */
    function segmentMarkdown(markdown) {
      const lines = String(markdown).split('\n')
      const segments = []
      let buffer = []
      let fence = null

      function flush() {
        const text = buffer.join('\n')
        buffer = []
        if (text.trim() !== '') segments.push({ kind: 'text', text: text })
      }

      let index = 0
      while (index < lines.length) {
        const line = lines[index].replace(/\s+$/, '')
        const fenceMatch = FENCE_LINE.exec(line)
        if (fenceMatch !== null) {
          const marker = fenceMatch[1].charAt(0)
          fence = fence === null ? marker : fence === marker ? null : fence
          buffer.push(line)
          index += 1
          continue
        }
        if (fence === null && line.trim() === '' && buffer.length > 0 && buffer[buffer.length - 1].trim() === '') {
          index += 1
          continue
        }
        if (fence === null) {
          const found = readTableAt(lines, index)
          if (found !== undefined) {
            flush()
            segments.push({ kind: 'table', table: found.table })
            index = found.next
            continue
          }
        }
        buffer.push(line)
        index += 1
      }
      flush()
      return segments
    }

    /** Terminal width of a string: CJK and full-width forms occupy two columns. */
    function displayWidth(text) {
      const value = String(text)
      let width = 0
      for (let i = 0; i < value.length; i += 1) {
        const code = value.charCodeAt(i)
        const wide =
          (code >= 0x1100 && code <= 0x115f) ||
          (code >= 0x2e80 && code <= 0xa4cf) ||
          (code >= 0xac00 && code <= 0xd7a3) ||
          (code >= 0xf900 && code <= 0xfaff) ||
          (code >= 0xfe30 && code <= 0xfe6f) ||
          (code >= 0xff00 && code <= 0xff60) ||
          (code >= 0xffe0 && code <= 0xffe6)
        width += wide ? 2 : 1
      }
      return width
    }

    /**
     * Cell text for the table component. `lark_md` gives bold and links but no
     * inline code, so backticks are unwrapped instead of shown literally, and a
     * cell has to stay on one line.
     */
    function tableCellText(value) {
      return String(value).split('`').join('').replace(/\s+/g, ' ').trim()
    }

    /** Plain text with markdown markers removed; used for measuring only. */
    function measurableText(value) {
      return tableCellText(value)
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .split('**').join('')
        .split('__').join('')
        .split('~~').join('')
    }

    /**
     * Column widths as whole percentages, proportional to the widest cell in
     * each column. Past six columns `auto` is better than squeezing every
     * column into an equal-ish share.
     */
    function columnWidths(table) {
      const columns = table.header.length
      if (columns > 6) return undefined
      const weights = []
      for (let c = 0; c < columns; c += 1) {
        let widest = displayWidth(measurableText(table.header[c])) + 2
        for (let r = 0; r < table.rows.length; r += 1) {
          const cell = table.rows[r][c]
          const width = displayWidth(measurableText(cell === undefined ? '' : cell))
          if (width > widest) widest = width
        }
        weights.push(Math.max(4, Math.min(widest, 60)))
      }
      let total = 0
      for (let i = 0; i < weights.length; i += 1) total += weights[i]
      const floor = columns <= 3 ? 12 : 10
      const shares = []
      let sum = 0
      for (let i = 0; i < weights.length; i += 1) {
        const share = Math.max(floor, Math.round((weights[i] / total) * 100))
        shares.push(share)
        sum += share
      }
      let widestIndex = 0
      let accumulated = 0
      for (let i = 0; i < shares.length; i += 1) {
        shares[i] = Math.max(1, Math.round((shares[i] * 100) / sum))
        if (shares[i] > shares[widestIndex]) widestIndex = i
        accumulated += shares[i]
      }
      shares[widestIndex] = Math.max(1, shares[widestIndex] + (100 - accumulated))
      return shares
    }

    /** One markdown table → one card `table` element. */
    function tableElement(table) {
      const count = table.header.length
      const widths = columnWidths(table)
      const columns = []
      for (let c = 0; c < count; c += 1) {
        columns.push({
          name: 'c' + c,
          display_name: tableCellText(table.header[c]),
          data_type: 'lark_md',
          width: widths === undefined ? 'auto' : widths[c] + '%',
          horizontal_align: table.align[c] === 'right' ? 'right' : 'left',
          vertical_align: 'top',
        })
      }
      const rows = []
      let tallest = 0
      for (let r = 0; r < table.rows.length; r += 1) {
        const row = {}
        for (let c = 0; c < count; c += 1) {
          const text = tableCellText(table.rows[r][c] === undefined ? '' : table.rows[r][c])
          if (text.length > tallest) tallest = text.length
          row['c' + c] = text
        }
        rows.push(row)
      }
      return {
        tag: 'table',
        page_size: 10,
        row_height: tallest > 20 ? 'high' : tallest > 8 ? 'middle' : 'low',
        freeze_first_column: count >= 4,
        header_style: { text_align: 'left', text_size: 'normal', background_style: 'grey', text_color: 'grey', bold: true, lines: 1 },
        columns: columns,
        rows: rows,
      }
    }

    function padTo(text, width) {
      let value = String(text)
      if (displayWidth(value) > width) {
        while (value.length > 1 && displayWidth(value) > width - 1) value = value.slice(0, -1)
        value += '…'
      }
      let padding = width - displayWidth(value)
      while (padding > 0) {
        value += ' '
        padding -= 1
      }
      return value
    }

    /**
     * Fallback shape for a table the card cannot carry — aligned monospace
     * text in a code block, so the content still reads as a grid.
     */
    function renderTableAsText(table) {
      const count = table.header.length
      const widths = []
      for (let c = 0; c < count; c += 1) {
        let widest = displayWidth(measurableText(table.header[c]))
        for (let r = 0; r < table.rows.length; r += 1) {
          const cell = table.rows[r][c]
          const width = displayWidth(measurableText(cell === undefined ? '' : cell))
          if (width > widest) widest = width
        }
        widths.push(Math.min(Math.max(widest, 3), 36))
      }
      function line(cells) {
        let out = '|'
        for (let c = 0; c < count; c += 1) {
          out += ' ' + padTo(measurableText(cells[c] === undefined ? '' : cells[c]), widths[c]) + ' |'
        }
        return out
      }
      let rule = '|'
      for (let c = 0; c < count; c += 1) {
        let dashes = ''
        while (dashes.length < widths[c]) dashes += '-'
        rule += ' ' + dashes + ' |'
      }
      const lines = [line(table.header), rule]
      for (let r = 0; r < table.rows.length; r += 1) lines.push(line(table.rows[r]))
      return lines.join('\n')
    }

    /** Trim the wrappers agents like to add: blank edges and a leading rule. */
    function normalizeReply(text) {
      let out = String(text).split('\r\n').join('\n').split('\r').join('\n')
      out = out.replace(/^\s+/, '').replace(/\s+$/, '')
      out = out.replace(LEADING_RULE, '')
      return out.replace(/^\s+/, '').replace(/\s+$/, '')
    }

    /** Who is answering, and in which workspace. */
    function cardHeader(entry) {
      if (config.cardHeader === false) return undefined
      const name = botInfo !== null && typeof botInfo.name === 'string' && botInfo.name !== '' ? botInfo.name : 'DSH 飞书助手'
      const header = { template: 'blue', title: { tag: 'plain_text', content: '🤖 ' + name } }
      const label = entry === undefined ? '' : baseName(workspacePathFor(entry))
      if (label !== '') header.subtitle = { tag: 'plain_text', content: '📁 ' + label }
      return header
    }

    /** Markdown → the card element list. `options.tables === false` flattens tables. */
    function cardBody(markdown, entry, options) {
      const withTables = options === undefined || options.tables !== false
      const segments = segmentMarkdown(markdown)
      const elements = []
      let placed = 0
      for (let i = 0; i < segments.length; i += 1) {
        const segment = segments[i]
        if (segment.kind !== 'table') {
          elements.push({ tag: 'markdown', content: segment.text })
          continue
        }
        // A card carries at most five table components; the rest degrade to
        // aligned text rather than silently disappearing.
        if (withTables && placed < MAX_TABLE_ELEMENTS) {
          placed += 1
          elements.push(tableElement(segment.table))
          continue
        }
        elements.push({ tag: 'markdown', content: '```\n' + renderTableAsText(segment.table) + '\n```' })
      }
      if (elements.length === 0) elements.push({ tag: 'markdown', content: '（没有可展示的内容）' })
      // The metrics line is a `note`: Feishu's own component for the small grey
      // footnote under a card, so it never competes with the answer's markdown.
      if (options !== undefined && typeof options.footer === 'string' && options.footer !== '') {
        elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: options.footer }] })
      }
      const card = { config: { wide_screen_mode: true, update_multi: true }, elements: elements }
      const header = cardHeader(entry)
      if (header !== undefined) card.header = header
      return card
    }

    function cardJson(markdown, entry, options) {
      return JSON.stringify(cardBody(markdown, entry, options))
    }

    function textJson(text) {
      return JSON.stringify({ text: text })
    }

    async function postMessage(chatId, msgType, content, replyToMessageId) {
      const token = await tenantToken()
      if (typeof replyToMessageId === 'string' && replyToMessageId !== '') {
        return apiCall('POST', '/im/v1/messages/' + encodeURIComponent(replyToMessageId) + '/reply', {
          msg_type: msgType,
          content: content,
        }, token)
      }
      return apiCall('POST', '/im/v1/messages?receive_id_type=chat_id', {
        receive_id: chatId,
        msg_type: msgType,
        content: content,
        uuid: newMessageId().slice(0, 50),
      }, token)
    }

    /**
     * Run one delivery attempt, turning a THROW into a failed response.
     *
     * `apiCall` throws when curl itself fails — no network, DNS, or the 45s
     * timeout — which is a different thing from Feishu answering with a
     * non-zero code. Every fallback below is chosen by looking at the response,
     * so a throw used to skip the remaining rungs entirely: a transport blip on
     * the first card attempt threw away a finished answer that a plain text
     * message would have delivered.
     */
    async function attempt(work) {
      try {
        return await work()
      } catch (error) {
        return { code: -1, msg: describeError(error) }
      }
    }

    /**
     * Send, retrying once without the reply target. Quoting a message that was
     * recalled or that belongs to another chat must not cost the user an answer.
     */
    async function send(chatId, msgType, content, replyToMessageId) {
      const first = await attempt(function () {
        return postMessage(chatId, msgType, content, replyToMessageId)
      })
      if (first.code === 0) return first
      if (typeof replyToMessageId !== 'string' || replyToMessageId === '') return first
      log('reply to ' + replyToMessageId + ' failed (code=' + first.code + '), retrying as a plain message')
      return attempt(function () {
        return postMessage(chatId, msgType, content, undefined)
      })
    }

    /** Feishu's ceiling for a file message. */
    const FILE_MAX_BYTES = 30 * 1024 * 1024

    /**
     * Upload one local file and deliver it as a Feishu FILE message.
     *
     * A task that writes a document should be able to hand over the document,
     * not a summary of it. Two API calls: the upload is multipart, which
     * `apiCall` cannot express, so it goes through curl; the delivery is an
     * ordinary message whose content is the returned `file_key`.
     *
     * `file_type` is Feishu's own short list (opus/mp4/pdf/doc/xls/ppt/stream)
     * and `stream` is the catch-all the others do not cover — a Markdown
     * document lands there.
     *
     * @returns { ok, summary, detail? } for the tool.
     */
    async function sendFileToChat(chatId, path) {
      const size = await sh('test -f ' + quote(path) + ' && wc -c < ' + quote(path), undefined, 20000)
      if (size.code !== 0) return { ok: false, summary: '找不到文件：' + path }
      const bytes = Number(String(size.stdout).trim())
      if (!Number.isFinite(bytes) || bytes <= 0) return { ok: false, summary: '文件是空的或读不到大小：' + path }
      if (bytes > FILE_MAX_BYTES) {
        return { ok: false, summary: '文件 ' + bytes + ' 字节，超过飞书文件消息上限 ' + FILE_MAX_BYTES + ' 字节' }
      }
      const name = baseName(path)
      const token = await tenantToken()
      const upload = await sh('curl -s -X POST ' + API + '/im/v1/files'
        + ' -H ' + quote('Authorization: Bearer ' + token)
        + ' -F ' + quote('file_type=stream')
        + ' -F ' + quote('file_name=' + name)
        + ' -F ' + quote('file=@' + path), undefined, 180000)
      let uploaded
      try {
        uploaded = JSON.parse(String(upload.stdout))
      } catch (error) {
        log('file upload returned non-JSON: ' + j(String(upload.stdout).slice(0, 300)) + ' stderr=' + j(String(upload.stderr).slice(0, 200)))
        return { ok: false, summary: '上传文件失败（返回不是 JSON），见 plugin.log' }
      }
      if (uploaded.code !== 0) {
        log('file upload failed: ' + j(uploaded))
        return { ok: false, summary: '上传文件失败 code=' + uploaded.code + ' msg=' + uploaded.msg }
      }
      const fileKey = uploaded.data === undefined ? undefined : uploaded.data.file_key
      if (typeof fileKey !== 'string' || fileKey === '') return { ok: false, summary: '上传成功但没拿到 file_key：' + j(uploaded).slice(0, 200) }
      const sent = await apiCall('POST', '/im/v1/messages?receive_id_type=chat_id', {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      }, token)
      if (sent.code !== 0) {
        log('file message failed: ' + j(sent))
        return { ok: false, summary: '发送文件失败 code=' + sent.code + ' msg=' + sent.msg }
      }
      log('file ' + j(name) + ' (' + bytes + ' bytes) sent to ' + chatId)
      await flushLog()
      return { ok: true, summary: '已发送文件 ' + name + '（' + bytes + ' 字节）' }
    }

    /** Plain-text reply that is always audited, so an operator can see what the bot said. */
    async function sendText(chatId, messageId, body) {
      log('reply ' + j(body.slice(0, 500)))
      const result = await send(chatId, 'text', textJson(body), config.useReply ? messageId : undefined)
      if (result.code !== 0) log('reply send failed: code=' + result.code + ' msg=' + result.msg)
      await flushLog()
      return result
    }

    /**
     * Card-first reply for structured output (help, listings, command
     * results), so a list or table in a command answer renders the same way a
     * model answer does. Falls back to a table-free card, then to plain text:
     * a rendering surprise must never cost the user the content.
     */
    async function replyRich(chatId, messageId, entry, markdown, footer) {
      const clean = normalizeReply(markdown)
      const base = clampReply(clean === '' ? '（没有内容）' : clean)
      const line = typeof footer === 'string' ? footer : ''
      const body = line === '' ? base : base + '\n\n' + line
      const rich = line === '' ? undefined : { footer: line }
      const flat = line === '' ? { tables: false } : { tables: false, footer: line }
      const target = config.useReply ? messageId : undefined
      if (config.replyStyle === 'text') return await sendText(chatId, messageId, body)

      const primary = await send(chatId, 'interactive', cardJson(base, entry, rich), target)
      if (primary.code === 0) {
        log('reply ' + j(base.slice(0, 500)))
        await flushLog()
        return primary
      }
      log('card send failed: ' + j(primary))
      const flattened = await send(chatId, 'interactive', cardJson(base, entry, flat), target)
      if (flattened.code === 0) {
        log('reply ' + j(base.slice(0, 500)) + ' (card-plain)')
        await flushLog()
        return flattened
      }
      log('plain card send failed: ' + j(flattened))
      return await sendText(chatId, messageId, body)
    }

    async function patchCard(messageId, markdown, entry, options) {
      const token = await tenantToken()
      return apiCall('PATCH', '/im/v1/messages/' + encodeURIComponent(messageId), { content: cardJson(markdown, entry, options) }, token)
    }

    async function fetchChatName(chatId) {
      try {
        const token = await tenantToken()
        const response = await apiCall('GET', '/im/v1/chats/' + encodeURIComponent(chatId), undefined, token)
        if (response.code === 0 && response.data && typeof response.data.name === 'string') return response.data.name
      } catch (error) {
        /* name is cosmetic */
      }
      return ''
    }

    /* ------------------------------------------------------------------ *
     * message plumbing
     * ------------------------------------------------------------------ */
    let idSeq = 0
    function newMessageId() {
      idSeq += 1
      return 'feishu-' + Date.now().toString(36) + '-' + idSeq + '-' + Math.random().toString(36).slice(2, 10)
    }

    function blocksToText(content) {
      if (!Array.isArray(content)) return ''
      const parts = []
      for (let i = 0; i < content.length; i += 1) {
        const block = content[i]
        if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      return parts.join('\n').trim()
    }

    /** Last non-empty assistant text appended after `fromSeq` — the turn's answer. */
    function lastAssistantText(session, fromSeq) {
      try {
        const events = session.snapshotEvents(fromSeq)
        for (let i = events.length - 1; i >= 0; i -= 1) {
          const event = events[i]
          if (event.type !== 'assistant/message') continue
          const data = event.data
          const text = data && data.message ? blocksToText(data.message.content) : ''
          if (text !== '') return text
        }
      } catch (error) {
        log('session log scan failed: ' + describeError(error))
      }
      return ''
    }

    /* Live capture keyed by session id; overwritten so the LAST assistant
     * message of the turn wins — the answer, not the intermediate narration.
     * The same listener folds every usage sample into the metrics record and
     * stamps last-activity, which is what tells a WORKING turn apart from a
     * wedged one (see quietFor). */
    const captures = new Map()
    const lastActivity = new Map()
    ctx.on('session/event', (session, event) => {
      if (event === undefined) return
      lastActivity.set(String(session.id), Date.now())
      recordUsage(session.id, event)
      if (event.type !== 'assistant/message') return
      const capture = captures.get(String(session.id))
      if (capture === undefined) return
      const text = blocksToText(event.data && event.data.message ? event.data.message.content : undefined)
      if (text !== '') capture.last = text
    })

    /* ------------------------------------------------------------------ *
     * one DSH Session per Feishu chat
     * ------------------------------------------------------------------ */
    const liveHandles = new Map()
    /**
     * Swaps parked because the chat's own turn was still in flight when they
     * were requested. Disposing an agent from inside its own turn — the `reset`
     * tool called on the chat that is running it — kills the loop that is
     * executing the tool call, so no `tool/result` is ever recorded and the
     * session stays wedged mid-step: `whenIdle()` never resolves again and
     * every later message sits unanswered in the inbox. Each value is the
     * mutation to apply, so `/new`, `/ws` and `/s` all park the same way.
     */
    const deferredSwaps = new Map()

    function sessionIdFor(chatId, generation) {
      const safe = String(chatId).replace(/[^A-Za-z0-9_-]/g, '')
      return 'feishu-' + safe + (generation > 0 ? '-g' + generation : '')
    }

    function chatEntry(chatId, chatType) {
      let entry = chats[chatId]
      if (entry === undefined) {
        entry = { generation: 0, chatType: chatType, createdAt: Date.now() }
        chats[chatId] = entry
      }
      if (chatType !== undefined) entry.chatType = chatType
      entry.lastSeen = Date.now()
      if (typeof entry.sessionId !== 'string' || entry.sessionId === '') {
        entry.sessionId = sessionIdFor(chatId, entry.generation)
      }
      if (!Array.isArray(entry.sessions)) entry.sessions = []
      return entry
    }

    /**
     * Record the session a chat is leaving, so `/s` can offer it again.
     * Only the id is stored: titles are folded fresh at render time, and a
     * session deleted from disk is then visible as unavailable rather than
     * being remembered under a stale label.
     */
    function rememberSession(entry, id) {
      if (typeof id !== 'string' || id === '') return
      if (!Array.isArray(entry.sessions)) entry.sessions = []
      entry.sessions = rememberedSessions(entry).filter(function (saved) {
        return saved !== null && typeof saved === 'object' && saved.id !== id
      })
      entry.sessions.unshift({ id: id, at: Date.now() })
      if (entry.sessions.length > MAX_REMEMBERED_SESSIONS) entry.sessions.length = MAX_REMEMBERED_SESSIONS
    }

    /**
     * The chat's remembered-session list, normalized in place. Entries loaded
     * from state.json can predate this field entirely — the tool path reads
     * `chats[id]` directly, so it never passes through chatEntry's repair.
     */
    function rememberedSessions(entry) {
      if (!Array.isArray(entry.sessions)) entry.sessions = []
      return entry.sessions
    }

    function mountSetup(presetId) {
      return async function (agentCtx) {
        await svc('agentPresets').mount(agentCtx, presetId)
      }
    }

    /* ------------------------------------------------------------------ *
     * DSH native human commands
     *
     * The sandbox has no AbortController (a bare vm realm lacks it and the
     * runner does not inject one), yet commands.execute needs a REAL signal:
     * compact fuses it with AbortSignal.any(). The typert gateway supplies
     * one — its descriptor declares `cancellation: { parameter: 'signal' }`,
     * so omitting the signal makes the gateway append its own never-aborted
     * AbortSignal. The descriptor is `invocation.kind: 'direct'`, so no
     * agent-scoped calling context is required, and the agent travels as the
     * `agentId` wire string, resolved through the live Agent registry.
     * ------------------------------------------------------------------ */
    function gateway() {
      return svc('typertGateway')
    }

    async function listNativeCommands(sessionId) {
      const result = await gateway().invoke({
        namespace: 'commands',
        method: 'list',
        args: callArgs({ agentId: sessionId }),
      })
      return Array.isArray(result) ? result : []
    }

    /** @returns the settled execution, or undefined when the line names no known command. */
    async function executeNativeCommand(sessionId, line) {
      const result = await gateway().invoke({
        namespace: 'commands',
        method: 'execute',
        args: callArgs({ agentId: sessionId, line: line, submittedAttachments: [] }),
      })
      return result === null ? undefined : result
    }

    /**
     * A native command IS a session operation, so a fresh chat simply gets its
     * session now rather than being told to send a throwaway message first.
     * Only a live Agent resolves through the registry, hence the revive.
     */
    async function ensureCommandAgent(entry) {
      const live = svc('agents').get(entry.sessionId)
      if (live !== undefined) return live
      try {
        return await acquireAgent(entry, entry.title === undefined ? entry.sessionId : entry.title)
      } catch (error) {
        log('command agent revive failed: ' + describeError(error))
        return undefined
      }
    }

    async function renderNativeList(entry) {
      const live = svc('agents').get(entry.sessionId)
      if (live === undefined) {
        return ['DSH 原生命令：本会话尚未建立，先随便发一条消息即可使用。']
      }
      try {
        const list = await listNativeCommands(String(live.id))
        const lines = ['DSH 原生命令（' + list.length + '）：']
        for (let i = 0; i < list.length; i += 1) {
          const command = list[i]
          const hint = command.input === undefined ? '' : '  ' + command.input.hint
          lines.push('  /' + command.name + hint + ' — ' + command.description)
        }
        return lines
      } catch (error) {
        return ['DSH 原生命令：读取失败（' + describeError(error) + '）']
      }
    }

    /* ------------------------------------------------------------------ *
     * skills
     *
     * The `skill-filesystem` provider lives in the AGENT PRESET's layer, not
     * the global one, so a bare skills.list() from this plugin would see no
     * project or user roots at all. `standingKeyFor(preset)` supplies exactly
     * the scope the bot's own sessions resolve under.
     * ------------------------------------------------------------------ */
    let scopeCache = { presetId: null, key: undefined }

    async function skillsScope() {
      const presetId = String(config.agentPreset === undefined ? '' : config.agentPreset)
      if (scopeCache.presetId === presetId) return scopeCache.key
      let key
      try {
        key = await svc('agentPresets').standingKeyFor(presetId)
      } catch (error) {
        log('skill scope lookup failed: ' + describeError(error))
        key = undefined
      }
      scopeCache = { presetId: presetId, key: key }
      return key
    }

    async function skillViewOptions(entry) {
      const options = {}
      const cwd = workspacePathFor(entry)
      if (typeof cwd === 'string' && cwd !== '') options.cwd = cwd
      const scope = await skillsScope()
      if (scope !== undefined) options.scope = scope
      return options
    }

    async function availableSkills(entry) {
      return await svc('skills').list(await skillViewOptions(entry))
    }

    async function loadSkillByName(entry, name) {
      return await svc('skills').get(name, await skillViewOptions(entry))
    }

    function userInvocableSkill(skill) {
      return skill !== undefined && skill.invocation !== undefined && skill.invocation.userInvocable === true
    }

    /* Escapers mirroring the canonical renderer so provider text cannot close
     * the framing tags. */
    function escapeSkillAttr(value) {
      return String(value).split('&').join('&amp;').split('"').join('&quot;').split('<').join('&lt;')
    }

    function escapeSkillText(value) {
      return String(value).split('&').join('&amp;').split('<').join('&lt;').split('>').join('&gt;')
    }

    function resourceHintLines(skill) {
      const base = skill.resourceBase
      if (base === undefined) {
        return ['Resources for this skill are managed by provider "' + escapeSkillText(skill.provider) + '".', 'Load referenced resources only as needed.']
      }
      if (base.kind === 'directory') {
        return ['Base directory for this skill: ' + escapeSkillText(base.path), 'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.']
      }
      if (base.kind === 'url') {
        return ['Base URL for this skill: ' + escapeSkillText(base.url), 'Resolve relative URLs mentioned by this skill against the base URL before using them. Load referenced resources only as needed.']
      }
      return ['Resources for this skill: ' + escapeSkillText(base.description), 'Load referenced resources only as needed.']
    }

    /** Byte-for-byte the model-facing block the `skill` tool result and a GUI
     *  user-invocation both produce. */
    function renderSkillContent(skill) {
      const lines = ['<skill_content name="' + escapeSkillAttr(skill.name) + '">', '<skill_resources>']
      const hints = resourceHintLines(skill)
      for (let i = 0; i < hints.length; i += 1) lines.push(hints[i])
      lines.push('</skill_resources>')
      lines.push('')
      lines.push('<skill_instructions>')
      lines.push(skill.content)
      lines.push('</skill_instructions>')
      lines.push('</skill_content>')
      return lines.join('\n')
    }

    /** @returns { skills, hidden } or { error }. */
    async function skillInventory(entry) {
      try {
        const all = await availableSkills(entry)
        const usable = []
        let hidden = 0
        for (let i = 0; i < all.length; i += 1) {
          if (userInvocableSkill(all[i])) usable.push(all[i])
          else hidden += 1
        }
        return { skills: usable, hidden: hidden }
      } catch (error) {
        return { error: describeError(error) }
      }
    }

    async function renderSkillList(entry) {
      const inventory = await skillInventory(entry)
      if (inventory.error !== undefined) return '🧩 技能：读取失败（' + inventory.error + '）'
      const lines = ['🧩 可用技能（' + inventory.skills.length + '）']
      if (inventory.skills.length === 0) {
        lines.push('（这个工作区没有用户可调用的技能）')
      }
      for (let i = 0; i < inventory.skills.length && i < 20; i += 1) {
        const skill = inventory.skills[i]
        lines.push(i + 1 + '. ' + skill.name + '  [' + skill.source + ']\n    ' + skill.description)
        if (skill.whenToUse !== undefined && skill.whenToUse !== '') lines.push('    触发：' + skill.whenToUse)
      }
      if (inventory.skills.length > 20) lines.push('…还有 ' + (inventory.skills.length - 20) + ' 个')
      lines.push('')
      lines.push('用法：')
      lines.push('  /skill <名称|序号> <任务>   把技能加载进上下文并完成任务')
      lines.push('  /skill <名称|序号>          只看技能详情')
      lines.push('例如：/skill qiankun 帮我把这个 Vite 应用改成微前端子应用')
      if (inventory.hidden > 0) lines.push('（另有 ' + inventory.hidden + ' 个仅模型可用的技能未列出）')
      return lines.join('\n')
    }

    /** @returns { summary } or { error } with a user-facing message. */
    async function resolveSkill(entry, query) {
      const inventory = await skillInventory(entry)
      if (inventory.error !== undefined) return { error: '🧩 技能：读取失败（' + inventory.error + '）' }

      if (/^\d+$/.test(query)) {
        const index = Number(query) - 1
        if (index < 0 || index >= inventory.skills.length) {
          return { error: '序号 ' + query + ' 超出范围（共 ' + inventory.skills.length + ' 个）\n\n' + (await renderSkillList(entry)) }
        }
        return { summary: inventory.skills[index] }
      }

      for (let i = 0; i < inventory.skills.length; i += 1) {
        if (inventory.skills[i].name === query) return { summary: inventory.skills[i] }
      }

      // The name may exist but be model-only, or belong to another workspace.
      try {
        const found = await loadSkillByName(entry, query)
        if (found !== undefined && !userInvocableSkill(found)) {
          return { error: '技能「' + query + '」不允许用户直接调用（userInvocable=false）。\n\n' + (await renderSkillList(entry)) }
        }
      } catch (error) {
        /* fall through to the not-found reply */
      }
      return { error: '找不到技能「' + query + '」\n\n' + (await renderSkillList(entry)) }
    }

    /** `/skill …`: list, inspect, or load-and-run. */
    async function handleSkillCommand(chatId, entry, messageId, text, startedAt) {
      const rest = text.slice(text.split(/\s+/)[0].length).trim()
      if (rest === '' || rest === 'list' || rest === 'ls') {
        await replyRich(chatId, messageId, entry, await renderSkillList(entry), metricsLine(entry.sessionId, startedAt))
        return
      }

      const pieces = rest.split(/\s+/)
      const query = pieces[0]
      const task = rest.slice(query.length).trim()
      const resolved = await resolveSkill(entry, query)
      if (resolved.error !== undefined) {
        await replyRich(chatId, messageId, entry, resolved.error, metricsLine(entry.sessionId, startedAt))
        return
      }

      const summary = resolved.summary
      if (task === '') {
        const lines = ['🧩 ' + summary.name + '  [' + summary.source + ']', summary.description]
        if (summary.whenToUse !== undefined && summary.whenToUse !== '') lines.push('触发：' + summary.whenToUse)
        if (summary.resourceBase !== undefined && summary.resourceBase.kind === 'directory') lines.push('资源目录：' + summary.resourceBase.path)
        lines.push('')
        lines.push('在后面加上任务即可执行，例如：')
        lines.push('  /skill ' + summary.name + ' <你的任务>')
        await replyRich(chatId, messageId, entry, lines.join('\n'), metricsLine(entry.sessionId, startedAt))
        return
      }

      let skill
      try {
        skill = await loadSkillByName(entry, summary.name)
      } catch (error) {
        await replyRich(chatId, messageId, entry, '🧩 加载技能「' + summary.name + '」失败：' + describeError(error), metricsLine(entry.sessionId, startedAt))
        return
      }
      if (skill === undefined) {
        await replyRich(chatId, messageId, entry, '🧩 技能「' + summary.name + '」已不在目录中（可能刚被删掉），/skill 可看最新列表。', metricsLine(entry.sessionId, startedAt))
        return
      }

      const prompt = renderSkillContent(skill) + '\n\n' + task
      const placeholderId = await sendPlaceholder(chatId, messageId, '🧩 正在按技能 ' + skill.name + ' 执行…', entry)
      const agent = await acquireAgent(entry, entry.title)
      log('skill run chat=' + chatId + ' skill=' + skill.name + ' chars=' + skill.content.length + ' task=' + j(task.slice(0, 120)))
      const reply = await runTurn(agent, prompt)
      entry.turns = (typeof entry.turns === 'number' ? entry.turns : 0) + 1
      entry.lastReplyAt = Date.now()
      const how = await deliver(chatId, messageId, reply, placeholderId, entry, metricsLine(entry.sessionId, startedAt))
      await saveState()
      log('skill done chat=' + chatId + ' skill=' + skill.name + ' via=' + how + ' replyChars=' + reply.length)
      await flushLog()
    }

    /* ------------------------------------------------------------------ *
     * workspace switching
     * ------------------------------------------------------------------ */

    /** Expand a leading `~` without ever handing a raw user path to a shell unquoted. */
    function expandHome(input) {
      const raw = String(input === undefined || input === null ? '' : input).trim()
      if (raw === '~') return homedir()
      if (raw.indexOf('~/') === 0) return join(homedir(), raw.slice(2))
      return raw
    }

    /**
     * Canonicalize an existing directory, or return undefined.
     * `cd X && pwd -P` both proves the path is a directory and resolves symlinks
     * the same way `workspaceRegistry.create` does.
     */
    async function canonicalDir(candidate) {
      const path = expandHome(candidate)
      if (path === '') return undefined
      const probe = await sh('cd ' + quote(path) + ' && pwd -P')
      if (probe.code !== 0) return undefined
      const resolved = probe.stdout.trim()
      return resolved === '' ? undefined : resolved
    }

    /** The workspace a chat uses: its own override, else the deployment default. */
    function workspacePathFor(entry) {
      const override = entry === undefined ? undefined : entry.workspacePath
      if (typeof override === 'string' && override !== '') return override
      return String(config.workspacePath || '')
    }

    function isDefaultWorkspace(entry) {
      return !(typeof entry.workspacePath === 'string' && entry.workspacePath !== '')
    }

    function baseName(path) {
      const trimmed = String(path).replace(/\/+$/, '')
      const index = trimmed.lastIndexOf('/')
      return index === -1 ? trimmed : trimmed.slice(index + 1)
    }

    /** Registry order first (stable numbering), the active path appended when unregistered. */
    function workspaceOptions(entry) {
      const current = workspacePathFor(entry)
      const options = []
      const seen = new Set()
      try {
        const list = svc('workspaceRegistry').list()
        for (let i = 0; i < list.length; i += 1) {
          const workspace = list[i]
          if (!workspace || typeof workspace.path !== 'string' || seen.has(workspace.path)) continue
          seen.add(workspace.path)
          options.push({ path: workspace.path, title: workspace.title === undefined ? baseName(workspace.path) : workspace.title })
        }
      } catch (error) {
        log('workspace list failed: ' + describeError(error))
      }
      if (current !== '' && !seen.has(current)) {
        options.push({ path: current, title: baseName(current) })
      }
      return { current: current, options: options }
    }

    async function renderWorkspaceList(entry) {
      const listing = workspaceOptions(entry)
      // Best-effort: a listing that cannot see the corpus still lists paths.
      let picks = new Map()
      try {
        picks = await workspacePicks(entry)
      } catch (error) {
        log('workspace list session lookup failed: ' + describeError(error))
      }
      const lines = ['📁 工作区（' + listing.options.length + '）']
      const limit = Math.min(listing.options.length, 15)
      for (let i = 0; i < limit; i += 1) {
        const option = listing.options[i]
        const marker = option.path === listing.current ? '   ← 当前' : ''
        lines.push(i + 1 + '. ' + option.title + marker + '\n    ' + option.path)
        const pick = option.path === listing.current ? undefined : picks.get(option.path)
        const busy = pick !== undefined && pick.live === true ? '（GUI 里也开着）' : ''
        lines.push('    ↳ ' + (option.path === listing.current ? '就是当前工作区' : pick === undefined ? '没有可用会话，过去会开一个' : '接着 ' + formatWhen(pick.at) + ' 那次会话' + busy))
      }
      if (listing.options.length > limit) lines.push('…还有 ' + (listing.options.length - limit) + ' 个')
      lines.push('')
      lines.push('切换：直接回 /ws <序号>，例如 /ws 2')
      lines.push('也支持名称或路径：/ws alpha · /ws ~/Desktop/some-project')
      lines.push('默认接着该工作区最近用过的会话；想开全新的加 new，例如 /ws 2 new')
      if (!isDefaultWorkspace(entry)) {
        lines.push('/ws default  恢复默认：' + config.workspacePath)
      }
      return lines.join('\n')
    }

    /**
     * Split a `/ws` argument into the workspace query and the fresh-session
     * flag. A TRAILING `new`/`fresh` is the flag and everything before it is the
     * query, so `/ws new` on its own stays a query — a directory actually named
     * "new" remains reachable.
     */
    function parseWorkspaceArg(argument) {
      const pieces = argument.split(/\s+/)
      let fresh = false
      if (pieces.length > 1 && (pieces[pieces.length - 1] === 'new' || pieces[pieces.length - 1] === 'fresh')) {
        fresh = true
        pieces.pop()
      }
      return { query: pieces.join(' ').trim(), fresh: fresh }
    }

    /**
     * Resolve one `/ws` argument to a canonical directory.
     * Order: pure integer = list index, then name match, then filesystem path.
     * @returns { path } on success, { error } with a user-facing message otherwise.
     */
    async function resolveWorkspaceArg(entry, arg) {
      const listing = workspaceOptions(entry)
      const query = arg.trim()

      if (/^\d+$/.test(query)) {
        const index = Number(query) - 1
        if (index < 0 || index >= listing.options.length) {
          return { error: '序号 ' + query + ' 超出范围（共 ' + listing.options.length + ' 个）\n\n' + (await renderWorkspaceList(entry)) }
        }
        return { path: listing.options[index].path }
      }

      const lowered = query.toLowerCase()
      const hits = []
      for (let i = 0; i < listing.options.length; i += 1) {
        const option = listing.options[i]
        if (option.title.toLowerCase().indexOf(lowered) !== -1 || baseName(option.path).toLowerCase().indexOf(lowered) !== -1) {
          hits.push(option)
        }
      }
      if (hits.length === 1) return { path: hits[0].path }
      if (hits.length > 1) {
        const names = []
        for (let i = 0; i < hits.length; i += 1) names.push('· ' + hits[i].path)
        return { error: '“' + query + '” 匹配到 ' + hits.length + ' 个工作区，请用完整路径：\n' + names.join('\n') }
      }

      const resolved = await canonicalDir(query)
      if (resolved === undefined) {
        return { error: '找不到目录：“' + query + '”\n需要是一个已存在的绝对路径（支持 ~）。当前可选：\n\n' + (await renderWorkspaceList(entry)) }
      }
      return { path: resolved }
    }

    /** The per-turn wall-clock ceiling actually in force. */
    function effectiveTimeout() {
      return typeof config.timeoutMs === 'number' && config.timeoutMs > 0 ? config.timeoutMs : DEFAULTS.timeoutMs
    }

    /**
     * Change which session this chat talks to, under one guard.
     *
     * `apply` performs the mutation (a fresh id, another id, a workspace
     * change) and its return value is passed back to the caller. Everything
     * that repoints a chat goes through here so the in-flight-turn rules — and
     * the escape hatch for a turn that will never settle — exist in one place.
     *
     * @returns the applied value, or undefined when the swap was parked.
     */
    async function withSessionSwap(chatId, entry, apply) {
      const sessionKey = String(entry.sessionId)
      const capture = captures.get(sessionKey)
      const running = capture !== undefined && typeof capture.startedAt === 'number'
      if (running && Date.now() - capture.startedAt <= effectiveTimeout()) {
        deferredSwaps.set(chatId, apply)
        log('session swap deferred chat=' + chatId + ' (turn in flight on ' + entry.sessionId + ')')
        return undefined
      }

      const previous = liveHandles.get(entry.sessionId)
      if (previous !== undefined) {
        liveHandles.delete(entry.sessionId)
        if (running) {
          // Escape hatch: that turn is past its own ceiling and will never
          // settle (a step waiting on a tool result that can never arrive), so
          // waiting for it is waiting forever. Dispose WITHOUT awaiting: the
          // handle's dispose() exits the loop first, and this loop is exactly
          // what is stuck, so the promise may never resolve. The session is
          // detached from the chat either way, which is what matters.
          captures.delete(sessionKey)
          log('session swap forced chat=' + chatId + ' (turn on ' + entry.sessionId + ' exceeded ' + effectiveTimeout() + 'ms; detaching without await)')
          previous.dispose().catch(function (error) {
            log('forced dispose settle: ' + describeError(error))
          })
        } else {
          try {
            await previous.dispose()
          } catch (error) {
            log('dispose failed: ' + describeError(error))
          }
        }
      }
      return apply()
    }

    /** End the chat's current session and point it at a brand-new one. */
    async function restartChatSession(chatId, entry) {
      return await withSessionSwap(chatId, entry, function () {
        rememberSession(entry, entry.sessionId)
        entry.generation = (typeof entry.generation === 'number' ? entry.generation : 0) + 1
        entry.sessionId = sessionIdFor(chatId, entry.generation)
        return entry.sessionId
      })
    }

    /** Point the chat at a session that already exists. */
    async function switchChatSession(chatId, entry, targetId) {
      if (targetId === entry.sessionId) return entry.sessionId
      return await withSessionSwap(chatId, entry, function () {
        rememberSession(entry, entry.sessionId)
        entry.sessionId = targetId
        return entry.sessionId
      })
    }

    /** Apply a swap that was parked because its own turn was still running. */
    async function drainDeferredSwap(chatId, entry) {
      const apply = deferredSwaps.get(chatId)
      if (apply === undefined) return
      const applied = await withSessionSwap(chatId, entry, apply)
      if (applied === undefined) return
      deferredSwaps.delete(chatId)
      await saveState()
      log('deferred swap applied chat=' + chatId + ' session=' + entry.sessionId)
    }

    /**
     * Point the chat at another workspace.
     *
     * By default the chat then RESUMES the session last used in that
     * workspace: switching to a project usually means going back to the
     * conversation you were having there, and silently landing in a fresh one
     * throws that away. `options.fresh` asks for the old behaviour, and is what
     * the model-facing tool uses: an agent switching a chat to a directory
     * wants a clean context there, not the human's half-finished thread.
     */
    async function switchWorkspace(chatId, entry, target, options) {
      const canonical = await canonicalDir(target)
      if (canonical === undefined) return { ok: false, message: '目录不存在：' + target }
      if (canonical === workspacePathFor(entry)) {
        return { ok: true, message: '已经在这个工作区了：' + canonical + '\n（换会话用 /s，开新会话用 /new）' }
      }
      const isDefault = canonical === String(config.workspacePath || '')
      const fresh = options !== undefined && options.fresh === true

      let pick
      if (!fresh) {
        try {
          pick = await latestSessionIn(canonical, entry)
        } catch (error) {
          log('workspace resume lookup failed for ' + canonical + ': ' + describeError(error))
        }
      }

      if (isDefault) delete entry.workspacePath
      else entry.workspacePath = canonical

      if (pick === undefined) {
        const swapped = await restartChatSession(chatId, entry)
        await saveState()
        log('workspace switch chat=' + chatId + ' -> ' + canonical + ' session=' + entry.sessionId + (isDefault ? ' (default)' : ' (override)') + (fresh ? ' (fresh)' : ' (no session to resume)') + (swapped === undefined ? ' (deferred)' : ''))
        if (swapped === undefined) {
          return {
            ok: true,
            message: '✅ 工作区已记录：' + canonical + '\n但当前会话仍在运行，为避免中断本轮，新会话将在下一条消息建立。',
          }
        }
        return {
          ok: true,
          message: '✅ 已切换到工作区：' + canonical + '\n新会话：' + entry.sessionId + '（上下文已重置' + (isDefault ? '，已恢复默认' : '，仅本会话生效') + '）',
        }
      }

      const swapped = await switchChatSession(chatId, entry, pick.id)
      await saveState()
      log('workspace switch chat=' + chatId + ' -> ' + canonical + ' session=' + pick.id + (isDefault ? ' (default)' : ' (override)') + ' (resumed)' + (swapped === undefined ? ' (deferred)' : ''))
      if (swapped === undefined) {
        return {
          ok: true,
          message: '✅ 工作区已记录：' + canonical + '\n将接着「' + pick.id + '」继续，但当前会话仍在运行，为避免中断本轮，切换在下一条消息生效。',
        }
      }
      const titles = await sessionTitles([pick.id])
      const lines = [
        '✅ 已切换到工作区：' + canonical,
        '接着最近用过的会话：' + sessionLabel({ id: pick.id, mine: false, active: false, missing: false }, titles.get(pick.id)) + '（' + formatWhen(pick.at) + '）',
        '会话 ID：' + pick.id,
      ]
      if (pick.preset !== undefined && pick.preset !== config.agentPreset) {
        lines.push('注意：该会话的 preset 是 ' + pick.preset + '，机器人按 ' + config.agentPreset + ' 继续。')
      }
      if (pick.live === true) {
        lines.push('⚠️ 该会话此刻在 GUI 里也开着。两边共用同一个 agent，回合会排队；同时说话时，飞书这边的回复可能取到 GUI 那一轮的答案，建议一次只在一处说。')
      }
      lines.push('想从零开始就发 /new。')
      return { ok: true, message: lines.join('\n') }
    }

    async function ensureWorkspacePath(entry) {
      const configured = workspacePathFor(entry)
      const resolved = await canonicalDir(configured)
      if (resolved !== undefined) return resolved
      log('workspacePath "' + configured + '" is not a directory; falling back to /tmp')
      return '/tmp'
    }

    /* ------------------------------------------------------------------ *
     * session switching
     *
     * The durable corpus comes from ctx.sessionQuery rather than from reading
     * ~/.dsh/sessions by hand: listSessions() is live-preferred and
     * newest-first, and readTitleSnapshots() folds every title in ONE
     * observation with per-session failure isolation, so one corrupt log
     * cannot take the whole listing down with it. Both take an optional
     * AbortSignal, which is why the sandbox having no AbortController costs
     * nothing here.
     * ------------------------------------------------------------------ */
    /** Rows shown per `/s`: enough to choose from, short enough to read on a phone. */
    const SESSION_PAGE = 12

    function formatWhen(ms) {
      const when = new Date(ms)
      const pad = function (value) {
        return (value < 10 ? '0' : '') + value
      }
      return pad(when.getMonth() + 1) + '-' + pad(when.getDate()) + ' ' + pad(when.getHours()) + ':' + pad(when.getMinutes())
    }

    /** Session ids this plugin mints for Feishu chats. */
    function isBotSessionId(id) {
      return id.indexOf('feishu-') === 0
    }

    /**
     * True when a session is live but NOT through a handle this plugin owns —
     * i.e. something else (the GUI) holds it. Holding is not the problem:
     * adopting that agent keeps ONE context and the GUI sees this bot's turns
     * live. What is a problem is adopting one MID-TURN, which is the check
     * below.
     */
    function sessionBusy(id) {
      return svc('agents').get(id) !== undefined && liveHandles.get(id) === undefined
    }

    /**
     * True when a foreign live session is running a turn RIGHT NOW.
     *
     * `/s` refuses only this case. An IDLE foreign session is adopted instead:
     * `acquireAgent` finds the live agent and reuses it, so the switch keeps
     * that context and the GUI side watches this bot's turns arrive. Refusing
     * idle ones only ever meant "go close that tab first" — not a rule anyone
     * can follow from a phone. A RUNNING one stays refused: two drivers
     * mid-turn interleave their steps and neither can tell.
     */
    function sessionForeignTurnRunning(id) {
      if (liveHandles.get(id) !== undefined) return false
      const live = svc('agents').get(id)
      return live !== undefined && live.status === 'running'
    }

    /** True when another Feishu chat is currently pointed at this session. */
    function otherChatOwns(sessionId, entry) {
      const ids = Object.keys(chats)
      for (let i = 0; i < ids.length; i += 1) {
        const other = chats[ids[i]]
        if (other === entry) continue
        if (String(other.sessionId) === String(sessionId)) return true
      }
      return false
    }

    /**
     * When each session was last written to, keyed by session id.
     *
     * `listSessions()` orders by CREATION time, and that is not the question
     * `/ws` asks. On this machine the two orders disagree in every workspace:
     * the session being used right now was created BEFORE one that was started
     * this morning and abandoned. The log file's mtime is what answers "which
     * one were you just in", so it is read here; creation time is the fallback
     * when the log cannot be found (a session that never ran has no file).
     */
    let touchedCache = { at: 0, value: null }
    async function sessionTouchedAt() {
      if (touchedCache.value !== null && Date.now() - touchedCache.at < 5000) return touchedCache.value
      const touched = new Map()
      try {
        // ONE `stat` for every session file, not one per file. The loop this
        // replaced ran `stat` 41 times on this machine and would run it once per
        // session forever; the array form is a single exec with the same output.
        // `/ws` calls this on every listing and every switch.
        const result = await sh('files=(' + SESSIONS_GLOB + '/*/*/session.v3.jsonl.zstd); if [ -e "${files[0]}" ]; then stat -f "%m %N" "${files[@]}" 2>/dev/null; fi', undefined, 20000, READ_MAX_BYTES)
        if (result.code === 0 && !result.truncated) {
          const lines = result.stdout.split('\n')
          for (let i = 0; i < lines.length; i += 1) {
            const space = lines[i].indexOf(' ')
            if (space <= 0) continue
            const seconds = Number(lines[i].slice(0, space))
            const parts = lines[i].slice(space + 1).split('/')
            if (!Number.isFinite(seconds) || parts.length < 2) continue
            touched.set(parts[parts.length - 2], seconds * 1000)
          }
        } else {
          log('session mtimes unavailable (exit ' + result.code + (result.truncated === true ? ', truncated' : '') + '); /ws falls back to creation time')
        }
      } catch (error) {
        log('session mtimes failed: ' + describeError(error))
      }
      touchedCache = { at: Date.now(), value: touched }
      return touched
    }

    /**
     * The session each workspace would resume, from one corpus pass.
     *
     * Three exclusions, each an ownership conflict rather than a heuristic: a
     * delegated child is not a conversation; a session this plugin minted for
     * ANOTHER chat is that chat's (two chats on one session double-post every
     * reply); a session another chat was switched onto is the same hazard one
     * step removed.
     *
     * A session that is merely LIVE elsewhere is NOT excluded — it is flagged.
     * The GUI keeps an agent resident for every session it has opened, and in
     * this deployment that is every root session in every workspace the user
     * works in, so excluding them would leave `/ws` with nothing to resume
     * anywhere that matters. Sharing is workable because `/ws` attaches to the
     * SAME agent object in the SAME process: turns queue on one inbox instead
     * of racing, and the person is told to speak in one place at a time.
     *
     * @returns a Map from workspace path to `{ id, at, live }` — the most
     *   recently used eligible session there, or no entry at all.
     */
    async function workspacePicks(entry) {
      const all = await svc('sessionQuery').listSessions()
      const touched = await sessionTouchedAt()
      const picks = new Map()
      // Why a workspace came back empty is not visible from the outside, and
      // an all-excluded workspace is exactly the case worth auditing.
      const skipped = []
      for (let i = 0; i < all.length; i += 1) {
        const header = all[i].header
        if (header === undefined) continue
        const id = String(header.id)
        let reason
        if (header.origin === 'subagent') reason = 'subagent'
        else if (id === String(entry.sessionId)) reason = 'this chat'
        else if (isBotSessionId(id)) reason = 'another chat'
        else if (otherChatOwns(id, entry)) reason = 'another chat (switched)'
        if (reason !== undefined) {
          skipped.push(id + ' = ' + reason)
          continue
        }
        const at = touched.has(id) ? touched.get(id) : header.createdAt
        const previous = picks.get(header.cwd)
        if (previous === undefined || at > previous.at) {
          picks.set(header.cwd, { id: id, at: at, createdAt: header.createdAt, preset: header.agentPreset, live: sessionBusy(id) })
        }
      }
      if (skipped.length > 0) log('session picks skipped: ' + skipped.join(' | '))
      return picks
    }

    /** What `/ws <workspace>` resumes there, or undefined to start a fresh session. */
    async function latestSessionIn(workspace, entry) {
      const picks = await workspacePicks(entry)
      return picks.get(workspace)
    }

    /**
     * Everything `/s` needs, from one corpus observation.
     * Rows are ordered, so a row's 1-based index IS the number the user types.
     */
    async function chatSessionListing(entry) {
      const workspace = workspacePathFor(entry)
      const activeId = String(entry.sessionId)
      const ownIds = [activeId]
      const remembered = rememberedSessions(entry)
      for (let i = 0; i < remembered.length; i += 1) {
        const saved = remembered[i]
        if (saved === null || typeof saved !== 'object') continue
        const id = String(saved.id === undefined ? '' : saved.id)
        if (id !== '' && ownIds.indexOf(id) === -1) ownIds.push(id)
      }

      const all = await svc('sessionQuery').listSessions()
      const seen = new Map()
      for (let i = 0; i < all.length; i += 1) {
        const header = all[i].header
        if (header === undefined) continue
        seen.set(String(header.id), all[i])
      }

      const rows = []
      let foreignCount = 0
      for (let i = 0; i < ownIds.length && rows.length < SESSION_PAGE; i += 1) {
        const record = seen.get(ownIds[i])
        // Kept even when absent from the corpus: the active session of a chat
        // that has never been answered has no log yet, and DROPPING that row
        // shifts every later number, so `/s 2` from a list read a moment ago
        // would silently address a different session. Absence is rendered
        // instead (see sessionLabel / renderSessionList).
        rows.push({
          id: ownIds[i],
          mine: true,
          active: ownIds[i] === activeId,
          createdAt: record === undefined ? undefined : record.header.createdAt,
          preset: record === undefined ? undefined : record.header.agentPreset,
          missing: record === undefined,
        })
      }
      for (let i = 0; i < all.length && rows.length < SESSION_PAGE; i += 1) {
        const header = all[i].header
        if (header === undefined) continue
        const id = String(header.id)
        if (header.cwd !== workspace) continue
        // A delegated child is not a conversation you can pick up.
        if (header.origin === 'subagent') continue
        if (ownIds.indexOf(id) !== -1) continue
        // Another Feishu chat's session is never offered: `/s` links a chat to
        // its own past and to your GUI work, not to its sibling chat. Counted
        // so the listing says so instead of hiding the corpus silently.
        if (isBotSessionId(id)) {
          foreignCount += 1
          continue
        }
        rows.push({
          id: id,
          mine: false,
          active: false,
          createdAt: header.createdAt,
          preset: header.agentPreset,
          missing: false,
        })
      }
      return { rows: rows, foreignCount: foreignCount }
    }

    /** Fold titles for a batch of ids; failures stay per-session and non-fatal. */
    async function sessionTitles(ids) {
      const titles = new Map()
      if (ids.length === 0) return titles
      try {
        const results = await svc('sessionQuery').readTitleSnapshots(ids)
        for (let i = 0; i < results.length; i += 1) {
          const result = results[i]
          if (result === null || typeof result !== 'object' || result.status !== 'fulfilled') continue
          const title = result.value === undefined ? undefined : result.value.title
          if (title !== undefined && typeof title.title === 'string' && title.title !== '') {
            titles.set(String(result.sessionId), title.title)
          }
        }
      } catch (error) {
        log('session title fold failed: ' + describeError(error))
      }
      return titles
    }

    /** The id is the only durable label, so an untitled row still needs one. */
    function sessionLabel(row, title) {
      if (title !== undefined && title !== '') return title
      // Absent from the corpus means two different things, and conflating them
      // is what made a fresh chat look broken. Only the active-and-unlogged
      // case gets a friendly label; a remembered row keeps its id so that two
      // log-less rows stay tellable apart.
      if (row.mine && row.missing && row.active) return '（新会话，还没开始）'
      return row.mine ? row.id : '（无标题）'
    }

    async function renderSessionList(entry, listing) {
      if (listing.rows.length === 0) return '📋 这个工作区还没有任何会话。发一条消息就会建一个。'
      const titles = await sessionTitles(listing.rows.map(function (row) { return row.id }))
      const lines = ['📋 会话（工作区 ' + baseName(workspacePathFor(entry)) + '）', '']
      let printedOtherHeader = false
      for (let i = 0; i < listing.rows.length; i += 1) {
        const row = listing.rows[i]
        if (!row.mine && !printedOtherHeader) {
          printedOtherHeader = true
          lines.push('工作区其它')
        }
        const marks = []
        if (row.active) marks.push('← 当前')
        if (row.missing && !row.active) marks.push('⚠ 日志已不在磁盘上')
        if (row.preset !== undefined && row.preset !== config.agentPreset) marks.push('preset ' + row.preset)
        const when = row.createdAt === undefined ? '' : '   ' + formatWhen(row.createdAt)
        lines.push('  ' + (i + 1) + '. ' + sessionLabel(row, titles.get(row.id)) + when + (marks.length === 0 ? '' : '   ' + marks.join('  ')))
      }
      lines.push('')
      lines.push('切换：/s <序号>     新建：/s new     忘掉某个：/s drop <序号>')
      if (listing.rows.length >= SESSION_PAGE) lines.push('（只列了前 ' + SESSION_PAGE + ' 个）')
      if (listing.foreignCount > 0) lines.push('（另有 ' + listing.foreignCount + ' 个属于其它飞书会话的会话未列出）')
      lines.push('时间是创建时间。切过去就是接着那边的上下文继续聊，切回来也一样。')
      return lines.join('\n')
    }

    /** @returns a user-facing reply. */
    async function switchToSession(chatId, entry, index) {
      let listing
      try {
        listing = await chatSessionListing(entry)
      } catch (error) {
        return '📋 会话：读取失败（' + describeError(error) + '）'
      }
      const row = listing.rows[index - 1]
      if (row === undefined) {
        return '序号 ' + index + ' 超出范围（共 ' + listing.rows.length + ' 个）\n\n' + (await renderSessionList(entry, listing))
      }
      if (row.active) return '已经在这个会话了。'
      if (row.missing) {
        return '⚠️ 「' + row.id + '」只在记录里，磁盘上的日志已经没有了。切过去等于开一个同名的空会话 —— 想重开请用 /s new。'
      }
      if (sessionForeignTurnRunning(row.id)) {
        const busyTitles = await sessionTitles([row.id])
        return '❌ 「' + sessionLabel(row, busyTitles.get(row.id)) + '」此刻正在跑一个回合（多半是 GUI 那边发起的）。两个驱动同时跑会让回合交叉、互相打断，所以先等它跑完；/s 可以重新看一遍列表。'
      }
      // Two chats on one session is not just confusing, it is broken: a question
      // raised by the second chat is posted to whichever chat comes first in the
      // map, `chatForSession` cannot tell them apart, and the first turn to end
      // clears the other's captures. `/ws` already refuses this; `/s` must too.
      if (otherChatOwns(row.id, entry)) {
        const ownedTitles = await sessionTitles([row.id])
        return '❌ 「' + sessionLabel(row, ownedTitles.get(row.id)) + '」已经绑在另一个飞书会话上。两个会话共用一个 DSH 会话会让提问投递到错误的聊天、回合互相清掉状态，所以不切过去；用 /s new 开一个新的。'
      }
      const sharedWithGui = sessionBusy(row.id)
      const swapped = await switchChatSession(chatId, entry, row.id)
      await saveState()
      if (swapped === undefined) return '本轮结束后再切换（当前会话仍在运行，避免打断自己的回合）。下一条消息生效。'
      const titles = await sessionTitles([row.id])
      const lines = ['✅ 已切换到：' + sessionLabel(row, titles.get(row.id)), '会话 ID：' + row.id]
      if (row.preset !== undefined && row.preset !== config.agentPreset) {
        lines.push('注意：该会话的 preset 是 ' + row.preset + '，机器人按 ' + config.agentPreset + ' 继续。')
      }
      lines.push('下一条消息就接在这段上下文后面。')
      if (sharedWithGui) {
        lines.push('⚠️ 该会话在 GUI 里也开着：两边共用同一个 agent（同一份上下文），GUI 会实时看到这里的回合。建议一次只在一处说话。')
      }
      log('session switch chat=' + chatId + ' -> ' + row.id + (sharedWithGui ? ' (adopted a live GUI session)' : ''))
      return lines.join('\n')
    }

    /** Forget one remembered session. The session itself is untouched. */
    async function dropRememberedSession(entry, index) {
      const listing = await chatSessionListing(entry)
      const row = listing.rows[index - 1]
      if (row === undefined) return '序号 ' + index + ' 超出范围（共 ' + listing.rows.length + ' 个）'
      if (!row.mine) return '只能忘掉「本会话」里的记录；工作区其它会话是自动列出来的，忘不掉。'
      if (row.active) return '当前会话不能忘掉，先 /s new 或 /s <其它序号> 换走。'
      entry.sessions = rememberedSessions(entry).filter(function (saved) {
        return saved === null || typeof saved !== 'object' || String(saved.id) !== row.id
      })
      await saveState()
      return '已从列表里去掉：' + row.id + '\n（会话本身没删，还能在 GUI 里打开。）'
    }

    /**
     * The route an agent runs on. BOTH create and resume must supply this:
     * dsh-agent-loop resolves the prompt variables `{{model}}` and
     * `{{provider}}` from `agent.options`, and the deployment persona section
     * references `{{model}}`. `agents.resume` defaults `agentOptions` to `{}`,
     * so a resume that omits it makes every subsequent prompt assembly throw
     * `prompt variable "{{model}}" has no value` — the turn dies at step/start
     * with no request ever reaching the provider.
     */
    function currentAgentOptions() {
      const selection = svc('agentDefaultModel').currentSelection()
      const options = { provider: selection.provider, model: selection.model }
      if (selection.reasoningEffort !== undefined) options.reasoningEffort = selection.reasoningEffort
      return options
    }

    async function createAgent(entry, displayName) {
      const agents = svc('agents')
      const presets = svc('agentPresets')
      const preset = await presets.resolve(config.agentPreset)
      await presets.standingKeyFor(preset.id)
      const workspace = await svc('workspaceRegistry').create(await ensureWorkspacePath(entry), '飞书机器人')
      const sessionId = entry.sessionId
      const agentOptions = currentAgentOptions()

      const handle = await agents.create({
        sessionId: sessionId,
        meta: { cwd: workspace.path, agentPreset: preset.id },
        agentOptions: agentOptions,
        setup: mountSetup(preset.id),
      })
      liveHandles.set(sessionId, handle)
      try {
        await workspace.attachSession(sessionId)
      } catch (error) {
        log('workspace attach failed: ' + describeError(error))
      }
      if (config.permissionPreset !== '') {
        // Only when the operator asked for one. An empty value leaves the
        // deployment's own policy in force: a chat-driven agent must not widen
        // (or narrow) what the harness was configured to allow just because a
        // plugin was installed.
        try {
          svc('permissionPresets').set(handle.agent.session, config.permissionPreset)
        } catch (error) {
          log('permission preset "' + config.permissionPreset + '" rejected: ' + describeError(error))
        }
      }
      try {
        svc('sessionTitle').rename(handle.agent.session, displayName)
      } catch (error) {
        log('session title failed: ' + describeError(error))
      }
      log('created session ' + sessionId + ' (' + preset.id + ') in ' + workspace.path)
      return handle.agent
    }

    async function acquireAgent(entry, displayName) {
      const agents = svc('agents')
      const live = agents.get(entry.sessionId)
      if (live !== undefined) {
        seedUsage(live.session)
        return live
      }

      const presets = svc('agentPresets')
      const preset = await presets.resolve(config.agentPreset)
      try {
        const handle = await agents.resume({
          resumeSessionId: entry.sessionId,
          agentOptions: currentAgentOptions(),
          setup: mountSetup(preset.id),
        })
        liveHandles.set(entry.sessionId, handle)
        // A resumed session carries its own history, so seed the metrics off
        // that log rather than waiting for the next request to report usage.
        seedUsage(handle.agent.session)
        log('resumed session ' + entry.sessionId)
        return handle.agent
      } catch (error) {
        log('resume failed for ' + entry.sessionId + ' (' + describeError(error) + '); creating a fresh session')
      }
      return createAgent(entry, displayName)
    }

    /* ------------------------------------------------------------------ *
     * the agent turn
     * ------------------------------------------------------------------ */
    async function runTurn(agent, prompt) {
      const session = agent.session
      seedUsage(session)
      const startSeq = session.seq
      const startedAt = Date.now()
      // `sent` is what this turn has ALREADY posted, so text delivered ahead of
      // a question is not posted a second time when the turn ends.
      const capture = { last: '', sent: '', startedAt: startedAt }
      const key = String(session.id)
      captures.set(key, capture)
      lastActivity.set(key, startedAt)
      // A turn in flight is what tells the interactive seams below that the
      // person to ask is the one in this chat, not whoever is at the GUI.
      activeTurns.add(key)

      const timer = armTurnTimer(agent, session, startedAt)
      const isTimedOut = function () {
        return timer.timedOut
      }

      try {
        agent.followup({
          id: newMessageId(),
          role: 'user',
          content: [{ type: 'text', text: prompt }],
          source: { kind: 'plugin', plugin: 'feishu-bot', form: 'relay' },
        })
        await waitForWorkToSettle(agent, session, startedAt, isTimedOut)
      } finally {
        timer.stop()
        captures.delete(key)
        activeTurns.delete(key)
      }

      let reply = capture.last !== '' ? capture.last : lastAssistantText(session, startSeq)
      if (reply !== '' && reply === capture.sent) {
        // Everything the model said was already posted before the question it
        // asked. The placeholder still needs an ending, but repeating a whole
        // card would be noise.
        reply = '（上面那张卡片就是这一轮的回答）'
      }
      if (timer.timedOut) {
        reply = (reply === '' ? '' : reply + '\n\n') + '⏱️ 处理超时，本轮已中断。'
      }
      return reply
    }

    /* ------------------------------------------------------------------ *
     * human-in-the-loop: questions and approvals asked over Feishu
     *
     * DSH puts both decisions on a Cordis waterfall — `user-questions/request`
     * for the `ask_user_question` tool, `approval/request` when a tool call
     * needs a permission decision. A browser answerer composes onto the same
     * waterfall at boot, so these listeners register with `prepend` and claim
     * ONLY a session with a Feishu-driven turn in flight: the person who must
     * answer is the one who sent the message, while a request raised by a
     * GUI-driven turn still belongs to the GUI. Without this, `ask()` finds no
     * answerer, the tool returns an empty answer, and the model is left
     * guessing what a silent "no selection" meant.
     * ------------------------------------------------------------------ */
    /** One pending human interaction per chat; the next message in that chat is its answer. */
    const pendings = new Map()
    /** Sessions with a Feishu-driven turn in flight. */
    const activeTurns = new Set()
    /** Last inbound message per chat, so a question can be threaded under it. */
    const lastInbound = new Map()

    function chatForSession(sessionId) {
      const key = String(sessionId)
      const ids = Object.keys(chats)
      for (let i = 0; i < ids.length; i += 1) {
        if (String(chats[ids[i]].sessionId) === key) return { chatId: ids[i], entry: chats[ids[i]] }
      }
      return undefined
    }

    function pendingForSession(sessionId) {
      const key = String(sessionId)
      const iterator = pendings.values()
      let step = iterator.next()
      while (step.done !== true) {
        if (step.value.sessionId === key) return step.value
        step = iterator.next()
      }
      return undefined
    }

    /**
     * The session that spawned this agent's session, from the only PUBLIC
     * source of that relation.
     *
     * Ownership is not readable off the agent: the registry records it
     * privately (`enter(agent, owner)`) and exposes only `list()` and
     * `roots()`. `Agent.parentAgent` is declared in the type but never
     * assigned at runtime — reading it yields undefined for every agent, which
     * is precisely how the first version of liveTree concluded that a session
     * with a running subagent had none. The session header is authoritative and
     * is what the durable log itself carries.
     */
    function parentSessionOf(agent) {
      const session = agent === undefined || agent === null ? undefined : agent.session
      const header = session === undefined || session === null ? undefined : session.header
      const parent = header === undefined || header === null ? undefined : header.parentSession
      if (parent !== undefined && parent !== null) return String(parent)
      // The declared shape, honoured when some other backend does populate it.
      // Guarded because the first line of this function accepts a missing
      // agent — and reading `.parentAgent` off one throws, which would take
      // `liveTree` down inside a try that silently returns a wrong answer.
      if (agent === undefined || agent === null) return undefined
      const owner = agent.parentAgent
      if (owner !== undefined && owner !== null && owner.session !== undefined && owner.session !== null) {
        return String(owner.session.id)
      }
      return undefined
    }

    /**
     * Every live agent working underneath one session, the session itself
     * included. A delegated child is the parent's work continuing in another
     * session, so anything asking "is this turn still going" has to look down
     * the tree, not just at the root.
     */
    function liveTree(sessionId) {
      const ids = new Set([String(sessionId)])
      let all
      try {
        all = svc('agents').list()
      } catch (error) {
        return ids
      }
      // Transitive, so a grandchild counts too.
      let grew = true
      while (grew) {
        grew = false
        for (let i = 0; i < all.length; i += 1) {
          const id = String(all[i].session.id)
          if (ids.has(id)) continue
          const parent = parentSessionOf(all[i])
          if (parent !== undefined && ids.has(parent)) {
            ids.add(id)
            grew = true
          }
        }
      }
      return ids
    }

    /**
     * How long the whole tree has been silent.
     *
     * This is the difference between a turn that is WORKING and one that is
     * WEDGED, and both the settle wait and the turn ceiling are decided by it.
     * A wall-clock ceiling is the wrong instrument: on 09-10 a turn that had
     * been issuing tool calls every few seconds for five minutes was killed
     * mid-flight because it had been alive for five minutes, which is not a
     * symptom of anything.
     */
    function quietFor(sessionId, startedAt) {
      let latest = typeof startedAt === 'number' ? startedAt : 0
      const ids = liveTree(sessionId)
      ids.forEach(function (id) {
        const at = lastActivity.get(id)
        if (at !== undefined && at > latest) latest = at
      })
      return Date.now() - latest
    }

    /**
     * The fiber-owned timer as a promise, for waiting without blocking.
     *
     * The PROMISE overload, not the callback one, and it matters on reload: a
     * callback timer's disposer only clears the timeout, so its promise never
     * settles and `waitForWorkToSettle` would loop forever on a fiber that no
     * longer exists — holding the turn, the chat's queue entry and this whole
     * instance alive for the life of the process. This form rejects on dispose,
     * which the catch turns into "stop waiting".
     */
    function delay(ms) {
      return ctx.timeout(ms).catch(function () {
        return undefined
      })
    }

    /**
     * Wait for the work to be over — which is not the same as `whenIdle()`.
     *
     * `whenIdle()` resolves when the CURRENT turn ends. The model can hand work
     * to a background subagent, end its turn, and be woken into a NEW turn when
     * that subagent reports back; one did exactly that on 09-10, and the chat
     * got the interim sentence "先并行铺开…" while the real deliverable — a
     * 314-line document — was produced 68 seconds later by a turn nobody was
     * watching. Nothing was ever sent to Feishu.
     *
     * So idle is necessary but not sufficient. The turn is over when the tree
     * is idle AND has no live delegated agent left AND has been silent for
     * `SETTLE_MS` — the last of which covers the notice already in flight when
     * a child disposes itself.
     */
    async function waitForWorkToSettle(agent, session, startedAt, isTimedOut) {
      while (true) {
        await agent.whenIdle()
        if (isTimedOut() === true) return
        // The instance was disposed mid-turn: this chat is served by a new one
        // now, so stop polling rather than logging "still settling" forever.
        if (disposed === true) return
        const tree = liveTree(session.id)
        const quiet = quietFor(session.id, startedAt)
        if (tree.size <= 1 && quiet >= SETTLE_MS) return
        log('turn still settling (session=' + session.id + ' live subagents=' + (tree.size - 1) + ' quiet=' + Math.round(quiet / 1000) + 's)')
        await delay(Math.min(SETTLE_MS, 5000))
      }
    }

    /**
     * Arm the per-turn ceiling — measured in SILENCE, not in wall clock.
     *
     * It re-arms while anything in the session's tree is still producing
     * events, and while a human is being asked a question (a person reads at
     * human speed). What is left is the case the ceiling exists for: a turn
     * that has gone quiet and will never speak again.
     */
    function armTurnTimer(agent, session, startedAt) {
      const state = { timedOut: false, stopped: false, disarm: null }
      const arm = function () {
        state.disarm = ctx.timeout(function () {
          if (state.stopped) return
          if (pendingForSession(session.id) !== undefined) {
            log('turn timeout held: chat is waiting on a human answer (session=' + session.id + ')')
            arm()
            return
          }
          const quiet = quietFor(session.id, startedAt)
          if (quiet < effectiveTimeout()) {
            log('turn timeout held: session=' + session.id + ' still producing (quiet ' + Math.round(quiet / 1000) + 's)')
            arm()
            return
          }
          state.timedOut = true
          try {
            agent.cancel({ kind: 'hook', reason: 'feishu bot timeout' })
          } catch (error) {
            /* already settled */
          }
        }, effectiveTimeout())
      }
      arm()
      return {
        get timedOut() {
          return state.timedOut
        },
        stop: function () {
          state.stopped = true
          if (state.disarm !== null) state.disarm()
        },
      }
    }

    function questionTitle(kind, index, total) {
      const label = kind === 'approval' ? '🔐 需要你批准一个操作' : '❓ 需要你确认'
      return total > 1 ? label + '（第 ' + (index + 1) + '/' + total + ' 个）' : label
    }

    /** The pending card's markdown: question, detail, then numbered options. */
    function questionText(item, index, total) {
      const lines = ['**' + questionTitle('question', index, total) + '**']
      if (typeof item.header === 'string' && item.header !== '') lines.push('**' + item.header + '**')
      lines.push(String(item.question))
      const detail = typeof item.detail === 'string' ? item.detail : ''
      if (detail !== '') {
        // A plan review puts the whole plan in `detail`, and a decision about
        // an invisible plan is not a decision. Render it, capped far above the
        // short "supporting context" case.
        lines.push('')
        lines.push(detail.length > DETAIL_MAX_CHARS ? detail.slice(0, DETAIL_MAX_CHARS) + '\n\n…（内容过长，已截断）' : detail)
      }
      const options = item.options === undefined ? [] : item.options
      for (let i = 0; i < options.length; i += 1) {
        lines.push('')
        lines.push('**' + (i + 1) + '.** ' + String(options[i].label))
        if (typeof options[i].description === 'string' && options[i].description !== '') lines.push(options[i].description)
      }
      return lines.join('\n')
    }

    function questionHint(item) {
      const options = item.options === undefined ? [] : item.options
      const cancel = '发送 /cancel 取消这次提问'
      if (options.length === 0) return '直接回复你的答案；' + cancel + '。'
      const how = item.multiSelect === true ? '回复序号 1-' + options.length + '（多个用空格隔开，如 1 3）' : '回复序号 1-' + options.length
      return how + '，或直接回复你的答案；' + cancel + '。'
    }

    function approvalText(request) {
      const lines = ['**' + questionTitle('approval', 0, 1) + '**']
      lines.push('工具 `' + String(request.toolName) + '` 需要你决定是否放行。')
      if (typeof request.reason === 'string' && request.reason !== '') {
        lines.push('')
        lines.push('原因：' + request.reason)
      }
      lines.push('')
      lines.push('**1.** 允许一次')
      lines.push('')
      lines.push('**2.** 拒绝')
      return lines.join('\n')
    }

    const APPROVE_WORDS = ['1', '1.', '允许', '允许一次', '同意', '放行', 'yes', 'y', 'ok', 'allow']
    const DENY_WORDS = ['2', '2.', '拒绝', '不允许', '不行', 'no', 'n', 'deny', 'reject']

    /** A permission decision, exact-match only: 'allowed-once', 'rejected', or undefined. */
    function approvalChoice(text) {
      const lowered = text.toLowerCase()
      if (APPROVE_WORDS.indexOf(lowered) !== -1) return 'allowed-once'
      if (DENY_WORDS.indexOf(lowered) !== -1) return 'rejected'
      return undefined
    }

    /**
     * Read one reply against one question. A bare index or an exact label
     * selects; anything else is the free-text answer, encoded the way the GUI
     * encodes it (`selected: []` plus `custom`, which for the GUI means the
     * typed answer replaces the pick on a single-select question).
     */
    function readChoice(item, text) {
      const options = item.options === undefined ? [] : item.options
      const tokens = text.split(/[\s,，、;；\/]+/).filter(function (token) {
        return token !== ''
      })
      if (options.length > 0 && tokens.length > 0) {
        const picked = []
        let numeric = true
        for (let i = 0; i < tokens.length; i += 1) {
          const value = Number(tokens[i])
          if (Number.isInteger(value) !== true || value < 1 || value > options.length) {
            numeric = false
            break
          }
          const label = String(options[value - 1].label)
          if (picked.indexOf(label) === -1) picked.push(label)
        }
        if (numeric) return { selected: item.multiSelect === true ? picked : picked.slice(0, 1) }
        for (let i = 0; i < options.length; i += 1) {
          if (String(options[i].label).toLowerCase() === text.toLowerCase()) return { selected: [String(options[i].label)] }
        }
      }
      return { selected: [], custom: text }
    }

    /**
     * Whether an unaddressed group message still counts as an answer. Without
     * this, answering in a group would require an @-mention AND the group would
     * otherwise treat every stray "1" as an answer to someone else's question.
     */
    function looksLikeAnswer(pending, text) {
      if (text === '/cancel' || text === '/取消') return true
      if (pending.kind === 'approval') return approvalChoice(text) !== undefined
      const item = pending.questions[pending.index]
      const options = item.options === undefined ? [] : item.options
      if (options.length === 0) return false
      const tokens = text.split(/[\s,，、;；\/]+/).filter(function (token) {
        return token !== ''
      })
      if (tokens.length > 0) {
        let numeric = true
        for (let i = 0; i < tokens.length; i += 1) {
          const value = Number(tokens[i])
          if (Number.isInteger(value) !== true || value < 1 || value > options.length) {
            numeric = false
            break
          }
        }
        if (numeric) return true
      }
      for (let i = 0; i < options.length; i += 1) {
        if (String(options[i].label).toLowerCase() === text.toLowerCase()) return true
      }
      return false
    }

    function questionError(message, code) {
      const error = new Error(message)
      error.name = 'UserQuestionError'
      error.code = code
      return error
    }

    function finishPending(pending, settle) {
      if (pending.done === true) return false
      pending.done = true
      if (pendings.get(pending.chatId) === pending) pendings.delete(pending.chatId)
      settle()
      return true
    }

    function watchAbort(signal, onAbort) {
      if (signal === undefined || signal === null || typeof signal.addEventListener !== 'function') return function () {}
      const handler = function () {
        onAbort()
      }
      signal.addEventListener('abort', handler, { once: true })
      if (signal.aborted === true) handler()
      return function () {
        signal.removeEventListener('abort', handler)
      }
    }

    /**
     * Post assistant text that would otherwise be stranded.
     *
     * The model routinely writes its answer and calls `ask_user_question` in the
     * SAME step — the text explains what it is about to ask. A chat that only
     * ever sends the turn's LAST message therefore puts a bare question in front
     * of the person and drops the answer entirely. On 09-11 a 786-character v2
     * design summary, table and all, was lost exactly this way: Feishu got the
     * question card and nothing that explained it.
     *
     * So before a blocking question goes out, whatever the turn has produced so
     * far is delivered first — and remembered, so the turn's own ending does not
     * post it twice.
     */
    async function flushStrandedText(chatId, entry, sessionId) {
      const capture = captures.get(String(sessionId))
      if (capture === undefined) return
      const text = capture.last
      if (text === '' || text === capture.sent) return
      capture.sent = text
      try {
        const target = config.useReply === true ? lastInbound.get(chatId) : undefined
        const response = await send(chatId, 'interactive', cardJson(text, entry, {}), target)
        if (response.code !== 0) {
          log('stranded text card failed: ' + j(response))
          const fallback = await send(chatId, 'text', textJson(text), undefined)
          if (fallback.code !== 0) log('stranded text fallback failed: ' + j(fallback))
        }
        log('delivered text that preceded a question chat=' + chatId + ' chars=' + text.length)
      } catch (error) {
        log('stranded text threw: ' + describeError(error))
      }
      await flushLog()
    }

    /** Post the pending card, falling back to plain text. A question nobody can see is a turn nobody can unblock. */
    async function postPendingCard(pending) {
      try {
        const response = await send(pending.chatId, 'interactive', cardJson(pending.cardText, pending.entry, { footer: pending.footer }), pending.replyTo)
        if (response.code === 0 && response.data !== undefined && typeof response.data.message_id === 'string') {
          pending.messageId = response.data.message_id
          pending.card = true
          return true
        }
        log('question card failed: ' + j(response))
        const fallback = await send(pending.chatId, 'text', textJson(pending.cardText + '\n\n' + pending.footer), pending.replyTo)
        if (fallback.code === 0 && fallback.data !== undefined && typeof fallback.data.message_id === 'string') {
          pending.messageId = fallback.data.message_id
          pending.card = false
          return true
        }
        log('question text failed: ' + j(fallback))
      } catch (error) {
        log('question send threw: ' + describeError(error))
      }
      return false
    }

    /** Rewrite the pending card in place. Only a card can be patched, so a text fallback stays as it is. */
    async function patchPendingCard(pending, markdown) {
      pending.cardText = markdown
      if (pending.messageId === null || pending.card !== true) return
      try {
        const response = await patchCard(pending.messageId, markdown, pending.entry, { footer: pending.footer })
        if (response.code !== 0) log('question card update failed: ' + j(response))
      } catch (error) {
        log('question card update threw: ' + describeError(error))
      }
    }

    function cancelPendingInteraction(pending) {
      if (pending.kind === 'approval') {
        finishPending(pending, function () {
          patchPendingCard(pending, pending.cardText + '\n\n**⛔ 已取消，按拒绝处理。**')
          log('approval cancelled chat=' + pending.chatId)
          pending.settle.resolve('rejected')
        })
        return
      }
      finishPending(pending, function () {
        patchPendingCard(pending, pending.cardText + '\n\n**⛔ 已取消这次提问。**')
        log('question cancelled chat=' + pending.chatId)
        pending.settle.reject(questionError('the user cancelled ask_user_question', 'ASK_CANCELLED'))
      })
    }

    async function acceptAnswer(pending, text, message) {
      if (pending.kind === 'approval') {
        const outcome = approvalChoice(text)
        if (outcome === undefined) {
          await sendText(pending.chatId, message.message_id, '请回复 1（允许一次）或 2（拒绝）；发送 /cancel 取消。')
          return
        }
        finishPending(pending, function () {
          patchPendingCard(pending, pending.cardText + '\n\n**' + (outcome === 'allowed-once' ? '✅ 已允许（仅本次）' : '⛔ 已拒绝') + '**')
          log('approval decided chat=' + pending.chatId + ' tool=' + String(pending.toolName) + ' outcome=' + outcome)
          pending.settle.resolve(outcome)
        })
        return
      }

      const item = pending.questions[pending.index]
      const choice = readChoice(item, text)
      const shown = choice.custom === undefined
        ? choice.selected.join('、')
        : (choice.selected.length === 0 ? '' : choice.selected.join('、') + ' ＋ ') + choice.custom
      pending.answers.push(choice.custom === undefined
        ? { id: item.id, selected: choice.selected }
        : { id: item.id, selected: choice.selected, custom: choice.custom })
      log('question answered chat=' + pending.chatId + ' id=' + item.id + ' selected=' + j(choice.selected) + ' custom=' + j(choice.custom === undefined ? '' : choice.custom.slice(0, 80)))
      await patchPendingCard(pending, pending.cardText + '\n\n**→ 已选择：' + shown + '**')
      await flushLog()

      pending.index += 1
      if (pending.index < pending.questions.length) {
        const next = pending.questions[pending.index]
        pending.cardText = questionText(next, pending.index, pending.questions.length)
        pending.footer = questionHint(next)
        pending.replyTo = undefined
        pending.messageId = null
        pending.card = false
        const visible = await postPendingCard(pending)
        log('question ' + (pending.index + 1) + '/' + pending.questions.length + ' delivered=' + visible)
        await flushLog()
        return
      }

      finishPending(pending, function () {
        pending.settle.resolve({ answers: pending.answers })
      })
      await flushLog()
    }

    /**
     * Take one inbound message as the answer to this chat's pending
     * interaction. Returns false when the message is not an answer at all and
     * normal message dispatch should have it instead.
     */
    async function tryAnswerPending(pending, message) {
      const raw = extractText(message)
      if (raw === '') {
        await sendText(message.chat_id, message.message_id, '现在有一个待回答的问题，请用文字回复序号或答案；发送 /cancel 取消。')
        return true
      }
      const text = stripMentions(raw).replace(/^\s+/, '').replace(/\s+$/, '')
      if (text === '') return false
      const addressed = message.chat_type !== 'group' || config.groupRequireMention !== true || botWasMentioned(message)
      if (!addressed && !looksLikeAnswer(pending, text)) return false
      if (text === '/cancel' || text === '/取消') {
        cancelPendingInteraction(pending)
        return true
      }
      // Another bot command is not an answer, and it must not silently become
      // one: say so and keep the question open.
      if (text.charAt(0) === '/' && !looksLikeAnswer(pending, text)) {
        await sendText(pending.chatId, message.message_id, '当前还有一个问题没有回答。请回复序号或答案，或发送 /cancel 取消这次提问。')
        return true
      }
      // The pending was live when this message was read at ingress, but the
      // turn can be aborted while the answer is in flight — in which case the
      // text is not an answer to anything and must not silently become a prompt.
      if (pending.done === true) {
        await sendText(pending.chatId, message.message_id, '这个问题已经结束了（本轮已中断或已作答）。')
        return true
      }
      // Two answers can arrive back to back: an answer bypasses the chat queue
      // on purpose (queueing it behind the turn it releases would deadlock the
      // chat), so both run concurrently unless this latch stops them. Without
      // it both read index 0, the first question gets two answers, and the two
      // `pending.index += 1` steps skip the second question entirely.
      if (pending.busy === true) {
        await sendText(pending.chatId, message.message_id, '正在处理上一条回答，请稍候再发。')
        return true
      }
      pending.busy = true
      try {
        await acceptAnswer(pending, text, message)
      } finally {
        pending.busy = false
      }
      return true
    }

    /**
     * Ask the chat's questions one at a time. Sequential rather than batched:
     * one card, one answer, and no numbering scheme that has to encode "which
     * question" on top of "which option".
     *
     * @returns the answer batch, or undefined when the first card could not be
     *   delivered at all and the next answerer should be offered the request.
     */
    async function askQuestionsOnFeishu(target, request) {
      const signal = request.signal
      if (signal !== undefined && signal !== null && signal.aborted === true) {
        throw questionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED')
      }
      const pending = {
        kind: 'question',
        chatId: target.chatId,
        entry: target.entry,
        sessionId: String(target.entry.sessionId),
        replyTo: config.useReply === true ? lastInbound.get(target.chatId) : undefined,
        messageId: null,
        card: false,
        cardText: questionText(request.questions[0], 0, request.questions.length),
        footer: questionHint(request.questions[0]),
        index: 0,
        questions: request.questions,
        answers: [],
        done: false,
        settle: null,
        createdAt: Date.now(),
      }
      let settle = null
      const outcome = new Promise(function (resolve, reject) {
        settle = { resolve: resolve, reject: reject }
      })
      pending.settle = settle
      pendings.set(target.chatId, pending)
      await flushStrandedText(target.chatId, target.entry, pending.sessionId)
      const detach = watchAbort(signal, function () {
        finishPending(pending, function () {
          patchPendingCard(pending, pending.cardText + '\n\n**⏹️ 本轮已中断，这个问题作废。**')
          settle.reject(questionError('ask_user_question was aborted before the user answered', 'ASK_ABORTED'))
        })
      })
      try {
        // The abort can land while the text above was being flushed, and
        // watchAbort fires its handler immediately for an already-aborted
        // signal — in which case the question is finished before it is asked.
        // Posting the card anyway leaves the chat with a live-looking question
        // whose answer is no longer an answer to anything, so the next message
        // starts a brand-new turn from the text "1".
        if (pending.done === true) return undefined
        const visible = await postPendingCard(pending)
        log('question asked chat=' + pending.chatId + ' session=' + pending.sessionId + ' questions=' + pending.questions.length + ' delivered=' + visible)
        await flushLog()
        if (!visible) return undefined
        return await outcome
      } finally {
        detach()
        if (pendings.get(target.chatId) === pending) pendings.delete(target.chatId)
      }
    }

    /**
     * Ask the chat to decide one permission request. An approval never rejects:
     * it resolves with a closed outcome, and every unavailable path fails
     * closed rather than leaving the caller waiting.
     */
    async function askApprovalOnFeishu(target, request) {
      const signal = request.signal
      if (signal !== undefined && signal !== null && signal.aborted === true) return 'cancelled'
      const pending = {
        kind: 'approval',
        chatId: target.chatId,
        entry: target.entry,
        sessionId: String(target.entry.sessionId),
        toolName: String(request.toolName),
        replyTo: config.useReply === true ? lastInbound.get(target.chatId) : undefined,
        messageId: null,
        card: false,
        cardText: approvalText(request),
        footer: '回复 1 允许一次，2 拒绝；发送 /cancel 取消（按拒绝处理）。',
        done: false,
        settle: null,
        createdAt: Date.now(),
      }
      let settle = null
      const outcome = new Promise(function (resolve) {
        settle = { resolve: resolve }
      })
      pending.settle = settle
      pendings.set(target.chatId, pending)
      await flushStrandedText(target.chatId, target.entry, pending.sessionId)
      const detach = watchAbort(signal, function () {
        finishPending(pending, function () {
          patchPendingCard(pending, pending.cardText + '\n\n**⏹️ 本轮已中断，按拒绝处理。**')
          settle.resolve('cancelled')
        })
      })
      try {
        // Same race as the question path: an abort that landed during the
        // flush above has already decided this request, and a card for it would
        // invite a reply nothing is waiting for.
        if (pending.done === true) return 'cancelled'
        const visible = await postPendingCard(pending)
        log('approval asked chat=' + pending.chatId + ' session=' + pending.sessionId + ' tool=' + String(request.toolName) + ' delivered=' + visible)
        await flushLog()
        if (!visible) return undefined
        return await outcome
      } finally {
        detach()
        if (pendings.get(target.chatId) === pending) pendings.delete(target.chatId)
      }
    }

    function sessionIdOf(agent) {
      if (agent === undefined || agent === null || agent.session === undefined || agent.session === null) return undefined
      const id = agent.session.id
      return id === undefined || id === null ? undefined : String(id)
    }

    /** The chat that owns this request, or undefined when it belongs to whoever is at the GUI. */
    function claimTarget(agent) {
      const sessionId = sessionIdOf(agent)
      if (sessionId === undefined || activeTurns.has(sessionId) !== true) return undefined
      const target = chatForSession(sessionId)
      if (target === undefined || pendings.has(target.chatId)) return undefined
      return target
    }

    function answerUserQuestion(request, next) {
      const target = claimTarget(request.agent)
      if (target === undefined) return next()
      return askQuestionsOnFeishu(target, request).then(function (answer) {
        return answer === undefined ? next() : answer
      })
    }

    function answerApproval(request, next) {
      const target = claimTarget(request.agent)
      if (target === undefined) return next()
      return askApprovalOnFeishu(target, request).then(function (outcome) {
        return outcome === undefined ? next() : outcome
      })
    }

    // `prepend`: the browser answerer registers at boot, and a waterfall asks
    // listeners in order, so a request this bot should own never reaches it.
    ctx.on('user-questions/request', answerUserQuestion, { prepend: true })
    ctx.on('approval/request', answerApproval, { prepend: true })

    function clampReply(text) {
      const max = typeof config.maxReplyChars === 'number' && config.maxReplyChars > 200 ? config.maxReplyChars : DEFAULTS.maxReplyChars
      if (text.length <= max) return text
      return text.slice(0, max) + '\n\n…（回复过长，已截断）'
    }

    async function deliver(chatId, replyToMessageId, markdown, placeholderId, entry, footer) {
      const clean = normalizeReply(markdown)
      const base = clampReply(clean === '' ? '（没有返回任何内容）' : clean)
      const line = typeof footer === 'string' ? footer : ''
      const body = line === '' ? base : base + '\n\n' + line
      const rich = line === '' ? {} : { footer: line }
      const flat = line === '' ? { tables: false } : { tables: false, footer: line }
      const target = config.useReply ? replyToMessageId : undefined

      if (placeholderId !== null) {
        const patched = await attempt(function () {
          return patchCard(placeholderId, base, entry, rich)
        })
        if (patched.code === 0) return 'card-update'
        log('card update failed: ' + j(patched))
        // A card the client rejects (an exotic table, say) must not cost the
        // answer: retry the same card with tables flattened, then fall through
        // to a fresh message.
        const flattened = await attempt(function () {
          return patchCard(placeholderId, base, entry, flat)
        })
        if (flattened.code === 0) return 'card-update-plain'
        log('plain card update failed: ' + j(flattened))
      }

      const wantCard = config.replyStyle !== 'text'
      if (wantCard) {
        const primary = await send(chatId, 'interactive', cardJson(base, entry, rich), target)
        if (primary.code === 0) return 'card'
        log('card send failed: ' + j(primary))
        const flattened = await send(chatId, 'interactive', cardJson(base, entry, flat), target)
        if (flattened.code === 0) return 'card-plain'
        log('plain card send failed: ' + j(flattened))
      }
      const fallback = await send(chatId, 'text', textJson(body), target)
      if (fallback.code === 0) return wantCard ? 'text-fallback' : 'text'
      throw new Error('Feishu rejected both card and text replies: ' + j(fallback))
    }

    async function sendPlaceholder(chatId, replyToMessageId, label, entry) {
      if (config.acknowledge !== true) return null
      try {
        const response = await send(chatId, 'interactive', cardJson(label === undefined ? '⏳ 已收到，正在处理…' : label, entry), config.useReply ? replyToMessageId : undefined)
        if (response.code === 0 && response.data && typeof response.data.message_id === 'string') return response.data.message_id
        log('placeholder send failed: ' + j(response))
      } catch (error) {
        log('placeholder failed: ' + describeError(error))
      }
      return null
    }

    const queues = new Map()
    function enqueue(chatId, task) {
      const previous = queues.get(chatId) === undefined ? Promise.resolve() : queues.get(chatId)
      const next = previous.then(task, task)
      queues.set(chatId, next)
      const settle = function () {
        if (queues.get(chatId) === next) queues.delete(chatId)
      }
      next.then(settle, settle)
      return next
    }

    /* ------------------------------------------------------------------ *
     * inbound event handling
     * ------------------------------------------------------------------ */
    const seenMessages = new Set()
    function firstTime(messageId) {
      if (typeof messageId !== 'string' || messageId === '') return true
      if (seenMessages.has(messageId)) return false
      seenMessages.add(messageId)
      if (seenMessages.size > 2000) {
        const iterator = seenMessages.values()
        for (let i = 0; i < 500; i += 1) {
          const step = iterator.next()
          if (step.done) break
          seenMessages.delete(step.value)
        }
      }
      return true
    }

    function extractText(message) {
      if (message.message_type !== 'text') return ''
      try {
        const parsed = JSON.parse(message.content === undefined ? '{}' : message.content)
        return typeof parsed.text === 'string' ? parsed.text : ''
      } catch (error) {
        return ''
      }
    }

    function stripMentions(text) {
      return text.replace(/@_user_\d+/g, '').replace(/@_all/g, '').replace(/\s+/g, ' ').trim()
    }

    function botWasMentioned(message) {
      const mentions = Array.isArray(message.mentions) ? message.mentions : []
      if (mentions.length === 0) return false
      if (botInfo === null) return true
      for (let i = 0; i < mentions.length; i += 1) {
        const mention = mentions[i]
        if (!mention) continue
        if (botInfo.openId !== '' && mention.id && mention.id.open_id === botInfo.openId) return true
        if (botInfo.name !== '' && mention.name === botInfo.name) return true
      }
      return false
    }

    const BOT_HELP = [
      '机器人指令：',
      '/skill — 列出可用技能',
      '/skill <名称|序号> <任务> — 加载技能并执行任务',
      '/skill <名称|序号> — 查看技能详情',
      '/ws — 查看工作区列表（带序号）',
      '/ws <序号|名称|路径> — 切换工作区，接着该工作区最近用过的会话',
      '/ws <序号|名称|路径> new — 切换工作区并开一个全新会话',
      '/ws default — 恢复默认工作区（同样接着那边的最近会话）',
      '/s — 列出会话（本会话的 + 工作区里其它 DSH 会话）',
      '/s <序号> — 切到那个会话，接着它的上下文继续',
      '/s new — 开新会话（当前这个留在列表里，可以切回来）',
      '/s drop <序号> — 从 /s 列表里去掉一条记录（不删会话）',
      '/new 或 /reset — 开启一个全新会话（丢掉上下文，工作区不变）',
      '/status — 查看当前会话、工作区与运行状态',
      '/stop — 中断正在执行的任务',
      '/cancel — 取消当前挂着的提问（模型问你问题时才有）',
      '/help — 显示本帮助',
    ].join('\n')

    /** A reply shaped like the real one that exposed the raw-table bug, used by the preview action. */
    /**
     * A reply shaped like a real one, used by the `preview` action.
     *
     * It is a fixture, not content: the point is that it exercises every
     * renderer in one card — prose, a table with alignment and a right-aligned
     * numeric column, inline code, a fenced block and a trailing list — so
     * `/preview` answers "does my card look right" without waiting for a turn.
     * Deliberately generic; it is the first thing a new installation renders.
     */
    const PREVIEW_SAMPLE = [
      '当前工作区 `/path/to/project` 内容如下：',
      '',
      '| 文件 | 大小 | 说明（据文件名） |',
      '| --- | ---: | :--- |',
      '| `release-notes-v2.0.docx` | 17 MB | 发布说明（第二版） |',
      '| `release-notes-v2.1.docx` | 17.5 MB | 发布说明（第二点一版） |',
      '| `prototype-v1.html` | 153 KB | 交互原型（第一版） |',
      '| `requirements-v1.0.md` | 43 KB | 页面需求说明书（第一版） |',
      '',
      '**建议下一步**',
      '',
      '1. 对照校验 —— 用两份 docx 核对 `.md` 与 `.html` 原型是否一致；',
      '2. 改原型 —— 按 `.md` 需求修改 `prototype-v1.html`；',
      '',
      '```bash',
      'ls -la',
      '```',
    ].join('\n')

    async function renderHelp(entry) {
      const lines = [BOT_HELP, '']
      const native = await renderNativeList(entry)
      for (let i = 0; i < native.length; i += 1) lines.push(native[i])
      lines.push('')
      lines.push('其他 /xxx 会直接交给 DSH 原生命令处理，不会发给模型。')
      return lines.join('\n')
    }

    /** @returns a reply string, or undefined when the text is not a bot command. */
    async function handleCommand(chatId, entry, text) {
      const pieces = text.split(/\s+/)
      const name = pieces[0].toLowerCase()
      const argument = text.slice(pieces[0].length).trim()

      if (name === '/help' || name === '/?') return renderHelp(entry)

      // `/cancel` is answered where a question is pending, before dispatch ever
      // gets here; reaching this line means there was nothing to cancel.
      if (name === '/cancel' || text === '/取消') return '现在没有待回答的问题，无需取消。'

      if (name === '/ws' || name === '/workspace' || name === '/workspaces') {
        if (argument === '') return await renderWorkspaceList(entry)
        if (argument === 'list' || argument === 'ls') return await renderWorkspaceList(entry)
        const parsed = parseWorkspaceArg(argument)
        if (parsed.query === '') return await renderWorkspaceList(entry)
        if (parsed.query === 'default' || parsed.query === '-') {
          return (await switchWorkspace(chatId, entry, config.workspacePath, { fresh: parsed.fresh })).message
        }
        const resolved = await resolveWorkspaceArg(entry, parsed.query)
        if (resolved.error !== undefined) return resolved.error
        return (await switchWorkspace(chatId, entry, resolved.path, { fresh: parsed.fresh })).message
      }

      if (name === '/status') {
        const agent = svc('agents').get(entry.sessionId)
        const workspace = workspacePathFor(entry)
        const usage = sessionUsage.get(String(entry.sessionId))
        const lines = [
          '会话：' + entry.sessionId,
          '状态：' + (agent === undefined ? '未启动（空闲）' : agent.status),
          '工作区：' + workspace + (isDefaultWorkspace(entry) ? '（默认）' : '（本会话覆盖）'),
          '传输：' + config.transport,
          '模型预设：' + config.agentPreset,
          '累计轮次：' + (entry.turns === undefined ? 0 : entry.turns),
        ]
        if (usage !== undefined && usage.promptTokens > 0) {
          lines.push('上下文：' + formatTokens(usage.promptTokens) + ' token' + (usage.contextWindow > 0 ? ' / ' + formatTokens(usage.contextWindow) + '（' + Math.min(100, Math.round((usage.promptTokens / usage.contextWindow) * 100)) + '%）' : ''))
        }
        return lines.join('\n')
      }

      if (name === '/stop') {
        const agent = svc('agents').get(entry.sessionId)
        if (agent === undefined) return '当前没有正在运行的任务。'
        agent.cancel({ kind: 'user' })
        return '已请求中断。'
      }

      if (name === '/s' || name === '/sessions' || name === '/session') {
        const sub = argument.split(/\s+/)[0].toLowerCase()
        const rest = argument.slice(sub.length).trim()
        if (argument === '' || sub === 'list' || sub === 'ls') {
          try {
            return await renderSessionList(entry, await chatSessionListing(entry))
          } catch (error) {
            return '📋 会话：读取失败（' + describeError(error) + '）'
          }
        }
        if (sub === 'new' || sub === 'n') {
          const fresh = await restartChatSession(chatId, entry)
          await saveState()
          if (fresh === undefined) return '本轮结束后再开新会话（当前会话仍在运行，避免打断自己的回合）。下一条消息生效。'
          return '✅ 已开新会话：' + fresh + '\n刚才那个已经记进 /s 列表，随时切回去。'
        }
        if (sub === 'drop' || sub === 'forget') {
          if (!/^\d+$/.test(rest)) return '用法：/s drop <序号>（序号来自 /s 列表）'
          return await dropRememberedSession(entry, Number(rest))
        }
        if (/^\d+$/.test(argument)) return await switchToSession(chatId, entry, Number(argument))
        return [
          '用法：',
          '  /s              列出这个工作区的会话（本会话的排前面）',
          '  /s <序号>       切过去，带着那边的上下文继续',
          '  /s new          开一个新会话（当前这个会留在列表里）',
          '  /s drop <序号>  从列表里去掉一条记录（不删会话）',
        ].join('\n')
      }

      if (name === '/new' || name === '/reset') {
        const swapped = await restartChatSession(chatId, entry)
        await saveState()
        if (swapped === undefined) return '本轮结束后再开新会话（当前会话仍在运行，避免打断自己的回合）。下一条消息生效。'
        return '已开启新会话：' + entry.sessionId + '\n工作区：' + workspacePathFor(entry)
      }

      return undefined
    }

    /** Forward one slash line to the deployment's own command registry. */
    async function handleNativeCommand(chatId, entry, messageId, line, startedAt) {
      const name = line.split(/\s+/)[0]
      const agent = await ensureCommandAgent(entry)
      if (agent === undefined) {
        await sendText(chatId, messageId, '无法为 ' + name + ' 建立会话，请看 plugin.log。')
        return
      }

      const placeholderId = await sendPlaceholder(chatId, messageId, '⏳ 正在执行 ' + name + ' …', entry)
      let body
      try {
        const execution = await executeNativeCommand(String(agent.id), line)
        if (execution === undefined || execution === null) {
          const available = await renderNativeList(entry)
          body = '未知指令：' + name + '\n\n' + available.join('\n')
        } else {
          const result = execution.result
          if (result.kind === 'success') {
            body = result.text === undefined || result.text === '' ? '✅ ' + name + ' 执行完成' : result.text
          } else {
            body = '❌ ' + result.text
          }
        }
      } catch (error) {
        body = '❌ ' + name + ' 执行失败：' + describeError(error).slice(0, 400)
        log('native ' + j(line.slice(0, 80)) + ' threw: ' + describeError(error))
      }
      // Record the outcome BEFORE attempting delivery: a send failure must not
      // hide what the command actually produced.
      log('native ' + j(line.slice(0, 80)) + ' result=' + j(body.slice(0, 600)))
      await flushLog()
      const how = await deliver(chatId, messageId, body, placeholderId, entry, metricsLine(entry.sessionId, startedAt))
      log('native ' + j(line.slice(0, 80)) + ' delivered via=' + how)
      await flushLog()
    }

    /**
     * Answer `/stop` immediately instead of queueing it behind the turn it is
     * meant to interrupt.
     *
     * `enqueue` serializes a chat's messages so two turns cannot overlap. That
     * is right for prompts and wrong for this one command: the task at the head
     * of the queue IS the runaway turn, so a queued `/stop` is delivered only
     * once there is nothing left to stop. `agent.cancel` needs no turn of its
     * own, and the same admission checks the normal path makes are repeated
     * here so an ignored message stays ignored.
     *
     * @returns true when this message was that command and has been answered.
     */
    async function tryStopOutOfBand(message, sender) {
      const entry = chats[message.chat_id]
      if (entry === undefined) return false
      const senderId = sender && sender.sender_id ? (sender.sender_id.open_id || sender.sender_id.user_id || '') : ''
      if (config.blockedUserIds.indexOf(senderId) !== -1) return false
      if (config.allowedChatIds.length > 0 && config.allowedChatIds.indexOf(message.chat_id) === -1) return false
      if (message.chat_type === 'group' && config.groupRequireMention === true && !botWasMentioned(message)) return false
      const text = stripMentions(extractText(message)).trim()
      if (text.split(/\s+/)[0].toLowerCase() !== '/stop') return false

      const startedAt = Date.now()
      let reply
      try {
        const agent = svc('agents').get(entry.sessionId)
        if (agent === undefined) {
          reply = '当前没有正在运行的任务。'
        } else {
          agent.cancel({ kind: 'user' })
          reply = '已请求中断。'
        }
      } catch (error) {
        reply = '中断失败：' + describeError(error)
      }
      log('stop out of band chat=' + message.chat_id + ' session=' + entry.sessionId)
      await replyRich(message.chat_id, message.message_id, entry, reply, metricsLine(entry.sessionId, startedAt))
      return true
    }

    async function processMessage(message, sender) {
      const startedAt = Date.now()
      const chatId = message.chat_id
      const chatType = message.chat_type
      const messageId = message.message_id
      const senderId = sender && sender.sender_id ? (sender.sender_id.open_id || sender.sender_id.user_id || '') : ''

      if (config.blockedUserIds.indexOf(senderId) !== -1) {
        log('ignored message from blocked user ' + senderId)
        return
      }
      if (config.allowedChatIds.length > 0 && config.allowedChatIds.indexOf(chatId) === -1) {
        log('ignored message from non-allowed chat ' + chatId)
        return
      }
      if (chatType === 'group' && config.groupRequireMention === true && !botWasMentioned(message)) {
        log('ignored group message without an @-mention in ' + chatId)
        return
      }

      lastInbound.set(chatId, messageId)
      const entry = chatEntry(chatId, chatType)

      // A swap parked by a previous turn takes effect now, before anything
      // reads entry.sessionId.
      await drainDeferredSwap(chatId, entry)

      // Nothing is answerable without credentials, so bail before any side effect.
      if (!credentialsPresent()) {
        log('cannot answer ' + chatId + ': appId/appSecret are missing from ' + CONFIG_PATH + ' (message ignored, no side effect)')
        return
      }

      const raw = extractText(message)
      if (raw === '') {
        await sendText(chatId, messageId, '目前只支持文本消息。')
        return
      }
      const text = stripMentions(raw)

      if (entry.title === undefined) {
        const name = chatType === 'group' ? await fetchChatName(chatId) : ''
        entry.title = name !== '' ? name : chatType === 'group' ? '飞书群 ' + chatId.slice(-6) : '飞书单聊 ' + chatId.slice(-6)
        await saveState()
      }

      const firstToken = text.split(/\s+/)[0].toLowerCase()

      // /skill needs the placeholder + turn flow, so it runs before the
      // string-returning command handler.
      if (firstToken === '/skill' || firstToken === '/skills') {
        await handleSkillCommand(chatId, entry, messageId, text, startedAt)
        return
      }

      const commandReply = await handleCommand(chatId, entry, text)
      if (commandReply !== undefined) {
        await replyRich(chatId, messageId, entry, commandReply, metricsLine(entry.sessionId, startedAt))
        return
      }

      // A slash line that is not a bot command belongs to the deployment's own
      // registry; a line with further slashes (a path) still reaches the model.
      if (COMMAND_LINE.test(text.split(/\s+/)[0])) {
        await handleNativeCommand(chatId, entry, messageId, text, startedAt)
        return
      }

      const placeholderId = await sendPlaceholder(chatId, messageId, undefined, entry)
      let reply
      let how
      try {
        const agent = await acquireAgent(entry, entry.title)
        log('turn start chat=' + chatId + ' session=' + entry.sessionId + ' cwd=' + workspacePathFor(entry) + ' chars=' + text.length)
        reply = await runTurn(agent, text)
        how = await deliver(chatId, messageId, reply, placeholderId, entry, metricsLine(entry.sessionId, startedAt))
      } catch (error) {
        // The placeholder is already on screen saying "已收到，正在处理…", and
        // leaving it there after a failure is worse than the failure: the chat
        // looks like it is still working, so the next message seems to vanish
        // behind a turn that is long gone. Replace that card with the error —
        // and do not also let the queue's generic handler send a second copy.
        log('turn failed: ' + describeError(error))
        const failure = '❌ 处理失败：' + describeError(error).slice(0, 500)
        const shown = placeholderId === null
          ? await send(chatId, 'text', textJson(failure), config.useReply ? messageId : undefined)
          : await patchCard(placeholderId, failure, entry, {})
        if (shown === undefined || shown.code !== 0) log('failure notice not delivered: ' + j(shown))
        await flushLog()
        return
      }
      entry.turns = (typeof entry.turns === 'number' ? entry.turns : 0) + 1
      entry.lastReplyAt = Date.now()
      await saveState()
      await flushLog()
      log('turn done chat=' + chatId + ' via=' + how + ' replyChars=' + reply.length + ' metrics=' + j(metricsLine(entry.sessionId, startedAt)))
    }

    async function handleEvent(envelope) {
      const header = envelope.header === undefined ? {} : envelope.header
      const eventType = header.event_type
      const event = envelope.event === undefined ? {} : envelope.event
      log('event ' + eventType + ' via=' + (envelope.via === undefined ? 'webhook' : envelope.via))

      if (eventType === 'im.message.receive_v1') {
        const message = event.message === undefined ? {} : event.message
        if (!firstTime(message.message_id)) {
          log('duplicate delivery for ' + message.message_id + ', ignored')
          return
        }
        // A message arriving while this chat has a pending question is that
        // question's ANSWER, not a new prompt. The turn that asked is still
        // open, so queueing this behind it would deadlock the chat: the answer
        // would wait for the turn the answer is supposed to release.
        const pending = pendings.get(message.chat_id)
        if (pending !== undefined) {
          const consumed = await tryAnswerPending(pending, message)
          if (consumed) return
        }
        // Before the queue, not in it: see tryStopOutOfBand.
        if (await tryStopOutOfBand(message, event.sender)) return
        enqueue(message.chat_id, function () {
          return processMessage(message, event.sender).catch(function (error) {
            log('turn failed: ' + describeError(error))
            if (!credentialsPresent()) return undefined
            return send(message.chat_id, 'text', textJson('❌ 处理失败：' + describeError(error).slice(0, 500)), config.useReply ? message.message_id : undefined).catch(function () {
              return undefined
            })
          })
        })
        return
      }

      if (eventType === 'im.chat.member.bot.added_v1') {
        const chatId = event.chat_id
        if (typeof chatId === 'string' && chatId !== '') {
          const entry = chatEntry(chatId, 'group')
          if (entry.title === undefined) {
            const name = await fetchChatName(chatId)
            entry.title = name !== '' ? name : '飞书群 ' + chatId.slice(-6)
          }
          await saveState()
          if (credentialsPresent()) {
            await send(chatId, 'text', textJson('👋 我是接入 DSH 的机器人。直接 @我 提问即可；发送 /help 查看指令，/skill 用技能，/ws 切换工作区。'), undefined)
          }
        }
        return
      }

      if (eventType === 'im.chat.member.bot.deleted_v1') {
        log('removed from chat ' + event.chat_id)
        // The chat is gone; its question is not. A pending interaction suspends
        // the turn ceiling (a person answers at human speed), so leaving it
        // would keep that chat's queue blocked forever — and when the bot is
        // re-added, the first @-mention would be consumed as the answer to a
        // question asked days earlier instead of being a new prompt.
        const orphan = pendings.get(event.chat_id)
        if (orphan !== undefined) {
          try {
            cancelPendingInteraction(orphan)
          } catch (error) {
            /* already settled */
          }
        }
        deferredSwaps.delete(event.chat_id)
        return
      }
    }

    /* ------------------------------------------------------------------ *
     * HTTP ingress (backup transport + local bridge hop)
     * ------------------------------------------------------------------ */
    function sendJson(res, status, payload) {
      let body = '{}'
      try {
        body = JSON.stringify(payload)
      } catch (error) {
        body = '{"ok":false}'
      }
      res.statusCode = status
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(body)
    }

    function readBody(req) {
      return new Promise(function (resolve, reject) {
        let data = ''
        let bytes = 0
        req.setEncoding('utf8')
        req.on('data', function (chunk) {
          bytes += chunk.length
          if (bytes > 4000000) {
            reject(new Error('request body exceeded 4MB'))
            try {
              req.destroy()
            } catch (error) {
              /* already gone */
            }
            return
          }
          data += chunk
        })
        req.on('end', function () {
          resolve(data)
        })
        req.on('error', reject)
      })
    }

    async function sha256Hex(input) {
      const result = await sh("printf '%s' " + quote(input) + ' | openssl dgst -sha256 -r | cut -d" " -f1')
      return result.stdout.trim()
    }

    function binaryToHex(binary) {
      let out = ''
      for (let i = 0; i < binary.length; i += 1) {
        out += ('0' + binary.charCodeAt(i).toString(16)).slice(-2)
      }
      return out
    }

    /** Feishu encrypted callbacks: base64(iv[16] || AES-256-CBC(payload, sha256(encryptKey), iv)). */
    async function decryptPayload(encrypted) {
      const raw = atob(encrypted)
      if (raw.length <= 16) throw new Error('encrypted payload is too short')
      const ivHex = binaryToHex(raw.slice(0, 16))
      const cipherB64 = btoa(raw.slice(16))
      const keyHex = await sha256Hex(config.encryptKey)
      const result = await sh("printf '%s' " + quote(cipherB64) + ' | openssl enc -d -aes-256-cbc -K ' + quote(keyHex) + ' -iv ' + quote(ivHex) + ' -a 2>/dev/null')
      if (result.code !== 0 || result.stdout.trim() === '') throw new Error('openssl decryption failed (is encryptKey correct?)')
      return JSON.parse(result.stdout)
    }

    async function onRequest(req, res) {
      try {
        if (req.method === 'GET') {
          sendJson(res, 200, {
            ok: true,
            plugin: 'feishu-bot',
            transport: config.transport,
            credentials: credentialsPresent(),
            bridge: bridgeStatus(),
            chats: Object.keys(chats).length,
            bot: botInfo,
          })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'POST only' })
          return
        }

        const raw = await readBody(req)
        const bridgeHeader = req.headers['x-dsh-bridge-token']
        const fromBridge = typeof bridgeHeader === 'string' && bridgeHeader !== '' && bridgeHeader === config.bridgeToken

        let payload
        try {
          payload = JSON.parse(raw)
        } catch (error) {
          sendJson(res, 400, { ok: false, error: 'invalid JSON' })
          return
        }

        // 1. URL verification handshake
        if (payload.type === 'url_verification') {
          if (config.verificationToken !== '' && payload.token !== config.verificationToken) {
            sendJson(res, 401, { ok: false, error: 'verification token mismatch' })
            return
          }
          sendJson(res, 200, { challenge: payload.challenge })
          return
        }

        // 2. Encrypted callback
        if (typeof payload.encrypt === 'string') {
          if (config.encryptKey === '') {
            sendJson(res, 503, { ok: false, error: 'encryptKey is not configured' })
            return
          }
          payload = await decryptPayload(payload.encrypt)
        }

        // 3. Authentication for direct Feishu deliveries
        if (!fromBridge) {
          const header = payload.header === undefined ? {} : payload.header
          if (config.verificationToken !== '' && header.token !== config.verificationToken) {
            sendJson(res, 401, { ok: false, error: 'verification token mismatch' })
            return
          }
          const signature = req.headers['x-lark-signature']
          if (typeof signature === 'string' && signature !== '' && config.encryptKey !== '') {
            const timestamp = String(req.headers['x-lark-request-timestamp'] === undefined ? '' : req.headers['x-lark-request-timestamp'])
            const nonce = String(req.headers['x-lark-request-nonce'] === undefined ? '' : req.headers['x-lark-request-nonce'])
            const expected = await sha256Hex(timestamp + nonce + config.encryptKey + raw)
            if (expected !== signature) {
              sendJson(res, 401, { ok: false, error: 'signature mismatch' })
              return
            }
          }
        }

        // 4. Real event
        sendJson(res, 200, { ok: true })
        await handleEvent(payload)
      } catch (error) {
        log('ingress error: ' + describeError(error))
        try {
          sendJson(res, 500, { ok: false, error: describeError(error) })
        } catch (nested) {
          /* response already sent */
        }
      }
    }

    /* ------------------------------------------------------------------ *
     * long-connection bridge supervision
     * ------------------------------------------------------------------ */
    let bridge = null
    let bridgeStartedAt = 0
    let bridgeRestarts = 0
    let bridgeReady = false
    /** True while a startBridge() attempt is in flight, so ticks cannot stack. */
    let bridgeBusy = false
    /** First retry delay, doubling per consecutive failure up to the ceiling. */
    const BRIDGE_RESTART_MS = 15000
    const BRIDGE_RESTART_MAX_MS = 300000
    /** Uptime after which a running bridge is considered recovered. */
    const BRIDGE_HEALTHY_MS = 60000

    function bridgeStatus() {
      if (bridge === null) return { running: false, restarts: bridgeRestarts }
      return { running: bridge.status === 'running', status: bridge.status, exitCode: bridge.exitCode, restarts: bridgeRestarts, since: bridgeStartedAt }
    }

    function bridgeWanted() {
      const transport = config.transport
      return transport === 'ws' || transport === 'both'
    }

    /**
     * Whether the Feishu SDK the bridge imports can be resolved from here.
     *
     * It is a real dependency of this package, so a missing SDK is an
     * incomplete INSTALL, not something to repair by running an installer from
     * inside a plugin while it retries: the version this replaces ran `npm
     * install` once per bridge retry, up to twenty at a time, each taking up to
     * five minutes. The bridge's own error is the honest report; this check
     * only exists to name the command that fixes it.
     */
    function sdkResolvable() {
      try {
        createRequire(import.meta.url).resolve('@larksuiteoapi/node-sdk')
        return true
      } catch (error) {
        log('sdk probe: ' + describeError(error))
        return false
      }
    }

    async function startBridge() {
      if (!bridgeWanted()) {
        log('bridge disabled (transport=' + config.transport + ')')
        return
      }
      if (bridge !== null && bridge.status === 'running') return
      if (!credentialsPresent()) {
        log('bridge not started: appId and appSecret are empty in ' + CONFIG_PATH)
        return
      }
      if (!existsSync(BRIDGE_PATH)) {
        log('bridge script missing at ' + BRIDGE_PATH + ' — reinstall the package to use long-connection mode')
        return
      }
      // A PROBE, never a gate. The bridge is a separate process that resolves
      // the SDK in its own context, so a lookup failing HERE proves nothing —
      // and gating on it stopped a bridge that would have started: a harness
      // process booted before `npm install` created node_modules failed this
      // resolution while a fresh child resolved it fine. The bridge reports its
      // own failure if the module really is missing; this only improves the
      // message, so it must not decide.
      if (!sdkResolvable()) {
        log('note: the Feishu SDK did not resolve from ' + PACKAGE_DIR + ' — starting the bridge anyway, since it resolves its own dependencies and reports the real error if it cannot.')
      }
      const port = webServer === undefined ? 3080 : webServer.port
      const endpoint = 'http://127.0.0.1:' + port + ROUTE
      const spec = shell.resolve({
        command: 'exec node ' + quote(BRIDGE_PATH),
        workdir: DIR,
        env: {
          FEISHU_APP_ID: config.appId,
          FEISHU_APP_SECRET: config.appSecret,
          DSH_FEISHU_ENDPOINT: endpoint,
          DSH_FEISHU_BRIDGE_TOKEN: config.bridgeToken,
        },
      })
      // The spawn belongs INSIDE the effect that owns it. `startBridge` awaits
      // shell probes above, and a reload landing in one of those awaits runs the
      // teardown while `bridge` is still null — nothing to kill — after which
      // this would resume, spawn a child nobody owns and have its `ctx.effect`
      // throw INACTIVE_EFFECT. That child keeps its Feishu connection and keeps
      // posting into the route the NEW instance now serves.
      ctx.effect(function () {
        const bridgeProcess = shell.start(spec)
        bridge = bridgeProcess
        bridgeStartedAt = Date.now()
        bridgeReady = true
        log('bridge started -> ' + endpoint)
        return function () {
          try {
            bridgeProcess.kill()
          } catch (error) {
            /* already gone */
          }
        }
      })
    }

    async function stopBridge() {
      if (bridge === null) return
      try {
        bridge.kill()
      } catch (error) {
        /* already gone */
      }
      bridge = null
    }

    function pumpBridgeOutput() {
      if (bridge === null) return
      try {
        const read = bridge.readOutput()
        if (read !== undefined && typeof read.delta === 'string' && read.delta.trim() !== '') {
          const lines = read.delta.split('\n')
          for (let i = 0; i < lines.length; i += 1) {
            if (lines[i].trim() !== '') log('[bridge] ' + lines[i].trim())
          }
        }
      } catch (error) {
        /* process handle settled */
      }
    }

    /* ------------------------------------------------------------------ *
     * runtime wiring
     * ------------------------------------------------------------------ */
    await loadConfig()
    await loadState()

    if (webServer === undefined) {
      log('webServer is unavailable — HTTP ingress disabled; long connection still works')
    } else {
      ctx.effect(function () {
        return webServer.register({ kind: 'exact', path: ROUTE, handler: onRequest })
      })
      log('HTTP ingress registered at ' + ROUTE + ' on port ' + webServer.port)
    }

    await refreshBotInfo()
    try {
      await startBridge()
    } catch (error) {
      // A bridge that cannot start is the supervisor's problem, not the
      // harness's: throwing here would fail this row, and a failed row fails
      // the WHOLE boot audit (assertEntriesActivated rethrows it). The 3s
      // supervisor below retries with backoff.
      log('bridge did not start at boot: ' + describeError(error) + ' — the supervisor will retry')
    }

    // Supervise: drain bridge output, flush logs, restart a dead bridge.
    ctx.interval(function () {
      pumpBridgeOutput()
      flushLog().catch(function () {
        return undefined
      })
      if (!bridgeWanted()) return
      if (bridgeBusy) return
      if (bridge !== null && bridge.status === 'running') {
        // A bridge that has stayed up for a minute is healthy again: forget the
        // backoff so the next failure starts from the short wait.
        if (bridgeRestarts !== 0 && Date.now() - bridgeStartedAt > BRIDGE_HEALTHY_MS) bridgeRestarts = 0
        return
      }
      if (bridge === null && bridgeReady === false) return
      // Back off. A fixed 15s retry against a failure that takes minutes to
      // resolve (a missing SDK, no network, bad credentials) is a hot loop that
      // piles up attempts; this doubles to a ceiling instead.
      const wait = Math.min(BRIDGE_RESTART_MAX_MS, BRIDGE_RESTART_MS * Math.pow(2, Math.max(0, bridgeRestarts - 1)))
      if (Date.now() - bridgeStartedAt < wait) return
      bridgeRestarts += 1
      log('bridge is not running; restart attempt #' + bridgeRestarts)
      bridge = null
      bridgeBusy = true
      bridgeStartedAt = Date.now()
      // Not awaited: the tick must never block. `bridgeBusy` is what stops the
      // next tick from starting a second attempt while this one is still going.
      startBridge().catch(function (error) {
        log('bridge restart failed: ' + describeError(error))
      }).then(function () {
        bridgeBusy = false
        bridgeStartedAt = Date.now()
      })
    }, 3000)

    ctx.effect(function () {
      return function () {
        // A reload does not cancel work already in flight: `enqueue` is a
        // promise chain, not an effect, so a turn inside processMessage runs to
        // completion on the dead instance. Both flags below exist for it — see
        // `disposed` and `saveState`.
        disposed = true
        // A question this instance was holding can never be answered again: its
        // card, its resolver and this route die together. Settling it here means
        // the reply the user is about to send is a new prompt rather than being
        // swallowed as the answer to a question nobody is waiting for.
        const open = []
        pendings.forEach(function (pending) {
          open.push(pending)
        })
        for (let i = 0; i < open.length; i += 1) {
          try {
            cancelPendingInteraction(open[i])
          } catch (error) {
            /* already settled */
          }
        }
        try {
          if (bridge !== null) bridge.kill()
        } catch (error) {
          /* already gone */
        }
        const handles = []
        liveHandles.forEach(function (handle) {
          handles.push(handle)
        })
        liveHandles.clear()
        for (let i = 0; i < handles.length; i += 1) {
          try {
            handles[i].dispose()
          } catch (error) {
            /* owned by ctx as well */
          }
        }
      }
    })

    /* ------------------------------------------------------------------ *
     * model tool
     * ------------------------------------------------------------------ */
    function summarize() {
      const chatIds = Object.keys(chats)
      const lines = []
      lines.push('transport: ' + config.transport)
      lines.push('credentials: ' + (credentialsPresent() ? 'set (appId ' + redact(config.appId) + ')' : 'MISSING — edit ' + CONFIG_PATH))
      lines.push('bot: ' + (botInfo === null ? 'unknown (credentials not verified)' : botInfo.name + ' / ' + botInfo.openId))
      lines.push('bridge: ' + j(bridgeStatus()))
      lines.push('default workspace: ' + config.workspacePath + '  preset: ' + config.agentPreset + '  permission: ' + config.permissionPreset)
      lines.push('groupRequireMention: ' + config.groupRequireMention + '  replyStyle: ' + config.replyStyle + '  acknowledge: ' + config.acknowledge + '  useReply: ' + config.useReply + '  cardHeader: ' + config.cardHeader + '  replyMetrics: ' + config.replyMetrics)
      lines.push('ingress: http://127.0.0.1:' + (webServer === undefined ? 3080 : webServer.port) + ROUTE)
      lines.push('log file: ' + LOG_PATH)
      lines.push('chats: ' + chatIds.length)
      if (pendings.size > 0) {
        // A chat sitting on an unanswered question looks identical to a hung
        // turn from the outside; this is the line that tells them apart.
        const waiting = []
        pendings.forEach(function (pending, chatId) {
          waiting.push(chatId + ' ' + pending.kind + ' for ' + Math.round((Date.now() - pending.createdAt) / 1000) + 's')
        })
        lines.push('waiting on a human answer: ' + waiting.join(', '))
      }
      for (let i = 0; i < chatIds.length && i < 20; i += 1) {
        const entry = chats[chatIds[i]]
        lines.push('  - ' + chatIds[i] + ' [' + entry.chatType + '] ' + (entry.title === undefined ? '' : entry.title) + ' -> ' + entry.sessionId + ' turns=' + (entry.turns === undefined ? 0 : entry.turns))
        lines.push('      cwd: ' + workspacePathFor(entry) + (isDefaultWorkspace(entry) ? ' (default)' : ' (override)'))
      }
      return lines.join('\n')
    }

    const tool = harness.defineTool({
      name: 'feishu_bot',
      description: 'Control the Feishu/Lark bot bridge.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['status', 'chats', 'workspaces', 'skills', 'sessions', 'native', 'logs', 'send', 'preview', 'workspace', 'configure', 'restart', 'reset'],
          // The enum above already names every action; this line carries only
          // what the names do not say.
          description: 'configure patches config.json with the config fields below; restart reloads config and the bridge; logs reads the tail; native runs a DSH command.',
        },
        chat_id: { type: 'string', description: 'Required for send, preview, native, reset.' },
        file: { type: 'string', description: 'send: local file path; wins over text.' },
        text: { type: 'string', description: 'send: text; preview: markdown; native: a slash line; sessions: index | "new" | "drop <n>".' },
        app_id: { type: 'string' },
        app_secret: { type: 'string' },
        transport: { type: 'string', enum: ['ws', 'webhook', 'both'] },
        agent_preset: { type: 'string' },
        permission_preset: { type: 'string' },
        workspace_path: { type: 'string', description: 'workspace: switch to it; configure: set the default.' },
        group_require_mention: { type: 'boolean' },
        reply_style: { type: 'string', enum: ['card', 'text'] },
        acknowledge: { type: 'boolean' },
        card_header: { type: 'boolean' },
        reply_metrics: { type: 'boolean' },
        limit: { type: 'integer', description: 'logs: max lines.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: true,
          properties: {
            ok: { type: 'boolean', required: true },
            summary: { type: 'string', required: true },
            detail: { type: 'string' },
          },
        },
        render: function (args, value) {
          return [{ type: 'text', text: value.detail === undefined || value.detail === '' ? value.summary : value.summary + '\n\n' + value.detail }]
        },
      },
      async execute(args) {
        const action = args.action
        if (action === 'status') {
          return { ok: true, summary: '飞书机器人状态', detail: summarize() }
        }
        if (action === 'logs') {
          const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(args.limit, 200) : 40
          const tail = logLines.slice(Math.max(0, logLines.length - limit))
          return { ok: true, summary: '最近 ' + tail.length + ' 条日志', detail: tail.join('\n') }
        }
        if (action === 'chats') {
          return { ok: true, summary: '已知会话 ' + Object.keys(chats).length + ' 个', detail: summarize() }
        }
        if (action === 'workspaces') {
          const entry = typeof args.chat_id === 'string' && chats[args.chat_id] !== undefined ? chats[args.chat_id] : undefined
          return { ok: true, summary: '工作区列表', detail: await renderWorkspaceList(entry === undefined ? { workspacePath: config.workspacePath } : entry) }
        }
        if (action === 'skills') {
          const entry = typeof args.chat_id === 'string' && chats[args.chat_id] !== undefined ? chats[args.chat_id] : undefined
          return { ok: true, summary: '技能列表', detail: await renderSkillList(entry === undefined ? { workspacePath: config.workspacePath } : entry) }
        }
        if (action === 'sessions') {
          const chatId = typeof args.chat_id === 'string' ? args.chat_id : ''
          const entry = chatId === '' ? undefined : chats[chatId]
          if (entry === undefined) {
            return { ok: false, summary: 'sessions 需要有效的 chat_id（用 chats 查看）' }
          }
          const line = typeof args.text === 'string' ? args.text.trim() : ''
          try {
            if (line === '') {
              const listing = await chatSessionListing(entry)
              return { ok: true, summary: '会话 ' + listing.rows.length + ' 个（工作区 ' + baseName(workspacePathFor(entry)) + '）', detail: await renderSessionList(entry, listing) }
            }
            if (line === 'new') {
              const fresh = await restartChatSession(chatId, entry)
              await saveState()
              if (fresh === undefined) return { ok: false, summary: '当前会话仍在运行，已排队；下一条消息生效' }
              return { ok: true, summary: '已开新会话：' + fresh }
            }
            if (line.indexOf('drop ') === 0) {
              const index = Number(line.slice(5).trim())
              if (!isFinite(index) || index <= 0) return { ok: false, summary: '用法：text = "drop <序号>"' }
              return { ok: true, summary: await dropRememberedSession(entry, index) }
            }
            const index = Number(line)
            if (!isFinite(index) || index <= 0) return { ok: false, summary: 'text 要么是序号，要么是 "new" / "drop <序号>"' }
            const reply = await switchToSession(chatId, entry, index)
            return { ok: reply.indexOf('✅') === 0, summary: reply, detail: summarize() }
          } catch (error) {
            return { ok: false, summary: 'sessions 失败：' + describeError(error) }
          }
        }
        if (action === 'native') {
          const chatId = typeof args.chat_id === 'string' ? args.chat_id : ''
          const line = typeof args.text === 'string' ? args.text.trim() : ''
          const entry = chatId === '' ? undefined : chats[chatId]
          if (entry === undefined) {
            return { ok: false, summary: 'native 需要有效的 chat_id（用 chats 查看）' }
          }
          const agent = await ensureCommandAgent(entry)
          if (agent === undefined) {
            return { ok: false, summary: '无法为该会话建立 Agent，请看 logs' }
          }
          if (line === '') {
            const list = await listNativeCommands(String(agent.id))
            const detail = list.map(function (command) {
              return '/' + command.name + (command.input === undefined ? '' : ' ' + command.input.hint) + ' — ' + command.description
            }).join('\n')
            return { ok: true, summary: 'DSH 原生命令 ' + list.length + ' 个', detail: detail }
          }
          try {
            const execution = await executeNativeCommand(String(agent.id), line)
            if (execution === undefined || execution === null) return { ok: false, summary: '未知指令：' + line }
            const result = execution.result
            return {
              ok: result.kind === 'success',
              summary: result.kind === 'success' ? line + ' 执行成功' : line + ' 执行失败',
              detail: result.text === undefined ? '(无输出)' : result.text,
            }
          } catch (error) {
            return { ok: false, summary: line + ' 执行异常：' + describeError(error) }
          }
        }
        if (action === 'workspace') {
          const target = typeof args.workspace_path === 'string' ? args.workspace_path.trim() : ''
          const chatId = typeof args.chat_id === 'string' ? args.chat_id : ''
          if (target === '') {
            const entry = chatId !== '' && chats[chatId] !== undefined ? chats[chatId] : undefined
            return { ok: true, summary: '工作区列表', detail: await renderWorkspaceList(entry === undefined ? { workspacePath: config.workspacePath } : entry) }
          }
          const canonical = await canonicalDir(target)
          if (canonical === undefined) {
            return { ok: false, summary: '目录不存在：' + target, detail: await renderWorkspaceList({ workspacePath: config.workspacePath }) }
          }
          if (chatId === '') {
            config.workspacePath = canonical
            await saveConfig()
            await flushLog()
            log('default workspace changed to ' + canonical)
            return { ok: true, summary: '已把默认工作区设为 ' + canonical + '（只影响之后新建的会话；已在跑的会话保持原工作区）' }
          }
          const existing = chats[chatId]
          if (existing === undefined) return { ok: false, summary: '未知 chat_id：' + chatId + '。可用 chats 查看。' }
          // An agent switching a chat to a directory wants a clean context there,
          // not the human's half-finished thread: this path stays fresh.
          const result = await switchWorkspace(chatId, existing, canonical, { fresh: true })
          await flushLog()
          return { ok: result.ok, summary: result.message, detail: summarize() }
        }
        if (action === 'send') {
          if (typeof args.chat_id !== 'string' || args.chat_id === '') return { ok: false, summary: 'send 需要 chat_id' }
          // A file wins over text: sending both in one call is never what was
          // meant, and a document is the more specific request.
          if (typeof args.file === 'string' && args.file.trim() !== '') {
            try {
              return await sendFileToChat(args.chat_id, args.file.trim())
            } catch (error) {
              return { ok: false, summary: '发送文件异常：' + describeError(error) }
            }
          }
          if (typeof args.text !== 'string' || args.text === '') return { ok: false, summary: 'send 需要 text 或 file' }
          try {
            const response = await send(args.chat_id, 'text', textJson(args.text), undefined)
            return {
              ok: response.code === 0,
              summary: response.code === 0 ? '已发送到 ' + args.chat_id : '发送失败 code=' + response.code + ' msg=' + response.msg,
              detail: j(response),
            }
          } catch (error) {
            return { ok: false, summary: '发送异常：' + describeError(error) }
          }
        }
        if (action === 'preview') {
          const previewStartedAt = Date.now()
          const chatId = typeof args.chat_id === 'string' ? args.chat_id : ''
          if (chatId === '') return { ok: false, summary: 'preview 需要 chat_id（用 chats 查看）' }
          const sample = typeof args.text === 'string' && args.text.trim() !== '' ? args.text : PREVIEW_SAMPLE
          const entry = chats[chatId] === undefined ? { workspacePath: config.workspacePath } : chats[chatId]
          const live = svc('agents').get(entry.sessionId)
          if (live !== undefined) seedUsage(live.session)
          const options = { footer: metricsLine(entry.sessionId, previewStartedAt) }
          const elements = cardBody(sample, entry, options).elements
          // Describe the card BEFORE sending it: an exception in this diagnostic
          // must never be reported as a send failure.
          const detail = elements.map(function (element) {
            if (element.tag === 'table') {
              return 'table  columns=' + element.columns.length + ' rows=' + element.rows.length + ' width=' + element.columns.map(function (column) { return column.width }).join('/')
            }
            if (element.tag === 'note') {
              return 'note   ' + element.elements.map(function (part) { return part.content }).join('')
            }
            return element.tag + '  chars=' + String(element.content === undefined ? '' : element.content).length
          }).join('\n')
          try {
            const response = await send(chatId, 'interactive', cardJson(sample, entry, options), undefined)
            if (response.code !== 0) log('preview send failed: ' + j(response))
            await flushLog()
            return {
              ok: response.code === 0,
              summary: response.code === 0 ? '已把示例卡片发到 ' + chatId + '（' + elements.length + ' 个元素）' : '发送失败 code=' + response.code + ' msg=' + response.msg,
              detail: detail,
            }
          } catch (error) {
            return { ok: false, summary: '发送异常：' + describeError(error) }
          }
        }
        if (action === 'configure') {
          const applied = []
          // The bridge child gets appId, appSecret and the endpoint through its
          // ENVIRONMENT at spawn, so a change to any of them has to respawn it.
          let bridgeAffected = false
          if (typeof args.app_id === 'string' && args.app_id !== '') {
            config.appId = args.app_id
            applied.push('appId')
            bridgeAffected = true
          }
          if (typeof args.app_secret === 'string' && args.app_secret !== '') {
            config.appSecret = args.app_secret
            applied.push('appSecret')
            bridgeAffected = true
          }
          if (typeof args.transport === 'string') {
            config.transport = args.transport
            applied.push('transport=' + args.transport)
            bridgeAffected = true
          }
          if (typeof args.agent_preset === 'string') {
            config.agentPreset = args.agent_preset
            applied.push('agentPreset=' + args.agent_preset)
          }
          if (typeof args.permission_preset === 'string') {
            config.permissionPreset = args.permission_preset
            applied.push('permissionPreset=' + args.permission_preset)
          }
          if (typeof args.workspace_path === 'string' && args.workspace_path !== '') {
            config.workspacePath = args.workspace_path
            applied.push('workspacePath=' + args.workspace_path)
          }
          if (typeof args.group_require_mention === 'boolean') {
            config.groupRequireMention = args.group_require_mention
            applied.push('groupRequireMention=' + args.group_require_mention)
          }
          if (typeof args.reply_style === 'string') {
            config.replyStyle = args.reply_style
            applied.push('replyStyle=' + args.reply_style)
          }
          if (typeof args.acknowledge === 'boolean') {
            config.acknowledge = args.acknowledge
            applied.push('acknowledge=' + args.acknowledge)
          }
          if (typeof args.card_header === 'boolean') {
            config.cardHeader = args.card_header
            applied.push('cardHeader=' + args.card_header)
          }
          if (typeof args.reply_metrics === 'boolean') {
            config.replyMetrics = args.reply_metrics
            applied.push('replyMetrics=' + args.reply_metrics)
          }
          if (applied.length === 0) return { ok: false, summary: '没有提供任何要修改的字段' }
          await saveConfig()
          tokenCache = null
          botInfo = null
          if (bridgeAffected) {
            // The supervisor stops SUPERVISING a bridge it no longer wants; it
            // never kills one. So `transport: webhook`, or a new app, would
            // leave the old child running on the old identity — inbound events
            // on one app and outbound calls on another — until an explicit
            // restart. Do that reconciliation here.
            await stopBridge()
            bridgeReady = true
            bridgeRestarts = 0
            try {
              await startBridge()
            } catch (error) {
              log('bridge restart after configure failed: ' + describeError(error))
            }
          }
          const verified = await refreshBotInfo()
          await flushLog()
          return { ok: true, summary: '已更新：' + applied.join(', ') + (verified ? '（凭据校验通过）' : '（凭据未通过校验）'), detail: summarize() }
        }
        if (action === 'restart') {
          await stopBridge()
          bridgeReady = false
          bridgeRestarts = 0
          tokenCache = null
          botInfo = null
          await loadConfig()
          await refreshBotInfo()
          await startBridge()
          // Re-arm the supervisor even when the start bailed out early (no
          // credentials, missing SDK, bridge script gone): those early returns
          // leave bridge === null, and the tick refuses to retry while
          // bridgeReady is false — so one failed restart used to latch every
          // later attempt off for the life of the process.
          bridgeReady = true
          await flushLog()
          return { ok: true, summary: '已重新加载 config.json 并重启长连接桥', detail: summarize() }
        }
        if (action === 'reset') {
          if (typeof args.chat_id !== 'string' || args.chat_id === '') {
            return { ok: false, summary: 'reset 需要 chat_id。可用 chats 查看。' }
          }
          const entry = chats[args.chat_id]
          if (entry === undefined) return { ok: false, summary: '未知 chat_id：' + args.chat_id }
          const swapped = await restartChatSession(args.chat_id, entry)
          await saveState()
          if (swapped === undefined) {
            return {
              ok: true,
              summary: '当前会话正在运行（这条命令就是它发出的），已排队重置；本回合结束后，下一条消息将使用全新会话。',
            }
          }
          return { ok: true, summary: '已重置，新会话：' + entry.sessionId + '\n工作区：' + workspacePathFor(entry) }
        }
        return { ok: false, summary: '未知 action：' + String(action) }
      },
    })
    try {
      harness.registerTool(ctx, tool)
    } catch (error) {
      // Registering the model-facing tool is the LAST step of apply, and a
      // failure here must not cost the whole harness: the boot audit rethrows a
      // failed row's error, so throwing turns "the model cannot drive the bot"
      // into "DSH does not start". The chat bridge below is already running by
      // this point; say what happened and keep it.
      log('could not register the feishu_bot tool: ' + describeError(error) + ' — the chat bridge still works, but the model cannot control it')
    }

    log('feishu-bot ready (transport=' + config.transport + ', route=' + ROUTE + ', credentials=' + (credentialsPresent() ? 'set' : 'missing') + ')')
    await flushLog()
}
