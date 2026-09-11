# dsh-plugin-feishu-bot

把飞书 / Lark 接到 DSH 的桥，打包成一个 DSH 插件。每个飞书会话（`chat_id`）绑定一个 DSH 会话：一条消息就是一轮 agent 回合，回答以交互卡片发回飞书。就是一个插件行，随 DSH 启动，没有额外的常驻服务。

```
飞书用户 ──消息──▶ 飞书服务器
                      │
         ┌────────────┴────────────┐
         │  长连接（ws，默认）      │   请求地址（webhook，备）
         ▼                         ▼
    lib/bridge.mjs ──本地 HTTP──▶ DSH /feishu/events
                                    │
                                    ▼
                    每个飞书会话一个 DSH 会话 ── 跑一轮
                                    │
                                    ▼
                      回复发回飞书（卡片 / 文本）
```

主链路是**长连接**：DSH 主动外连飞书，不需要公网地址、不需要隧道，换网络 / 换 IP 也不用去开放平台改回调地址。`/feishu/events` 这条 HTTP 路由也一并注册（长连接桥就是往这里回灌事件的），所以将来把 DSH 搬到有公网 HTTPS 的机器上，改成「请求地址」模式即可，不用改代码。回复始终由 DSH 直接调飞书 Open API 发出——那条 socket 只承载入站事件。

机器人在聊天里说的话（卡片、帮助、报错、会话标题）都是中文。

## 你能得到什么

| 能力 | 说明 |
| --- | --- |
| 聊天 ↔ 会话绑定 | 每个聊天一个独立的 DSH 会话，标题形如 `飞书单聊 <id>` 或群名。DSH 退出时会话被正常 dispose 并落盘，下次消息用 `agents.resume` 接着聊，上下文不丢。 |
| 卡片里的真表格 | 飞书的 markdown 组件不支持表格，所以回复里的表格会被解析出来、重建为飞书原生 `table` 元素。围栏代码块里的表格不动（那是内容，不是排版）；一张卡片最多 5 个表格，第 6 个起降级成等宽对齐的代码块。 |
| 发文件 | `feishu_bot action: send … file: /abs/path`：上传后作为文件消息发出（上限 30 MB）。 |
| 斜杠指令 | 插件自带一组机器人指令（见下表），其余 `/xxx` 实时转发给部署自己的命令注册表。 |
| 技能 | `/skill` 列出、查看、直接调用当前工作区的技能；声明 `userInvocable: false` 的技能会被隐藏。 |
| 切工作区 | `/ws` 列出 DSH 的工作区注册表并切换，默认接着那个工作区最近用过的会话，也可以开新的。 |
| 切会话 | `/s` 列出本聊天的历史会话以及工作区里其它 DSH 会话，让「换会话」变成可逆的。 |
| 人机确认 | `ask_user_question` 与权限审批都会变成聊天里的一张卡；回序号或直接回文字即可。 |
| 给模型用的工具 | `feishu_bot`（13 个 action）：状态、日志、聊天列表、切工作区 / 切会话、发卡片和文件、改配置。 |
| 长连接 | 外连 WebSocket，SDK 自动重连，外加受监管的子进程（重启退避 15 秒 → 5 分钟）和每 60 秒一行心跳。 |

## 安装

还没发到 npm，**直接从 GitHub 装**——这个仓库本身就是包：

```sh
dsh plugin --profile web add github:wang1078564969/dsh-plugin-feishu-bot
```

这个包在 `package.json` 里声明了 `dsh.bundle.patch`，会被自动加进该 profile 的 bundle 层栈——**装完就是装完**，不用手工编辑任何 composition，也没有构建步骤（源码就是最终产物，纯 ESM）。行 id 是 `feishu-bot`，用 `dsh --profile web --dump-config` 能看到它。

git 依赖会被锁定到解析出来的那个 commit，所以升级也是同一条命令的另一种形式：

