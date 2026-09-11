# 快速开始

从零到一个能用的机器人：创建飞书应用 → 装插件 → 填凭据 → 在飞书里发第一条消息。全程大约 15 分钟，其中大半时间花在等开放平台发布版本的审核上。

约定：命令里的 `<profile>` 换成你实际用的 profile 名（本文一律用官方示例里的 `web`）。

---

## 0. 先确认前提

| 前提 | 怎么确认 |
| --- | --- |
| Node.js >= 20.10 | `node -v` |
| DSH，且有一个装了 base + web-app bundle 的 profile | `dsh --profile web --dump-config \| head` |
| 操作系统是 macOS 或 Linux | 插件通过 POSIX shell 调 `curl` / `openssl` / `stat`，**Windows 不受支持** |
| 一个飞书账号，且能在开发者后台创建**企业自建应用** | 打开 <https://open.feishu.cn/app> 能看到「创建企业自建应用」 |
| 发布版本需要管理员审核 | 没有审核权限的话，找人帮忙点通过 |

> 插件的 HTTP 调用固定在 `https://open.feishu.cn/open-apis`，长连接也走飞书（国内版）端点。国际版 Lark（`open.larksuite.com`）不在支持范围内，除非改代码。

---

## 1. 创建飞书自建应用

1. 打开开发者后台 <https://open.feishu.cn/app>；
2. **创建企业自建应用**：填名称（这个名字会出现在机器人头像旁边，也会出现在每条卡片的标题栏里）、图标、描述；
3. 进入应用 → **凭证与基础信息**，记下两样东西：
   - `App ID`（形如 `cli_xxxxxxxxxxxxxxxx`）
   - `App Secret`（点显示后复制）

   App Secret 等同于这个机器人的完整控制权，别贴进任何会被提交的地方。

---

## 2. 添加机器人能力

应用 → **添加应用能力** → 找到 **机器人** → 添加。

不加这一步，后面既收不到消息也发不出去。

---

## 3. 开通权限

应用 → **权限管理** → 搜索下面这些 scope 标识（或按中文名搜）并开通：

| 权限（scope） | 为什么需要 | 代码里对应的调用 / 事件 |
| --- | --- | --- |
| `im:message.p2p_msg:readonly` | 接收用户发给机器人的**单聊**消息 | 事件 `im.message.receive_v1`（`chat_type = p2p`） |
| `im:message.group_at_msg:readonly` | 接收群聊里 **@ 机器人**的消息 | 事件 `im.message.receive_v1`（`chat_type = group`，靠 mentions 判定） |
| `im:message:send_as_bot` | 让机器人回复：文本、交互卡片、文件消息，以及**原地改写**那张「⏳」占位卡 | `POST /im/v1/messages`、`POST /im/v1/messages/{id}/reply`、`PATCH /im/v1/messages/{id}` |
| `im:resource` | 上传文件（`feishu_bot action: send` 带 `file` 时） | `POST /im/v1/files` |
| `im:chat:readonly`（或 `im:chat`） | 读群名，给 DSH 会话起个好标题；可选，没有就退回用 `chat_id` 后六位 | `GET /im/v1/chats/{chat_id}` |
| `im:message.group_msg` | **可选、敏感权限**：想让机器人**不用 @ 也能看到群里所有消息**（并把 `groupRequireMention` 设为 `false`）才需要 | 不做这一步的话群消息只有 @ 机器人的才会送达 |

开通后**不会立刻生效**，必须走第 5 步发布版本。

---

## 4. 事件订阅：一定要选「长连接」

应用 → **事件与回调** → **订阅方式** → 选 **「使用长连接接收事件」**。

