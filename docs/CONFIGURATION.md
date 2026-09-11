# 配置

插件读的配置文件只有一个：**数据目录下的 `config.json`**。数据目录在插件启动时确定：

| 顺序 | 位置 | 说明 |
| --- | --- | --- |
| 1 | `$DSH_FEISHU_DATA` | 环境变量，设了就用它（会 `resolve()` 成绝对路径） |
| 2 | `$DSH_HOME/feishu-bot` | 目录已存在时用它 |
| 3 | `$DSH_HOME/.feishu-bot` | 旧布局。**只迁移一次**：把 `config.json`、`state.json`、`plugin.log` 复制到 `$DSH_HOME/feishu-bot`，并在 stderr 打一行 `moved state from … to …`；复制失败则继续用旧目录 |
| 4 | `$DSH_HOME/feishu-bot` | 都不存在时新建 |

`$DSH_HOME` 未设置时是 `~/.dsh`（和 harness 自己的规则一致）。目录下有三个文件：

| 文件 | 内容 |
| --- | --- |
| `config.json` | 本文件的全部字段，**只写与内置默认值不同的键** |
| `state.json` | `chat_id` → DSH 会话的映射、每个聊天记住的历史会话（`/s` 列表） |
| `plugin.log` | 追加写的日志，超过 1 MB 轮转并保留最近 200 行 |

`config.json` 与 `state.json` 都通过 `umask 077; cat > …` 写入，所以**新建**时是仅属主可读（`600`）。注意 `cat >` 不会修改已存在文件的权限位：如果你手工创建过这个文件且权限更宽，它保持原样，自己 `chmod 600` 一下。

---

## 一、环境变量

插件**只读两个环境变量**，都只影响文件位置，不影响行为：

| 变量 | 作用 |
| --- | --- |
| `DSH_HOME` | DSH 主目录，默认 `~/.dsh`；决定 `feishu-bot` 数据目录的默认位置 |
| `DSH_FEISHU_DATA` | 直接指定数据目录，优先级最高 |

**凭据没有任何环境变量覆盖。** 代码里不存在读取 `appId` / `appSecret` / `transport` 等内容的环境变量，`config.json` 是唯一的配置来源。不要指望用 `FEISHU_APP_ID` 之类的变量代替凭据。

