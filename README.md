# dsh-plugin-feishu-bot

A Feishu/Lark ↔ DSH bridge, packaged as a DSH plugin. Every Feishu chat (`chat_id`) is bound to one DSH session: a message becomes an agent turn, and the answer comes back as an interactive card. One plugin row, starts with the harness, no separate daemon.

```
Feishu user ──message──▶ Feishu servers
                              │
                 ┌────────────┴────────────┐
                 │  long connection (ws)    │   request URL (webhook)
                 ▼        default           ▼        fallback
            lib/bridge.mjs ──local HTTP──▶ DSH /feishu/events
                                            │
                                            ▼
                            one DSH session per chat ── one agent turn
                                            │
                                            ▼
                              reply back to Feishu (card / text)
```

The default path is the **long connection**: DSH dials out to Feishu over a WebSocket, so there is no public URL, no tunnel, and no callback address to re-register when the machine's IP changes. The `/feishu/events` HTTP route is registered as well (the bridge posts into it), so moving to a public HTTPS host later is a configuration change, not a code change. Replies always go straight from DSH to the Feishu Open API over HTTPS — the socket only carries inbound events.

Everything the bot says inside the chat (cards, help, errors, session titles) is **Chinese**. This document and the source comments are English.

## What you get

| Capability | Detail |
| --- | --- |
| Chat ↔ session binding | Each chat gets its own DSH session, titled `飞书单聊 <id>` / the group name. Sessions are disposed and persisted on shutdown and resumed with `agents.resume`, so context survives restarts. |
| Cards with real tables | Feishu's markdown component has no table support, so tables are parsed out of the answer and rebuilt as Feishu's native `table` element. Code fences are left alone; up to 5 tables per card, the 6th degrades to aligned code. |
| File delivery | `feishu_bot action: send … file: /abs/path` uploads the file and sends it as a file message (30 MB limit). |
| Slash commands | Bot commands handled by the plugin (see the table below), plus whatever DSH commands the deployment registers, forwarded live. |
| Skills | `/skill` lists, inspects and invokes skills for the current workspace; `userInvocable: false` skills are hidden. |
| Workspace switching | `/ws` lists the DSH workspace registry and switches, continuing the workspace's most recently used session or starting a fresh one. |
| Session switching | `/s` lists this chat's remembered sessions plus the other sessions in the workspace, and makes switching reversible. |
| Human in the loop | `ask_user_question` and permission approvals become cards in the chat; answer with a number or free text. |
| Model-facing tool | `feishu_bot` (13 actions) lets an agent control the bridge: status, logs, chat list, workspace/session switching, sending cards and files, configuration. |
| Long connection | Outbound WebSocket with SDK auto-reconnect plus a supervised child process (restart backoff 15 s → 5 min) and a heartbeat line every 60 s. |

## Install

Not on npm yet — install straight from GitHub, where the repository *is* the package:

```sh
dsh plugin --profile web add github:wang1078564969/dsh-plugin-feishu-bot
```

The package declares `dsh.bundle.patch`, so it joins the profile's bundle layer stack automatically — installing it *is* the installation. No hand-edited composition, no build step (the sources ship as plain ESM). The row id is `feishu-bot`; `dsh --profile web --dump-config` shows it.

git dependencies are pinned to the commit that was resolved, so this is also how you upgrade:

```sh
dsh plugin --profile web update dsh-plugin-feishu-bot   # move to the newest commit on main
dsh plugin --profile web add link:/path/to/dsh-plugin-feishu-bot   # or: a local clone, edits live
```

Uninstall:

```sh
dsh plugin --profile web remove dsh-plugin-feishu-bot
```

> **If the install stops on `ERR_PNPM_IGNORED_BUILDS`** (`Ignored build scripts: protobufjs@…`): your pnpm is 10+ and blocks install scripts by default, which `add` treats as a failure for a *new* package. `protobufjs` is an optional transitive dependency and needs no build script, so answer it once in the profile's `pnpm-workspace.yaml` and re-run the command:
>
> ```yaml
> allowBuilds:
>   protobufjs: false
> ```
>
> A profile created by a `pnpm-workspace.yaml`-aware `dsh` may write the placeholder `protobufjs: set this to true or false` for you — replace it with `false`.