```sh
dsh plugin --profile web update dsh-plugin-feishu-bot   # 跟到 main 上最新的 commit
dsh plugin --profile web add link:/path/to/dsh-plugin-feishu-bot   # 或者：本地克隆，改代码即时生效
```

卸载：

```sh
dsh plugin --profile web remove dsh-plugin-feishu-bot
```

> **如果安装报 `ERR_PNPM_IGNORED_BUILDS`**（`Ignored build scripts: protobufjs@…`）：pnpm 10+ 默认拦下依赖的安装脚本，而 `add` 把「有一个新包被拦」当成失败。`protobufjs` 是个可选传递依赖，本来也不需要跑构建脚本，所以在该 profile 的 `pnpm-workspace.yaml` 里回答一次，然后重跑那条命令：
>
> ```yaml
> allowBuilds:
>   protobufjs: false
> ```
>
> 有些版本的 `dsh` 会替你写一行占位 `protobufjs: set this to true or false`，把它改成 `false` 即可。

只想临时关掉、不卸载：在**你自己 profile 的** `cordis.patch.yml` 里加（这一层在所有 bundle 层之后应用）：

```yaml
- id: feishu-bot
  disabled: true
```

> 配置**不在这行上**。给 `feishu-bot` 行写 `config:` 是无效的——全部设置都来自数据目录下的 `config.json`。见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)。

环境要求：**Node.js >= 20.10**、一个装了 base + web-app bundle 的 DSH profile（通常就是 `web`）、一个能创建企业自建应用的飞书账号。**只支持 macOS 与 Linux**：插件通过 shell 服务调用 `curl`、`openssl`、`stat` 等 POSIX 工具，不支持 Windows。

## 飞书那一侧

简版如下，逐步点击的版本见 [docs/QUICKSTART.md](docs/QUICKSTART.md)：

