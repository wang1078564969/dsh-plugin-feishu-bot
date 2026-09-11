/**
 * Feishu / Lark long-connection (WebSocket) inbound bridge.
 *
 * Why this process exists
 * -----------------------
 * The DSH web server binds 127.0.0.1 only, so Feishu's servers cannot POST events
 * to it. In long-connection mode the DSH side dials OUT to Feishu instead, and
 * Feishu pushes events down that socket. No public URL, no tunnel, no callback
 * address to re-register when your laptop's IP changes.
 *
 * The official SDK owns the wire protocol (protobuf framing, handshake, ping,
 * reconnect); this file is deliberately a dumb pipe:
 *
 *   Feishu  --WS-->  bridge.mjs  --local HTTP POST-->  DSH  /feishu/events
 *
 * All bot logic (session routing, the agent turn, replies) lives in the DSH
 * Cordis plugin, so this bridge never needs to change when the bot changes.
 * Replies go straight from DSH to the Feishu Open API over HTTPS — the socket
 * only ever carries inbound events.
 *
 * Configuration is entirely environment-driven; see config.json in this folder.
 */

import * as lark from '@larksuiteoapi/node-sdk'

const appId = process.env.FEISHU_APP_ID ?? ''
const appSecret = process.env.FEISHU_APP_SECRET ?? ''
const endpoint = process.env.DSH_FEISHU_ENDPOINT ?? ''
const bridgeToken = process.env.DSH_FEISHU_BRIDGE_TOKEN ?? ''

/** Event types forwarded to DSH. Anything unlisted is dropped at the socket. */
const EVENT_TYPES = [
  'im.message.receive_v1',
  'im.message.reaction.created_v1',
  'im.chat.member.bot.added_v1',
  'im.chat.member.bot.deleted_v1',
  'im.chat.updated_v1',
]

function log(...args) {
  console.log(`[bridge] ${new Date().toISOString()}`, ...args)
}

if (!appId || !appSecret) {
  log('FATAL: FEISHU_APP_ID and FEISHU_APP_SECRET are required')
  process.exit(2)
}
if (!endpoint) {
  log('FATAL: DSH_FEISHU_ENDPOINT is required')
  process.exit(2)
}

/** Forward one event to the DSH plugin. Never throws: a dead DSH must not kill the socket. */
async function forward(eventType, data) {
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-dsh-bridge-token': bridgeToken,
      },
      body: JSON.stringify({
        via: 'ws-bridge',
        header: { event_type: eventType, create_time: String(Date.now()) },
        event: data,
      }),
    })
    if (!response.ok) {
      log(`forward ${eventType} -> HTTP ${response.status}`)
    } else {
      log(`forward ${eventType} -> ok`)
    }
  } catch (error) {
    log(`forward ${eventType} failed: ${error?.message ?? String(error)}`)
  }
}

const handlers = {}
for (const type of EVENT_TYPES) {
  handlers[type] = async (data) => {
    await forward(type, data)
  }
}

// The SDK validates this token when the app is configured for it; an empty
// dispatcher option is correct for long-connection mode, where the socket is
// already authenticated by app credentials and never carries a public request.
const dispatcher = new lark.EventDispatcher({}).register(handlers)

const wsClient = new lark.WSClient({
  appId,
  appSecret,
  loggerLevel: lark.LoggerLevel.info,
  autoReconnect: true,
  onReady: () => log('long connection established'),
  onReconnecting: () => log('reconnecting…'),
  onReconnected: () => log('reconnected'),
  onError: (error) => log(`error: ${error?.message ?? String(error)}`),
})

await wsClient.start({ eventDispatcher: dispatcher })
log(`bridge up: appId=${appId} -> ${endpoint}`)
log('Reminder: 开发者后台 → 事件与回调 → 订阅方式 must be 长连接 / persistent connection.')

// Periodic liveness line so the DSH plugin can surface connection state in its logs.
const heartbeat = setInterval(() => {
  try {
    log(`heartbeat ${JSON.stringify(wsClient.getConnectionStatus())}`)
  } catch {
    /* status is best-effort */
  }
}, 60_000)
heartbeat.unref?.()

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    log(`${signal} received, closing`)
    try {
      wsClient.close({ force: true })
    } catch {
      /* already gone */
    }
    process.exit(0)
  })
}