To turn it off without uninstalling, add this to *your profile's own* `cordis.patch.yml` (that layer is applied after every bundle layer):

```yaml
- id: feishu-bot
  disabled: true
```

> Configuration does **not** live on the row. A `config:` block on the `feishu-bot` row is ignored — all settings come from `config.json` in the plugin's data directory. See [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

Requirements: **Node.js >= 20.10**, a DSH profile with the base + web-app bundles (the `web` profile is the normal choice), and a Feishu account that can create an internal app. macOS and Linux only — the plugin drives `curl`, `openssl` and `stat` through the shell service, and Windows is not supported.

## Feishu side

The short version; the click-by-click version is [docs/QUICKSTART.md](docs/QUICKSTART.md):

1. Create an **internal app** (企业自建应用) at <https://open.feishu.cn/app> and note its App ID / App Secret.
2. Add the **Bot** capability.
3. Grant `im:message.p2p_msg:readonly`, `im:message.group_at_msg:readonly`, `im:message:send_as_bot`, `im:resource`, and optionally `im:chat:readonly` (group names).
4. **Event subscription mode = 长连接 / persistent connection** — not a request URL. DSH's web server binds `127.0.0.1`, so Feishu's servers cannot reach it.
5. Subscribe to `im.message.receive_v1` (required) and optionally `im.chat.member.bot.added_v1` / `im.chat.member.bot.deleted_v1`.
6. **Publish a version.** Permissions and event subscriptions do not take effect until a version is published and approved — this is the step most often missed.
7. Put the credentials into `config.json` (data directory below) or run `feishu_bot action: configure app_id: … app_secret: …`, then `feishu_bot action: restart`.

## Verify

```sh
tail -f ~/.dsh/feishu-bot/plugin.log
```

A healthy startup shows:

```
HTTP ingress registered at /feishu/events on port 3080
credentials OK — bot "your bot name" (ou_xxx)
bridge started -> http://127.0.0.1:3080/feishu/events
feishu-bot ready (transport=ws, route=/feishu/events, credentials=set)
[bridge] … bridge up: appId=cli_xxx -> http://127.0.0.1:3080/feishu/events
[bridge] … long connection established
[bridge] … heartbeat {"state":"connected",…}        # every 60 s
```

Or:

```
feishu_bot  action: status        # transport, credentials, bridge, chats, bot identity, ingress URL, pending questions
curl -s http://127.0.0.1:3080/feishu/events    # same JSON status, no credentials needed
```

Then send the bot a message. In the log that is `event im.message.receive_v1` → `turn start chat=… session=… cwd=…` → `turn done chat=… via=… replyChars=…`.

## Talking to the bot

### Bot commands (handled by the plugin)