> 这是整个配置里最关键的一步。DSH 的 Web 服务只监听 `127.0.0.1`，飞书的服务器**够不到**你的机器，所以「请求地址」模式（webhook）在本地是收不到任何事件的——而长连接是 DSH 主动外连飞书，不需要公网地址、不需要隧道，换网络也不用改回调地址。
>
> 只有在 DSH 真的跑在有公网 HTTPS 的机器上时，才应该用「请求地址」模式（对应 `transport: webhook`，见 [CONFIGURATION.md](CONFIGURATION.md#二字段总表)）。

然后 **事件与回调 → 添加事件**：

| 事件 | 必需？ | 作用 |
| --- | --- | --- |
| `im.message.receive_v1` | **必需** | 接收消息（单聊 / 群聊 @） |
| `im.chat.member.bot.added_v1` | 可选 | 机器人被拉进群时发一句欢迎语 |
| `im.chat.member.bot.deleted_v1` | 可选 | 机器人被移出群时，清掉这个聊天挂着的提问（否则它可能一直占着队列） |

---

## 5. 发布版本（最容易漏的一步）

应用 → **版本管理与发布** → **创建版本** → 填版本号与说明 → **申请发布** → 等管理员审核通过。

**权限和事件订阅不发布版本是不生效的**，本地会表现为「插件一切正常，但飞书发消息毫无反应」。

---

## 6. 安装插件

```sh
dsh plugin --profile web add dsh-plugin-feishu-bot
```

这个包在 `package.json` 里声明了 `dsh.bundle.patch`，所以它会被自动加进该 profile 的 bundle 层栈——**装完就是装完**，不用手工编辑任何 composition。行 id 是 `feishu-bot`。

**还没发布到 npm 时**，同一个命令接受任何 pnpm 能识别的来源，bundle 机制一样生效：

```sh
# 从 GitHub 装
dsh plugin --profile web add github:wang1078564969/dsh-plugin-feishu-bot
# 从本地克隆装（改代码即时生效，适合自己改）
dsh plugin --profile web add link:/path/to/dsh-plugin-feishu-bot
```

`link:` 装法有个坑：pnpm **不会安装被链接目录自己的依赖**，所以要手动补一次，否则桥接起不来（日志会说 SDK 解析不到）：

```sh
cd /path/to/dsh-plugin-feishu-bot && env -u npm_config_allow_scripts npm install --no-audit --no-fund
```

卸载：

```sh
dsh plugin --profile web remove dsh-plugin-feishu-bot
```

装好后重启该 profile（或让 DSH 重载配置），插件激活时会自己创建数据目录。

---

## 7. 填凭据

配置文件是**数据目录下的 `config.json`**：

| 环境 | 位置 |
| --- | --- |
| 默认 | `~/.dsh/feishu-bot/config.json` |
| 设了 `DSH_HOME` | `$DSH_HOME/feishu-bot/config.json` |
| 设了 `DSH_FEISHU_DATA` | `$DSH_FEISHU_DATA/config.json` |

> 升级自旧布局（`$DSH_HOME/.feishu-bot`）时，插件会在首次启动把 `config.json` / `state.json` / `plugin.log` **复制**过去一次，不需要你手工搬。

方式 A：直接编辑文件（`config.example.json` 是完整模板）：

```json
{
  "appId": "cli_xxxxxxxxxxxxxxxx",
  "appSecret": "你的 App Secret",
  "transport": "ws"
}
```

> 其余字段不用写：`config.json` **只保存与默认值不同的字段**，没写的字段跟随代码默认值。全部字段见 [CONFIGURATION.md](CONFIGURATION.md)。

方式 B：让 agent 代填（不用把密钥粘到别处）：

```
feishu_bot  action: configure  app_id: cli_xxx  app_secret: xxx
```

改完后让插件重新加载（方式 B 里 `configure` 会自己处理桥的重启，显式 `restart` 更保险）：

```
feishu_bot  action: restart
```

---

## 8. 验证

**日志**（最可靠）：

```sh
tail -f ~/.dsh/feishu-bot/plugin.log
```

成功时依次出现：

```
HTTP ingress registered at /feishu/events on port 3080
credentials OK — bot "你的机器人名字" (ou_xxx)
bridge started -> http://127.0.0.1:3080/feishu/events
feishu-bot ready (transport=ws, route=/feishu/events, credentials=set)
[bridge] … bridge up: appId=cli_xxx -> http://127.0.0.1:3080/feishu/events
[bridge] … long connection established
[bridge] … heartbeat {"state":"connected",…}
```

- `credentials OK` = 凭据有效（插件调了 `/bot/v3/info`）；
- `long connection established` = 长连接建立成功；
- 之后每 60 秒一行 `heartbeat`，`"state":"connected"` 表示链接还活着。

**状态**：

```
feishu_bot  action: status
```

会打印传输方式、凭据是否就绪、桥的进程状态、已知聊天数、机器人身份、入站地址、默认工作区 / preset / 权限档位，以及正在等人回答的问题。

**本地路由**（GET 返回一段 JSON 状态，不需要凭据）：

```sh
curl -s http://127.0.0.1:3080/feishu/events
```

---

## 9. 发第一条消息

1. 在飞书里搜索你的应用名，把机器人加为联系人（单聊），或者把它拉进一个群；
2. 单聊直接发一句话；群聊**必须 @ 机器人**（默认 `groupRequireMention: true`）；
3. 同时打开 DSH GUI，会看到一个标题形如「飞书单聊 xxxxxx」的会话实时跑起来——机器人跑的就是它；
4. 聊天里先出现一张「⏳ 已收到，正在处理…」的卡片，答完后**原地改写**成答案（`acknowledge: true` 的默认行为）；
5. 在聊天里发 `/help` 看全部指令；发 `/status` 看当前会话与工作区。

第一条消息同时验证了三件事：事件到达（日志 `event im.message.receive_v1`）、准入通过（日志 `turn start chat=… session=…`）、回复送达（日志 `turn done chat=… via=card-update replyChars=…`）。

---

## 10. 接下来

| 想做的事 | 怎么做 |
| --- | --- |
| 换工作区 | `/ws` 看列表，`/ws 2` 切过去；`/ws 2 new` 开全新会话 |
| 在别的会话之间来回切 | `/s` 看列表，`/s 3` 切过去 |
| 用技能 | `/skill` 列表，`/skill qiankun 帮我把这个 Vite 应用改成微前端子应用` |
| 让机器人把产出直接发成文件 | `feishu_bot action: send chat_id: oc_xxx file: /abs/path/报告.md` |
| 关掉卡片标题栏 / 底部指标行 | `feishu_bot action: configure card_header: false reply_metrics: false` |
| 收紧权限（**对外之前一定要做**） | 填 `allowedChatIds`、`blockedUserIds`，并把 `permissionPreset` 设成 `read-only` 或 `workspace-write`；见 [README 的「安全」](../README.zh.md#安全) |
| 排查问题 | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