> 编辑 composition 时的一个坑：插件**不读行级 `config:`**，`config.json` 才是真源。给你的 profile 的 `cordis.patch.yml` 里写
> ```yaml
> - id: feishu-bot
>   config:
>     transport: webhook
> ```
> 不会有任何效果。行本身只支持 `disabled: true`（关掉它）这一个开关。
>
> `appId` / `appSecret` 会作为环境变量 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` 传给**插件自己拉起的**长连接子进程，外加 `DSH_FEISHU_ENDPOINT` 和 `DSH_FEISHU_BRIDGE_TOKEN`；这四个由插件内部使用，不是给运维设置的入口。

---

## 二、字段总表

默认值全部来自 `lib/bot.js` 的 `DEFAULTS`；「工具可改」一列表示能不能用 `feishu_bot action: configure` 改。

| 字段 | 类型 | 默认 | 作用 | 什么时候改 | 工具可改 |
| --- | --- | --- | --- | --- | --- |
| `appId` | string | `""` | 飞书自建应用 App ID | 首次接入必填 | 是（`app_id`） |
| `appSecret` | string | `""` | 飞书自建应用 App Secret | 首次接入必填 | 是（`app_secret`） |
| `verificationToken` | string | `""` | 非空时校验**直连**事件来源（`url_verification` 与 POST body 里的 `header.token`） | 把 `/feishu/events` 暴露到公网时 | 否，手写 |
| `encryptKey` | string | `""` | 开启「事件加密」时填；用它做 AES-256-CBC 解密，并在有 `x-lark-signature` 时验签 | 开放平台开了事件加密时 | 否，手写 |
| `transport` | string | `"ws"` | 入站方式：`ws` 起长连接桥 / `webhook` 只留 HTTP 路由 / `both` 两者都要 | 见下 | 是 |
| `workspacePath` | string | `process.cwd()` | **默认**工作区；单个聊天可用 `/ws` 覆盖 | 想让机器人默认在某个项目里干活时 | 是（带 `chat_id` 时是切换该聊天，不带时是改默认值） |
| `agentPreset` | string | `"standard"` | 机器人会话用哪个 Agent preset | 想换一套 persona / 工具时 | 是（`agent_preset`） |
| `permissionPreset` | string | `""` | 机器人会话的权限档位；**空 = 完全沿用部署自己的权限策略**，插件不会自己放宽或收紧 | 想给聊天驱动的会话单独设上限时 | 是（`permission_preset`） |
| `groupRequireMention` | boolean | `true` | 群聊里只处理 @ 了机器人的消息 | 想让机器人群里读所有消息时（见下，需要额外权限） | 是（`group_require_mention`） |
| `replyStyle` | string | `"card"` | `card` = 交互卡片（Markdown + 原生表格）/ `text` = 纯文本 | 客户端太老、卡片渲染有问题时退回 `text` | 是（`reply_style`） |
| `acknowledge` | boolean | `true` | 先发一张「⏳ 已收到，正在处理…」卡片，答完**原地改写**成答案 | 不想要占位卡时设 `false` | 是 |
| `useReply` | boolean | `true` | 回复时引用你那条消息 | 不想要引用条时设 `false` | 否，手写 |
| `cardHeader` | boolean | `true` | 卡片顶部标题栏：机器人名 + 当前工作区名 | 卡片标题栏显示异常时先关掉它验证 | 是（`card_header`） |
| `replyMetrics` | boolean | `true` | 卡片底部灰字：⏱ 耗时 · 📊 上下文 · ⚡ 缓存命中 | 嫌吵时设 `false` | 是（`reply_metrics`） |
| `maxReplyChars` | number | `6000` | 回复截断长度；超出后截断并追加「…（回复过长，已截断）」。小于等于 200 的值会被忽略并退回默认 | 回答经常被截断且你能接受长卡片时调大 | 否，手写 |
| `timeoutMs` | number | `300000` | 单轮**静默**上限（毫秒）：整棵会话树（含子代理）一直没有新事件时才中断，中途还在产出就重新计时 | 长任务被中途打断时调大 | 否，手写 |
| `allowedChatIds` | string[] | `[]` | 允许列表：非空时只处理列表内的 `chat_id`，其余消息**完全忽略** | 生产环境必设，见「安全」 | 否，手写 |
| `blockedUserIds` | string[] | `[]` | 拒绝列表：`open_id` 或 `user_id` 命中就忽略，优先级最高 | 屏蔽某个用户时 | 否，手写 |
| `bridgeToken` | string | 自动生成 | 长连接桥回灌事件时带的 `x-dsh-bridge-token`，用于区分「本地桥」和「飞书直连」 | **不要手填**：文件里缺失或为空时插件会重新生成并写回 | 否 |

`transport` 的三个取值（代码里的判据是 `transport === 'ws' || transport === 'both'` 才启动长连接桥）：

| 值 | 长连接桥 | HTTP 路由 `/feishu/events` | 适用场景 |
| --- | --- | --- | --- |
| `ws`（默认） | 启动 | 照常注册（桥就是往这里回灌事件的） | 本机 / 内网部署。**不需要公网地址** |
| `webhook` | 不启动 | 照常注册 | DSH 跑在有公网 HTTPS 的机器上，开放平台订阅方式填「请求地址」 |
| `both` | 启动 | 照常注册 | 过渡期：两种入站都能收 |

> `webhook` 模式下事件由飞书服务器直接 POST 到 `/feishu/events`，所以**必须有公网可达的 HTTPS 地址**（DSH Web 服务只监听 `127.0.0.1`，飞书够不到）。默认的 `ws` 模式由 DSH 主动外连飞书，不需要端口映射、隧道或回调地址。

---

## 三、回写规则（重要）

`config.json` **只保存与内置默认值不同的字段**：每次保存时逐字段和 `DEFAULTS` 比较，只写差异（数组按 JSON 比较）。因此：

- 文件里**没有**的字段 = 跟随代码默认值 → 升级后默认值变了，你的行为跟着变；
- 文件里**有**的字段 = 你显式钉住的值 → 升级改默认值不影响它；
- 想把某个字段恢复成默认值：把它从 `config.json` 里**删掉**，再 `feishu_bot action: restart`（或重启 DSH）；
- 想让某个字段「恰好等于默认值但被钉住」做不到：写进去也会在下次保存时被清掉。

会触发保存的动作：`feishu_bot action: configure`、`action: workspace`（不带 `chat_id`，改默认工作区）、以及首次生成 `bridgeToken` 时。

`config.json` 读失败时（权限、超时、超过 4 MB 等）插件**拒绝写回**，只在内存里用默认值跑，并记一行 `config save refused: … was never read successfully`。这是有意的：读不到就当成「没配过」会把 `appId` / `appSecret` / `encryptKey` / `workspacePath` 一起抹掉。文件真的不存在（首次运行）不在此列。

---

## 四、安全相关字段怎么填

三个字段决定谁能驱动你的机器：

```json
{
  "allowedChatIds": ["oc_xxxxxxxxxxxxxxxx"],
  "blockedUserIds": ["ou_xxxxxxxxxxxxxxxx"],
  "groupRequireMention": true,
  "permissionPreset": ""
}
```

- `allowedChatIds`：**空数组 = 不限制**。机器人能被拉进的每个群、每个能找到它的单聊，都能驱动 agent。生产部署请写死允许的 `chat_id`（用 `feishu_bot action: chats` 查）。
- `blockedUserIds`：优先级最高，在允许列表和 @ 判断之前生效。
- `groupRequireMention`：默认 `true`，只有 @ 了机器人的群消息会被处理。设成 `false` 让机器人读群里**所有**消息，需要飞书那边额外开通敏感权限 `im:message.group_msg`，并且等于把群里每个人的每句话都当成潜在 prompt。
- `permissionPreset`：留空表示不动部署的权限策略；设成 `read-only` / `workspace-write` / `danger-full-access` 才会在机器人会话上覆盖。**插件自己永远不会放宽权限**。设成会触发审批的档位（如 `workspace-write`）时，需要审批的工具调用会在聊天里出现一张卡片等你回 `1`/`2`。

完整风险说明见 [README 的「安全」一节](../README.zh.md#安全)。

---

## 五、改完怎么生效

| 改了什么 | 生效方式 |
| --- | --- |
| 任意字段（手写 `config.json`） | `feishu_bot action: restart`：重新读配置、重新校验凭据、重启长连接桥 |
| `appId` / `appSecret` / `transport`（用工具改） | `configure` 会自己停掉旧桥并用新身份重启 |
| 其他字段（用工具改） | `configure` 立即写入内存并保存，无需重启 |
| `bridgeToken` | 不用管；缺失时自动生成并写回 |