| Command | What it does |
| --- | --- |
| `/help`, `/?` | Show this list, plus the deployment's currently registered native commands |
| `/skill`, `/skill list` | List the user-invocable skills of the current workspace (index, source, description) |
| `/skill <name\|index>` | Show one skill: description, trigger, resource directory |
| `/skill <name\|index> <task>` | Load the skill into the turn (DSH's standard `<skill_content>` block) and run the task |
| `/ws`, `/workspace`, `/workspaces` | List workspaces with indices, the current one marked `← 当前`, and which session each would continue |
| `/ws <index\|name\|path>` | Switch workspace, continuing **that workspace's most recently used session** |
| `/ws <index\|name\|path> new` | Same switch, but start a fresh session there |
| `/ws default` | Drop this chat's workspace override, back to `config.workspacePath` |
| `/s`, `/sessions`, `/session` | List sessions: this chat's own history first, then the other sessions in the workspace |
| `/s <index>` | Switch to that session and continue from its context |
| `/s new` | Start a fresh session; the current one stays in the list |
| `/s drop <index>` | Forget one list entry (the session itself is not deleted) |
| `/new`, `/reset` | Start a fresh session, same workspace |
| `/status` | Current session id, run state, workspace, transport, preset, turn count, context usage |
| `/stop` | Interrupt the running turn. Handled *before* the per-chat queue, so it is not queued behind the turn it is meant to stop |
| `/cancel` | Cancel the pending question/approval — see below |

Aliases accepted by the same handler: `/skills` = `/skill`; `/workspace`, `/workspaces` = `/ws`; `/sessions`, `/session` = `/s`; `/取消` = `/cancel`; `/?` = `/help`; `list`/`ls` wherever a listing is expected; `n` for `/s new`; `forget` for `/s drop`; `-` for `/ws default`.

### DSH native commands

Any other `/command` is forwarded to the deployment's own command registry and executed on this session; the result comes back verbatim. The list is queried live from that registry on every `/help` and every unknown command, so it follows whatever the deployment has installed — `/compact`, `/permission`, `/plan` and friends if those plugins are present. The plugin never hardcodes them. (In a chat whose session has not been created yet, `/help` says so instead: send any message first.)

Dispatch rules, in order:

1. a bot command above;
2. otherwise a `/name` line goes to the native command registry;
3. if nothing matches, the chat gets "未知指令" plus the available list — an unknown slash line is **never** sent to the model as a prompt;
4. only a first token of exactly `/name` counts as a command, so a path like `/usr/local/bin is dead` still reaches the model as an ordinary message.

### Workspaces and sessions

A DSH session's working directory is fixed at creation, so "change workspace" necessarily means "end this session and adopt one over there". The two commands pick different things:

- `/ws` picks a **workspace** and, by default, continues the session that workspace used most recently (looked up by session-log mtime, 5 s cache, falling back to creation time). Add `new` for a clean context: `/ws 2 new`. It does **not** exclude sessions that are open in the GUI — it marks them `（GUI 里也开着）` instead, because on a normal machine most root sessions of a used workspace are alive in the GUI, and excluding them would mean always starting fresh. The sessions it does exclude: `origin: subagent` sessions, sessions already `feishu-`-prefixed (another chat's), and sessions already adopted by another chat.
- `/s` picks one **specific session** by id and refuses to switch to a session that is currently running a turn elsewhere, because two drivers on one session interleave turns and clear each other's state. It also refuses a session another Feishu chat owns.

Both are scoped to the current chat (the override is written into that chat's `state.json` entry) and both take effect **lazily**: the real DSH session is created or resumed when the next message arrives, so switching a few times does not leave empty sessions behind. If a switch is issued while the turn is still running, it is deferred to the next message rather than tearing down the loop that is executing the request (a log line records `session swap deferred` → `deferred swap applied`); if that turn has already exceeded `timeoutMs`, the escape hatch detaches it without awaiting (`session swap forced …`).

The tool's `workspace` action is deliberately different: switching a chat from an agent always starts a **fresh** session, because an agent moving a chat to a directory wants a clean context, not a half-finished human thread.

### Answering a question or an approval

Two kinds of "stop and ask a human" arrive as cards:

| Source | When | Card |
| --- | --- | --- |
| `ask_user_question` tool | The model needs a choice or a fact it cannot guess | The question, its detail, numbered options |
| Permission approval | A tool call needs more authority than the session's policy allows | `1` allow once / `2` deny, with the tool name and reason |

How to answer:

- **Reply with an index** — `2`. Multi-select accepts `1 3` (space, comma or 、).
- **Reply with text** — anything that does not parse as an index is passed back as the free-text answer.
- **Reply with the option label** — e.g. `方案 B` (case-insensitive).
- **`/cancel`** — cancels the question (the model sees `ASK_CANCELLED`, exactly like the GUI's cancel button); for an approval it counts as **denied** (fail-closed).
- Other commands sent while a question is pending are not consumed as answers; the chat tells you to answer or `/cancel`.

Design points worth knowing: only questions raised by a turn this bot is driving are claimed (`prepend` on the Cordis waterfall, then an `activeTurns` check), so questions from GUI turns still belong to the GUI. A pending answer bypasses the per-chat queue (queueing it behind the turn that is waiting for it would deadlock), and the turn timeout is **suspended** while a human is being asked — a person reads at human speed. Multiple questions are asked one card at a time (`第 1/2 个`), each answered card auto-advances to the next. In a group, a message without an @ is only treated as an answer when it is exactly an index or an option label.

## The model-facing tool: `feishu_bot`

Registered once at deployment scope, so every session can call it and its schema is part of every request. Measured with the repository's own script (`node test/measure-tool-schema.cjs`): **1321 characters, ~330 tokens**.

| Action | Required | What it does |
| --- | --- | --- |
| `status` | — | Transport, credentials, bridge process state, chat count, bot identity, ingress URL, default workspace / preset / permission, chats waiting on a human |
| `chats` | — | Known chats: `chat_id`, type, title, bound session, turn count, cwd |
| `workspaces` | — | Workspace list (optionally as a given `chat_id` sees it) |
| `skills` | — | Skill list (optionally as a given `chat_id` sees it) |
| `sessions` | `chat_id` | List sessions; `text: "3"` switches, `text: "new"` starts a fresh one, `text: "drop 3"` forgets an entry |
| `native` | `chat_id` | `text` = a slash line to run on this session; without `text`, list the deployment's native commands |
| `logs` | — | Tail of the in-memory log ring (`limit`, default 40, max 200) |
| `send` | `chat_id` + `text` or `file` | Send text, or a file (≤ 30 MB). `file` wins over `text` |
| `preview` | `chat_id` | Send a built-in sample card and return the element list it produced (`markdown chars=…`, `table columns=… rows=… width=…`) |
| `workspace` | — | Without `workspace_path`: list. With a path, no `chat_id`: set the **default** workspace (affects new sessions only). With a path and a `chat_id`: switch that chat to a fresh session there |
| `configure` | one field | Patch `config.json` with `app_id`, `app_secret`, `transport`, `agent_preset`, `permission_preset`, `workspace_path`, `group_require_mention`, `reply_style`, `acknowledge`, `card_header`, `reply_metrics` |
| `restart` | — | Reload `config.json`, re-validate credentials, restart the long-connection bridge |
| `reset` | `chat_id` | New session for that chat (equivalent to `/new`, but callable by the model) |

Output is `{ ok, summary, detail? }`. `chat_id` is required for `send`, `preview`, `native` and `reset`; unknown ids are rejected with a pointer to `chats`.

## Replies: cards, tables, metrics

- `replyStyle: card` (default) sends an interactive card; `text` sends plain text.
- With `acknowledge: true`, a `⏳ 已收到，正在处理…` card is posted immediately and **patched in place** into the answer, so a long turn never looks dead.
- The card header shows the bot name and the **current workspace** (the workspace can change with `/ws`, so the card says which one), unless `cardHeader: false`.
- The footer note carries `⏱ duration · 📊 context · ⚡ cache hit`, taken from provider usage (the same numbers as the GUI's context ring), unless `replyMetrics: false`. If the provider does not report cache fields, the `⚡` part is omitted rather than shown as 0%.
- Replies are truncated at `maxReplyChars` (default 6000).
- Delivery degrades instead of failing: `card-update` → `card-update-plain` (tables flattened) → `card` → `card-plain` → `text-fallback`. The `via=` field in the log says which level was used; only if every level fails does it report `Feishu rejected both card and text replies`.
- Non-text messages (images, files, files sent by the user) are answered with `目前只支持文本消息。` — the bridge is text in, text/card/file out.

## Security

**This plugin is remote code execution by design.** A message that reaches the bot starts a real agent turn on the operator's machine, with the operator's tools, files and credentials, in a workspace the chat can change with `/ws`, and with whatever permission policy the deployment gave it. Anyone who can message the bot — a colleague, a group, anyone who finds the app — is driving that machine. Lock it down **before** exposing the bot to a group.

The exact config lines that mitigate it:

```json
{
  "allowedChatIds": ["oc_xxxxxxxxxxxxxxxx"],
  "blockedUserIds": ["ou_xxxxxxxxxxxxxxxx"],
  "groupRequireMention": true,
  "permissionPreset": ""
}
```

| Field | Default | What it does |
| --- | --- | --- |
| `allowedChatIds` | `[]` — **no restriction** | Non-empty turns the bot into an allow-list: messages from any other `chat_id` are ignored outright. Set it. `feishu_bot action: chats` lists the ids. |
| `blockedUserIds` | `[]` | Sender `open_id` / `user_id` deny list. Checked first, before the allow list and the mention check; the same checks guard the out-of-band `/stop` path. |
| `groupRequireMention` | `true` | In groups, only messages that @-mention the bot are processed. Turning it off makes every message in every group the bot is in a potential prompt, and additionally requires Feishu's sensitive `im:message.group_msg` scope. Leave it on unless you mean it. |
| `permissionPreset` | `""` | Empty means **inherit the deployment's own permission policy** — the plugin never widens (or narrows) what the harness was configured to allow just because it was installed. Set `read-only` or `workspace-write` to cap what chat-driven sessions may do; with a policy that triggers approvals, the approval card appears in the chat and waits for `1`/`2`. |

Other exposure to keep in mind:

- The HTTP route `/feishu/events` is registered on the DSH web server (`127.0.0.1` by default). Events that arrive **through the local bridge** are authenticated by an auto-generated `bridgeToken`. Events delivered **directly** (webhook mode) are only checked against `verificationToken` when it is non-empty — so if you ever expose that route publicly, set `verificationToken`, and `encryptKey` if you enable event encryption.
- `config.json` contains the app secret and is written with `umask 077` (owner-only). Keep the data directory out of version control and out of shared backups.
- One installation = one Feishu app = one data directory. Do not run two instances against the same data directory, and do not run the composition row and a dynamic Cordis package of the same plugin at once: they fight over one long connection and one `/feishu/events` route, and the symptom is replies delivered into the wrong chat.
- The bot is not a multi-tenant service. There is no per-user authorisation, no rate limiting, and no audit log beyond `plugin.log`.

## Files on disk

Data directory precedence (resolved once, at import time):

| Order | Location |
| --- | --- |
| 1 | `$DSH_FEISHU_DATA` |
| 2 | `$DSH_HOME/feishu-bot` |
| 3 | `$DSH_HOME/.feishu-bot` — an older layout, **adopted once** by copying `config.json`, `state.json` and `plugin.log` into `$DSH_HOME/feishu-bot` |
| 4 | `$DSH_HOME/feishu-bot` (created) |

`$DSH_HOME` defaults to `~/.dsh`, as in the harness itself.

| File | Content |
| --- | --- |
| `config.json` | Settings. **Only values that differ from the built-in defaults are written back**, so a later change to a default still takes effect on an existing installation. Delete a key to return it to the default. |
| `state.json` | `chat_id` → DSH session mapping plus each chat's remembered sessions. |
| `plugin.log` | Append-only log, rotated at 1 MB keeping the last 200 lines. |

Environment variables the plugin reads: `DSH_HOME` and `DSH_FEISHU_DATA`, and nothing else. **There is no environment-variable override for the credentials** — `appId` / `appSecret` live in `config.json` (or are written there by `feishu_bot action: configure`).

## Documentation

| Document | Content |
| --- | --- |
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | Feishu console click-by-click, scopes, install, credentials, first message (Chinese) |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Every `config.json` field: type, default, effect, when to change (Chinese) |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Symptom → cause → fix, with the exact log lines to look for (Chinese) |
| [config.example.json](config.example.json) | Complete configuration template with placeholders |

## Known limits

- **Feishu (China) only.** The Open API base is hardcoded to `https://open.feishu.cn/open-apis`, and the long connection uses the Feishu endpoint; international Lark (`open.larksuite.com`) is not supported without a code change.
- **macOS / Linux only.** `curl`, `openssl`, `stat`, `wc` and POSIX shell syntax are used through the shell service. Windows is not supported.
- **Text in, text/card/file out.** Non-text inbound messages get a fixed reply; there is no image or file understanding.
- **One operator, one app.** No multi-tenancy, no per-user permissions, no hosted variant.
- **The webhook transport needs a public HTTPS URL.** It exists as a fallback; on a laptop, use the default `ws` transport.
- The chat-facing strings, session titles and card text are Chinese; there is no locale switch.