1. 在 <https://open.feishu.cn/app> 创建**企业自建应用**，记下 App ID / App Secret；
2. 添加 **机器人**能力；
3. 开通 `im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、`im:message:send_as_bot`、`im:resource`，可选 `im:chat:readonly`（读群名）；
4. **事件订阅方式 = 长连接**，不是「请求地址」。DSH 的 Web 服务只监听 `127.0.0.1`，飞书的服务器够不到；
5. 订阅 `im.message.receive_v1`（必需），可选 `im.chat.member.bot.added_v1` / `im.chat.member.bot.deleted_v1`；
6. **发布版本**。权限和事件订阅不发布版本不生效——这是最常漏的一步；
7. 把凭据写进 `config.json`（位置见下），或执行 `feishu_bot action: configure app_id: … app_secret: …`，然后 `feishu_bot action: restart`。

## 验证

```sh
tail -f ~/.dsh/feishu-bot/plugin.log
```

健康启动时依次出现：

```
HTTP ingress registered at /feishu/events on port 3080
credentials OK — bot "机器人名字" (ou_xxx)
bridge started -> http://127.0.0.1:3080/feishu/events
feishu-bot ready (transport=ws, route=/feishu/events, credentials=set)
[bridge] … bridge up: appId=cli_xxx -> http://127.0.0.1:3080/feishu/events
[bridge] … long connection established
[bridge] … heartbeat {"state":"connected",…}        # 每 60 秒一行
```

或者：

```
feishu_bot  action: status        # 传输方式、凭据、桥状态、聊天数、机器人身份、入站地址、待回答问题
curl -s http://127.0.0.1:3080/feishu/events    # 同一份 JSON 状态，不需要凭据
```

然后给机器人发一句话。日志里对应 `event im.message.receive_v1` → `turn start chat=… session=… cwd=…` → `turn done chat=… via=… replyChars=…`。

## 在飞书里怎么用

### 机器人指令（插件自己处理）

| 指令 | 作用 |
| --- | --- |
| `/help`、`/?` | 显示这份清单，外加当前部署实际注册的原生命令 |
| `/skill`、`/skill list` | 列出当前工作区里用户可调用的技能（序号、来源、描述） |
| `/skill <名称\|序号>` | 只看技能详情：描述、触发条件、资源目录 |
| `/skill <名称\|序号> <任务>` | 把技能加载进这一轮（DSH 标准的 `<skill_content>` 块）并完成任务 |
| `/ws`、`/workspace`、`/workspaces` | 列出所有工作区（带序号，当前那个标 `← 当前`，并显示每个工作区会接着哪次会话） |
| `/ws <序号\|名称\|路径>` | 切过去，**默认接着该工作区最近用过的会话** |
| `/ws <序号\|名称\|路径> new` | 同一个切换，但从零开一个新会话 |
| `/ws default` | 撤销本会话的工作区覆盖，回到 `config.workspacePath` |
| `/s`、`/sessions`、`/session` | 列出会话：本聊天自己的历史会话排前面，后面是工作区里其它 DSH 会话 |
| `/s <序号>` | 切到那个会话，带着它的上下文继续 |
| `/s new` | 开一个新会话；当前这个留在列表里，以后能切回来 |
| `/s drop <序号>` | 从列表里去掉一条记录（**不删**会话本身） |
| `/new`、`/reset` | 开启全新会话，工作区不变 |
| `/status` | 当前会话 ID、运行状态、工作区、传输方式、preset、累计轮次、上下文占用 |
| `/stop` | 中断正在执行的任务。它在入队**之前**就被处理，不会排在它要中断的那一轮后面 |
| `/cancel` | 取消当前挂着的提问 / 审批，见下 |

同一个处理函数接受的别名：`/skills` = `/skill`；`/workspace`、`/workspaces` = `/ws`；`/sessions`、`/session` = `/s`；`/取消` = `/cancel`；`/?` = `/help`；需要列表的地方都接受 `list` / `ls`；`/s new` 也可写 `n`；`/s drop` 也可写 `forget`；`/ws default` 也可写 `-`。

### DSH 原生命令

其他 `/xxx` 会转发给部署自己的命令注册表，在本会话上执行，结果原样回给你。这个清单是**实时查询**的，每次 `/help` 和每次未知指令都会重查，所以部署里新增或删除命令插件，飞书这边自动跟着变，插件不硬编码任何一个。部署装了哪些（`/compact`、`/permission`、`/plan` 之类）就转发哪些。新聊天还没建立会话时，`/help` 里的原生命令会显示「本会话尚未建立，先随便发一条消息即可使用」——先发一条消息即可。

分派规则，按顺序：

1. 先匹配上表里的机器人指令；
2. 剩下的 `/name` 交给 DSH 原生命令注册表；
3. 都匹配不到就回「未知指令」并列出可用清单——未知的斜杠行**不会**当普通消息发给模型；
4. 只有首段恰好是 `/name` 才算命令，所以你发 `/usr/local/bin 挂了` 这类含多层斜杠的路径，仍然会正常作为消息送给模型。

### 工作区与会话

DSH 会话的工作目录（`SessionHeader.cwd`）创建后就不可变，所以「切工作区」必然是「结束当前会话 + 换到那边的一个会话」。两个指令选的东西不同：

- `/ws` 选的是**工作区**，默认接着那个工作区**最近用过**的会话（按会话日志文件的 mtime 排，5 秒缓存，stat 失败就退回创建时间）。想要干净上下文就加 `new`：`/ws 2 new`。它**不排除**在 GUI 里开着的会话，而是标上 `（GUI 里也开着）`——本机上常用工作区的根会话几乎都活在 GUI 里，排除掉等于永远开新会话。真正排除的是三类：`origin: subagent` 的子代理会话、id 以 `feishu-` 开头（属于**别的飞书聊天**）的会话、以及已经被另一个聊天 `/s` 占用的会话。
- `/s` 选的是**某一个具体会话**（会话 ID 级），并且**拒绝**切到别处正在跑一个回合的会话——两边同时驱动会让回合交叉、互相打断。它也拒绝另一个飞书聊天已经绑定的会话。

两者的作用域都是**当前这个飞书聊天**（覆盖写进该聊天的 `state.json` 条目），而且都是**惰性生效**：真正的 DSH 会话在你下一条消息进来时才建立或恢复，所以连切几次不会产生一堆空会话。如果切换发生在某一轮还在跑的时候，会被**排队**到这一轮结束（日志 `session swap deferred` → `deferred swap applied`），而不是立刻销毁正在执行这个工具调用的循环；如果那一轮已经超过 `timeoutMs` 还没结束，会走逃生口（`session swap forced …`）。

工具的 `workspace` 动作是**故意不同**的：agent 把聊天切到某个目录时总是开一个**干净的新会话**——人要的是「回去接着聊」，agent 要的是「在那个目录里干净地干活」。

### 回答提问与审批

两类「停下来等人拍板」的操作都会变成卡片：

| 来自 | 什么时候出现 | 卡片 |
| --- | --- | --- |
| `ask_user_question` 工具 | 模型需要你选一个选项、或补一句它猜不到的信息 | 问题 + 详情 + 编号选项 |
| 权限审批 | 工具调用要求的权限超出该会话的策略 | `1` 允许一次 / `2` 拒绝，附工具名与原因 |

怎么回答：

- **回复序号**：`2`；多选可以 `1 3`（空格、逗号、顿号都行）；
- **直接回文字**：不作为序号解析时，整段文字原样当作「其它」答案回传给模型；
- **回复选项原文**：`方案 B` 这种也行（忽略大小写）；
- **`/cancel`**：取消这次提问（模型收到 `ASK_CANCELLED`，和 Web GUI 里点取消一致）；审批则按**拒绝**处理（fail-closed）。
- 提问挂着时发别的指令**不会**被当成答案，聊天里会提示你先回答或 `/cancel`。

几个值得知道的设计：只有**本机器人自己驱动的那一轮**提出的问题才会被飞书接走（在 Cordis waterfall 上 `prepend`，再按 `activeTurns` 认领），所以 GUI 里跑出来的问题仍然归 GUI；回答绕过按聊天串行的队列（排进去就等于等那个正在等它的回合结束，死锁）；提问期间**不触发超时**（日志 `turn timeout held: chat is waiting on a human answer`）——人是按人的速度读的。一次问多个问题时一张卡问一个（标题带 `第 1/2 个`），答完自动发下一张。群聊里没 @ 机器人的消息，只有在恰好是一个序号或选项原文时才当作答案。

## 给模型用的工具：`feishu_bot`

注册在**部署级**（每个会话都能调用，schema 出现在每一次请求里）。用仓库自带的脚本量（`node test/measure-tool-schema.cjs`）：**1321 字符，约 330 token**。

| action | 必填 | 作用 |
| --- | --- | --- |
| `status` | — | 传输方式、凭据、桥进程状态、已知聊天数、机器人身份、入站地址、默认工作区 / preset / 权限档位、正在等人回答的聊天 |
| `chats` | — | 已知聊天：`chat_id`、类型、标题、绑定的会话、轮次、cwd |
| `workspaces` | — | 工作区列表（可带 `chat_id`，按那个会话的视角） |
| `skills` | — | 技能列表（同上） |
| `sessions` | `chat_id` | 列出会话；`text: "3"` 切换、`text: "new"` 新建、`text: "drop 3"` 忘掉一条 |
| `native` | `chat_id` | `text` = 要在这个会话上执行的斜杠行；不带 `text` 则列出部署注册的原生命令 |
| `logs` | — | 内存日志环的尾部（`limit` 默认 40，最大 200） |
| `send` | `chat_id` + `text` 或 `file` | 发文本，或发文件（≤ 30 MB）。同一个调用里 `file` 优先于 `text` |
| `preview` | `chat_id` | 把内置示例卡发到聊天，并返回它实际生成的元素清单（`markdown chars=…`、`table columns=… rows=… width=…`） |
| `workspace` | — | 不带 `workspace_path`：列列表；带路径、不带 `chat_id`：改**默认**工作区（只影响之后的新会话）；带路径和 `chat_id`：把那个聊天切到该目录下一个干净的新会话 |
| `configure` | 至少一个字段 | 写入 `config.json`：`app_id`、`app_secret`、`transport`、`agent_preset`、`permission_preset`、`workspace_path`、`group_require_mention`、`reply_style`、`acknowledge`、`card_header`、`reply_metrics` |
| `restart` | — | 重新读 `config.json`、重新校验凭据、重启长连接桥 |
| `reset` | `chat_id` | 给那个聊天开新会话（等同 `/new`，但由模型发起） |

返回值是 `{ ok, summary, detail? }`。`chat_id` 对 `send`、`preview`、`native`、`reset` 是必填；填了未知 id 会被拒绝并提示先用 `chats` 查。

## 回复：卡片、表格、指标

- `replyStyle: card`（默认）发交互卡片；`text` 发纯文本。
- `acknowledge: true`（默认）会先发一张 `⏳ 已收到，正在处理…`，答完后**原地改写**成答案，所以一轮跑很久也不会看起来像死了。
- 卡片标题栏显示机器人名和**当前工作区**（`/ws` 能随时换目录，写清楚免得看串）；`cardHeader: false` 关掉。
- 底部灰字是 `⏱ 耗时 · 📊 上下文 · ⚡ 缓存命中`，数字取自 provider 上报的 usage，和 GUI 输入框旁边那个上下文环同源；`replyMetrics: false` 关掉。provider 不上报缓存字段时**整段 `⚡` 不显示**，而不是谎报 0%。
- 回复按 `maxReplyChars`（默认 6000）截断。
- 发送是一条降级链，而不是直接失败：`card-update` → `card-update-plain`（表格拍平）→ `card` → `card-plain` → `text-fallback`。日志里的 `via=` 就是实际走的那一级；全都失败才会报 `Feishu rejected both card and text replies`。
- 非文本消息（图片、文件、用户发的文件）会收到一句 `目前只支持文本消息。`——这个桥是文本进，文本 / 卡片 / 文件出。

## 安全

**这个插件在设计上就是「远程代码执行」。** 一条能到达机器人的消息，会在**操作者的机器上**跑起一轮真正的 agent：用操作者的工具、文件和凭据，在工作区里干活（而工作区可以用 `/ws` 换），权限上限是部署配的那一档。任何能给机器人发消息的人——同事、群里的成员、任何找到这个应用的人——都在驱动这台机器。**在把机器人暴露到群里之前，先把它锁上。**

起作用的配置就这么几行：

```json
{
  "allowedChatIds": ["oc_xxxxxxxxxxxxxxxx"],
  "blockedUserIds": ["ou_xxxxxxxxxxxxxxxx"],
  "groupRequireMention": true,
  "permissionPreset": ""
}
```

| 字段 | 默认 | 作用 |
| --- | --- | --- |
| `allowedChatIds` | `[]`——**不限制** | 非空即变成允许列表：其它 `chat_id` 的消息完全忽略。请务必设置。id 用 `feishu_bot action: chats` 查。 |
| `blockedUserIds` | `[]` | 发送者 `open_id` / `user_id` 拒绝列表。优先级最高，在允许列表和 @ 判断之前生效；同一条准入检查也守着绕队列的 `/stop` 路径。 |
| `groupRequireMention` | `true` | 群聊里只处理 @ 了机器人的消息。关掉它等于机器人所在的每个群里、每个人的每句话都是潜在 prompt，而且还需要飞书那边额外开通敏感权限 `im:message.group_msg`。不是真想清楚就别关。 |
| `permissionPreset` | `""` | 空 = **完全沿用部署自己的权限策略**，插件不会因为被装上就放宽（也不会收紧）harness 配好的权限。设成 `read-only` 或 `workspace-write` 可以给聊天驱动的会话加个上限；设成会触发审批的档位时，审批卡会出现在聊天里等你回 `1`/`2`。 |

其它需要留意的暴露面：

- HTTP 路由 `/feishu/events` 注册在 DSH 的 Web 服务上（默认只监听 `127.0.0.1`）。**经过本地桥**进来的事件由自动生成的 `bridgeToken` 认证；**直连**进来的事件只在 `verificationToken` 非空时才校验——所以真要把这条路由暴露到公网，请设 `verificationToken`，开了事件加密就再设 `encryptKey`。
- `config.json` 里有 App Secret，文件以 `umask 077`（仅属主）写入。数据目录不要放进版本库，也不要放进共享备份。
- 一个安装 = 一个飞书应用 = 一个数据目录。不要让两个实例共用同一个数据目录，也不要同时开 composition 行和同一个插件的动态 Cordis 包：它们会抢同一条飞书长连接和同一个 `/feishu/events` 路由，症状是回复投递到错误的聊天。
- 它不是多租户服务：没有按用户授权、没有限流，除了 `plugin.log` 也没有审计日志。

## 磁盘上的文件

数据目录的优先级（在模块导入时解析一次）：

| 顺序 | 位置 |
| --- | --- |
| 1 | `$DSH_FEISHU_DATA` |
| 2 | `$DSH_HOME/feishu-bot` |
| 3 | `$DSH_HOME/.feishu-bot`——旧布局，会**被采纳一次**：把 `config.json`、`state.json`、`plugin.log` 复制到 `$DSH_HOME/feishu-bot` |
| 4 | `$DSH_HOME/feishu-bot`（新建） |

`$DSH_HOME` 未设置时是 `~/.dsh`，与 harness 自身一致。

| 文件 | 内容 |
| --- | --- |
| `config.json` | 全部设置。**只写与内置默认值不同的键**，所以升级后改默认值仍然对你生效。把某个键删掉即可恢复默认值。 |
| `state.json` | `chat_id` → DSH 会话的映射，以及每个聊天记住的历史会话。 |
| `plugin.log` | 追加写的日志，超过 1 MB 轮转并保留最近 200 行。 |

插件读的环境变量只有 `DSH_HOME` 和 `DSH_FEISHU_DATA`，别的都不读。**凭据没有任何环境变量覆盖**——`appId` / `appSecret` 只存在于 `config.json`（或者由 `feishu_bot action: configure` 写进去）。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | 从创建飞书应用到发出第一条消息，含开放平台的逐步点击、权限清单与验证方法 |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | `config.json` 每个字段：类型、默认值、作用、什么时候改 |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | 现象 → 原因 → 处置，附该看哪一行日志 |
| [config.example.json](config.example.json) | 带占位值的完整配置模板 |

## 已知限制

- **只支持飞书（国内版）。** Open API 基地址硬编码为 `https://open.feishu.cn/open-apis`，长连接也走飞书端点；国际版 Lark（`open.larksuite.com`）需要改代码才能用。
- **只支持 macOS / Linux。** 通过 shell 服务使用 `curl`、`openssl`、`stat`、`wc` 和 POSIX shell 语法，不支持 Windows。
- **文本进，文本 / 卡片 / 文件出。** 非文本入站消息只能收到一句固定回复，没有图片或文件理解。
- **一个操作者、一个应用。** 没有多租户、没有按用户权限、没有托管版本。
- **webhook 传输需要公网 HTTPS 地址。** 它只是备用；在笔记本上用默认的 `ws`。
- 聊天里的文案、会话标题和卡片都是中文，没有语言开关。
