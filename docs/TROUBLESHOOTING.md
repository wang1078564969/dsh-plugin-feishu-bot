# 排障

排障先看一个文件：**数据目录下的 `plugin.log`**（默认 `~/.dsh/feishu-bot/plugin.log`，见 [CONFIGURATION.md](CONFIGURATION.md#配置)）。日志追加写、超过 1 MB 轮转并保留最近 200 行。

每行的格式是 `时间戳 内容`；插件自己的行没有额外前缀，长连接子进程的输出被转发时前面加一个 `[bridge] `（子进程自己也带一个 `[bridge]` 前缀，所以 `bridge up` 这类行会看到两个）。进程的 stdout 上还会多一个 `[feishu-bot]` 前缀——那是 `console.log` 加的，文件里没有。所以搜日志时用内容片段（`long connection established`、`turn start`），不要连前缀一起搜。

不想开终端时，直接问 agent：

```
feishu_bot  action: logs  limit: 80
```

`limit` 默认 40，最大 200。`feishu_bot action: status` 会打出传输方式、凭据是否就绪、桥的进程状态、已知聊天数、机器人身份、默认工作区 / preset / 权限档位，以及当前挂着等人回答的问题。

健康启动时应该能看到这几行（顺序大致如下，实际带 ISO 时间戳前缀）：

```
webServer is unavailable …                          ← 只有拿不到 web 服务时才有
HTTP ingress registered at /feishu/events on port 3080
credentials OK — bot "机器人名字" (ou_xxx)
bridge started -> http://127.0.0.1:3080/feishu/events
feishu-bot ready (transport=ws, route=/feishu/events, credentials=set)
[bridge] … bridge up: appId=cli_xxx -> http://127.0.0.1:3080/feishu/events
[bridge] … long connection established
[bridge] … heartbeat {"state":"connected",…}
```

`heartbeat` 每 60 秒一行，用它判断链接的实时状态（`state: "connected"` 才算通）。

---

## 1. 启动后一个字都没有

**现象**：日志里没有 `feishu-bot ready`，飞书那边全静默。

**先看**：包是不是真的挂进 profile 了。

```sh
dsh plugin --profile web list | grep feishu
```

**原因与处置**

| 原因 | 处置 |
| --- | --- |
| 包没装进 profile | `dsh plugin --profile web add github:wang1078564969/dsh-plugin-feishu-bot` |
| 安装报 `ERR_PNPM_IGNORED_BUILDS`（`Ignored build scripts: protobufjs@…`） | pnpm 10+ 默认拦下依赖的安装脚本，而 `add` 把「有一个新包被拦下」当成失败。在 profile 的 `pnpm-workspace.yaml` 里加 `allowBuilds: {protobufjs: false}`（若已有占位行 `protobufjs: set this to true or false` 就改成 `false`），再重跑同一条命令 |
| 行被关掉了（profile 的 `cordis.patch.yml` 里有 `- id: feishu-bot` + `disabled: true`） | 去掉 `disabled: true`，重载或重启 DSH |
| 入口文件被删 / 坏了 | 报错是响亮的：激活时抛出 `[feishu-bot] cannot … lib/…` 之类的错误并指明是哪个文件读不到，而不是静默不提供任何东西。重新安装包即可 |
| `shell` 服务不可用 | `the shell service is unavailable; cannot run curl or the bridge`。这个插件依赖 POSIX shell（`curl` / `openssl` / `stat`），换一个有 shell 服务的 profile |
| 没装 `@larksuiteoapi/node-sdk` | 属于安装不完整：`bridge not started: the Feishu SDK cannot be resolved from …`。重跑 `dsh plugin --profile <name> add github:wang1078564969/dsh-plugin-feishu-bot` |
| 改了代码 / 仓库推了新 commit，但行为没变 | git 依赖锁在解析出来的那个 commit 上，见下面「怎么升级」 |

---

## 2. 长连接没建起来

**现象**：日志有 `feishu-bot ready`，但没有 `[bridge] long connection established`。

**先看**：`feishu_bot action: status` 里的 `bridge` 字段和 `plugin.log` 里最后一条 `bridge …` 行。

| 日志行 | 意思 | 处置 |
| --- | --- | --- |
| `bridge not started: appId and appSecret are empty in …/config.json` | 没填凭据 | 填 `appId` / `appSecret`（或 `feishu_bot action: configure app_id: … app_secret: …`），再 `feishu_bot action: restart` |
| `bridge disabled (transport=webhook)` | 当前入站方式不含长连接 | 想用长连接就把 `transport` 改回 `ws`（或 `both`），再 `restart` |
| `bridge script missing at … — reinstall the package to use long-connection mode` | 包内 `lib/bridge.mjs` 不见了 | 重新安装包 |
| `[bridge] FATAL: FEISHU_APP_ID and FEISHU_APP_SECRET are required` | 子进程没拿到凭据（一般是 `appSecret` 空） | 检查 `config.json`，`restart` |
| `[bridge] error: …` / `[bridge] reconnecting…` 反复 | 网络不通、应用被停用、凭证被重置 | 先看 `[bridge] heartbeat {…}` 的 `state`；SDK 会自己重连，插件也会在进程死掉后重启它（首次 15 秒，逐次翻倍到 5 分钟上限） |
| 一直只有 `bridge started -> …`，没有 `long connection established` | 子进程没跑起来或连不上 | 看有没有 `FATAL:` 行；没有就查网络与凭据，见上一行 |
| `long connection established` 有了，但发消息时日志里没有 `event im.message.receive_v1` | 桥连着但**事件没有推下来**：开放平台**订阅方式不是「长连接」** | 开发者后台 → 事件与回调 → 订阅方式 → 选「使用长连接接收事件」，然后**发布版本** |

> 长连接与端口无关：它是 DSH 主动外连飞书，本机不需要公网地址、不需要隧道。反过来，选了「请求地址」模式时长连接永远收不到任何事件。

---

## 3. 飞书发消息，机器人完全没反应

**现象**：消息发出去了，聊天里连「⏳ 已收到」都没有。

**先看**：日志里有没有 `event im.message.receive_v1`。

| 有 / 没有 | 含义 | 处置 |
| --- | --- | --- |
| **没有** | 事件根本没到 DSH | ① 开放平台订阅方式不是「长连接」；② 权限或事件订阅没**发布版本**（权限和事件不发布不生效）；③ 机器人不在这个会话里 / 应用被停用 |
| **有**，但没有 `turn start` | 事件到了，被准入检查挡下 | 日志会写原因：`ignored group message without an @-mention in …`（群聊要 @）/ `ignored message from non-allowed chat …`（`allowedChatIds` 不含这个聊天）/ `ignored message from blocked user …`（`blockedUserIds` 命中）/ `cannot answer …: appId/appSecret are missing from …`（没凭据，忽略且不产生副作用） |
| **有** `turn start`，没有 `turn done` | 这一轮还没结束 | 看 `turn still settling (session=… live subagents=N quiet=Ns)`、`turn timeout held: …`。详见第 6、7 节 |

**顺带两个静默忽略的情况**：非文本消息只会回一句「目前只支持文本消息。」；同一条 `message_id` 重复投递会记 `duplicate delivery for …, ignored`（去重，不是故障）。

---

## 4. 有回复，但发不出去 / 卡片是空的

**现象**：日志里 `turn done … via=…`，聊天里什么都没有或者一片空白。

**发送是一条降级链**，`via=` 就是实际走的那一级：

```
card-update        原地改写「⏳」那张卡                       ← 正常路径
card-update-plain  同上，表格拍平成代码块
card               占位卡没了，新发一张卡
card-plain         同上，表格拍平
text-fallback      退回纯文本（至少内容还在）
text               replyStyle=text 时的正常路径
```

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| `card send failed` / `plain card send failed` 之后仍然成功 | 只是降级，不是故障 | 不用管；`via=card-plain` 说明表格被拍平了 |
| `Feishu rejected both card and text replies` | 真的失败，内容一个字都没发出去 | 多半是 `im:message:send_as_bot` 没开，或权限没发布版本；也可能应用被停用 |
| 卡片发出去但内容空白 | 客户端不认卡片里的某个字段（常见是标题栏副标题） | `feishu_bot action: configure card_header: false` 先关掉标题栏验证；确认后如需彻底退回纯文本：`reply_style: text` |
| 卡片里写「请升级客户端为最新版本后查看内容」 | 原生表格组件需要飞书客户端 V7.4 及以上 | 升级客户端，或把 `replyStyle` 设成 `text` |

---

## 5. 回复里的表格显示成一堆竖线

**现象**：Markdown 表格原样出现成 `| a | b |`、`| --- | --- |`。

**原因**：飞书的 markdown 组件**不支持表格**。正常路径下插件会在发送前把表格拆出来，换成飞书的原生 `table` 组件；出现竖线说明这一级被跳过了。

**处置**

1. 看日志里的 `via=`：如果是 `card-plain` / `card-update-plain`，说明卡片被飞书拒过一次，表格已被**故意**拍平成代码块/文本——内容没丢，只是没有表格外观；
2. 用内置示例卡对照渲染链路，不跑模型：

   ```
   feishu_bot  action: preview  chat_id: oc_xxx
   ```

   它会返回实际生成的元素清单（`markdown chars=…` / `table columns=… rows=… width=…` / `note …`）并真的把示例卡发到聊天里；
3. 表格解析是纯字符串处理，识别条件是「表头行 + 分隔行 + 表体行」且列数一致，围栏代码块里的表格不动（那是内容，不是排版）；**一张卡片最多 5 个 `table` 元素**（飞书限制），第 6 个起降级成等宽对齐的代码块；
4. 表格组件需要客户端 V7.4+，老客户端显示占位图——这不是渲染失败。

---

## 6. 任务明明做完了，飞书却没收到结果

**现象**：会话日志里活干完了，聊天里只有中途那句「先并行铺开…」，甚至只有一条「⏱️ 处理超时」。

**背景（这是设计上的难点，不是随机故障）**：`agent.whenIdle()` 只说明**本轮**结束。模型可以把活派给后台子代理、结束本轮，然后在子代理回报时被唤醒成**新的一轮**。只看第一次 idle 就会在中途收工，那一轮没人投递。

**现在的规则**：一轮真正结束要同时满足

1. 会话空闲；
2. 它的**整棵子树**（子代理、孙代理，按会话头的 `parentSession` 认亲）没有活着的成员；
3. 整棵树静默超过 15 秒（`SETTLE_MS`，用来兜住「子代理刚销毁、回报还在路上」）。

等待期间日志会一直写 `turn still settling (session=… live subagents=N quiet=Ns)`：N 归零后还在等，是正常的静默窗口；N 长时间不为 0 说明子代理真的还在跑。

**上限也按静默算**：`timeoutMs`（默认 5 分钟）量的是**整棵树的静默时长**，不是墙钟。只要还有事件产出就重新计时，所以一个每几秒就有工具调用的健康回合不会被打断。真正超时才会回一句「⏱️ 处理超时，本轮已中断。」

**仍然没收到时依次检查**

| 看什么 | 含义 |
| --- | --- |
| `turn done … replyChars=0` | 这一轮最后一条内容是空的，没有东西可发 |
| 有 `card send failed` / `plain card send failed` / `Feishu rejected both card and text replies` | 投递降级或失败，见第 4 节 |
| `turn timeout held: session=… still producing (quiet Ns)` | 正在重新计时，正常 |
| `turn still settling (… live subagents=N …)` | 子代理还在跑；想放宽就调大 `timeoutMs` |
| 会话日志里 `turn/end` 是否缺失 | 缺失说明这一轮卡在某个没有返回的 `tool/call` 上，见第 11 节 |

---

## 7. 正文跟着提问一起消失了

**现象**：飞书里只出现一张问题卡，解释这个问题的正文一个字都没有。

**原因**：模型经常把**回答和提问写在同一步**里（正文解释它接下来要问什么），而机器人默认只发「本轮最后一条」。历史上这丢过一整段带表格的摘要。

**现在的规则**：任何会阻塞的提问（`ask_user_question`、权限审批）发出之前，**先把本轮已经产出的正文发出去**，并记下来避免收尾时重复发。日志里能看到：

```
delivered text that preceded a question chat=oc_xxx chars=262
question asked chat=oc_xxx questions=1 delivered=true
```

`delivered=false` 说明连问题卡都没发出去（那张卡发不出去时，这次提问会让给下一个答题器，通常是 GUI，而不是假装问过）。其余「正文 + 工具调用」的中间叙述（几十个字那种）仍然不发——一次对话变成十几条卡片不是改进。

---

## 8. 机器人回错聊天

**现象**：A 聊天里问的问题，答案出现在 B 聊天；或者两个聊天收到同一份回复。

**原因**：机器人回复的目标**永远是收到消息的那个 `chat_id`**，所以「回错」几乎只有一个来源——**两个飞书聊天共用了同一个 DSH 会话**。`/ws` 和 `/s` 都专门拒绝这种操作（同一个会话被两个聊天驱动会让提问投递到错误的聊天、回合互相清状态），能绕过它们的只有：

- 手工改过 `state.json`，把两个 `chat_id` 指向同一个 `sessionId`；
- **同时跑了两个插件实例**（比如 composition 行 + 一个动态 Package），两者抢同一个飞书长连接和同一个 `/feishu/events` 路由；
- 重载后残留的旧实例把已经跑完的回合投递到了它当初的聊天。

**处置**

1. 只保留一个实例：用 composition 行就不要同时 `cordis_run` 一个动态包；
2. 查映射：`feishu_bot action: chats` 会逐条列出 `- <chat_id> [p2p|group] <标题> -> <sessionId> turns=N` 和下一行的 `cwd: …`；同一个 `sessionId` 出现两次就是问题所在；
3. 修的办法是让其中一个聊天换会话：在对应聊天里发 `/s new`（或 `/new`），或者在 `state.json` 里删掉那个聊天条目后 `feishu_bot action: restart`。

---

## 9. `/ws` 和 `/s` 分不清

两者都是「换会话」，但选的东西不同：

| | `/ws` | `/s` |
| --- | --- | --- |
| 选的是 | **工作区**（目录） | **具体某一个会话**（会话 ID 级） |
| 列表来自 | DSH 的 workspace registry（GUI 左侧栏那些工作区） | 本聊天自己的历史会话（最多记 20 个）+ 当前工作区里其它 DSH 会话 |
| 默认行为 | 接着**该工作区最近用过的**会话 | 列表里你点名的那个 |
| 开新会话 | `/ws <序号> new` | `/s new` |
| 序号 | 工作区序号，顺序稳定 | 会话序号，**一次列表一个快照** |

**常见混淆与处置**

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| 「`/ws 2` 切过去的不是我想要的那个对话」 | `/ws` 是「去那个工作区」，默认接的是**最近写过**的那次会话 | 想要干净上下文：`/ws 2 new`（或在切换后发 `/new`）。要精确点名某个会话：用 `/s` |
| 「`/s 2` 切到了别的会话」 | 序号只对**你看到的那一次列表**有效；期间有过 `/s new`、`/s drop` 或新消息，编号就会变 | 先 `/s` 看一遍，再按新编号切；切换成功的回复里会写明切到哪个会话 ID |
| 「`/ws` 列表里的序号在 `/s` 里对不上」 | 两个列表是两套编号，互不相干 | 分别用各自的列表 |
| 「`/ws` 列出来的会话和我刚用过的不一样」 | 「最近用过」按会话日志文件的修改时间排，不是创建时间 | 正常。mtime 探测不可用时（日志里 `session mtimes unavailable (exit N); /ws falls back to creation time`）会退回创建时间排序 |
| 「列表比实际短」 | `/ws` 的工作区列表最多显示 15 个（后面写「…还有 N 个」，但序号仍按完整列表解析）；`/s` 最多列 12 个会话（超出会写「只列了前 12 个」） | 直接按序号切，或缩小范围 |
| 「某个会话切不过去，提示正在跑」 | `/s` **拒绝**切到别处正在跑一个回合的会话 | 等那一轮跑完再切；`/s` 重看列表 |
| 「有个会话根本不出现在 `/s` 里」 | 属于**另一个飞书聊天**的会话不列（只告诉你还有几个），子代理会话也不列 | 用原本那个聊天去 `/s`；要接管就在这边 `/s new` |
| 「`/ws` 接上了 GUI 里开着的会话，标注了『GUI 里也开着』」 | 有意为之：本机上常用工作区的根会话几乎都活在 GUI 里，排除掉就等于永远开新会话 | 一次只在一处说话；共用的**是同一个 agent**，回合在一个收件箱里排队 |
| 「切换动作被排队了」 | 这一轮还在跑，立刻换会话会把正在执行 `feishu_bot` 调用的循环拆掉 | 回复里会说明「已排队…下一条消息生效」，日志写 `session swap deferred` → `deferred swap applied`。若这一轮已经超过 `timeoutMs` 还不结束，会走逃生口强制换掉（`session swap forced … detaching without await`） |

另外记住：`/ws` 与 `/s` 的覆盖都**只作用于当前这个飞书聊天**（写进该聊天的 `state.json` 条目）；`/ws default` 撤销工作区覆盖。想改**全局默认**工作区（只影响之后的新会话），用不带 `chat_id` 的 `feishu_bot action: workspace`。

---

## 10. 群聊里 @ 了也不理

| 原因 | 处置 |
| --- | --- |
| 缺 `im:message.group_at_msg:readonly` | 开放平台 → 权限管理 → 开通 → **发布版本** |
| `groupRequireMention` 为 `true` 但飞书没把 mentions 传过来 | 日志里会写 `ignored group message without an @-mention in …`。确认是真的 @ 到了机器人（不是 @所有人），必要时临时关掉这个开关验证 |
| 想让机器人读群里**所有**消息 | 需要敏感权限 `im:message.group_msg`，并把 `groupRequireMention` 设成 `false`。想清楚再开：等于把群里每个人的每句话都当 prompt |
| 机器人不在群里了 | 日志有 `removed from chat …` |

---

## 11. 卡片一直停在「⏳ 正在处理…」

**现象**：某次提问之后，这个聊天再也不回消息。

| 原因 | 判断 | 处置 |
| --- | --- | --- |
| 会话卡死：某轮的 `tool/call` 没有对应的 `tool/result` | 会话日志里 `turn/end` 缺失 | 在该聊天发 `/stop`（它在入队**之前**就被处理，专门用来中断队首那一轮）；或 `feishu_bot action: reset chat_id: …` |
| 有提问挂着没人回答 | `feishu_bot action: status` 会打出 `waiting on a human answer: …` | 回答它，或发 `/cancel`（提问以 `ASK_CANCELLED` 报错给模型；审批按**拒绝**处理） |
| 真的超时了 | 日志 `⏱️ 处理超时，本轮已中断。` | 调大 `timeoutMs`；注意它量的是静默，不是墙钟 |
| 占位卡是上一轮失败留下的 | 日志 `turn failed: …` | 失败时插件会把占位卡**改写**成错误内容，不会留着「正在处理」 |

> 提问挂着的时候**不触发超时**：计时器会重新计时（日志 `turn timeout held: chat is waiting on a human answer`），因为人是按人的速度读和选的。等多久都行，`/cancel` 或直接换个话题都能脱身。

---

## 12. 底部灰字不对或不全

底部那行 `⏱ … · 📊 上下文 … · ⚡ 缓存命中 …` 的口径：

| 字段 | 口径 |
| --- | --- |
| `⏱ 耗时` | 收到消息到答案就绪的墙钟时间（含会话 resume、模型推理、工具调用） |
| `📊 上下文` | **最近一次请求**的 prompt 大小（未命中缓存的输入 + 缓存读 + 缓存写），斜杠后是路由模型的窗口容量与占比 |
| `⚡ 缓存命中` | 最近一次请求里命中缓存的 prompt 占比 |

数字来自 provider 上报的 usage，和 GUI 输入框旁边那个上下文环同源。

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| 只有 `⏱`，没有上下文/缓存 | 这个会话在**本进程里**还没跑过一轮请求 | 发一条消息；已在跑的会话会先从落盘日志回填一次 |
| 完全没有 `⚡` | provider 不上报缓存字段（诚实做法：不显示，而不是谎报 0%） | 正常 |
| 数字和「整个会话」的感觉对不上 | 它是**最近一次请求**的快照，不是累计值 | 想知道会话累计轮次看 `/status` |
| 不想要这一行 | — | `feishu_bot action: configure reply_metrics: false` |

---

## 13. 发文件失败

`feishu_bot action: send chat_id: oc_xxx file: /abs/path/report.md`

| 日志 / 返回 | 原因 | 处置 |
| --- | --- | --- |
| `找不到文件：…` | 路径不存在。注意插件的 shell 以**数据目录**为工作目录，相对路径是相对它解析的 | 用绝对路径 |
| `文件是空的或读不到大小：…` | 空文件 | 检查文件 |
| `文件 N 字节，超过飞书文件消息上限 31457280 字节` | 超过 30 MB | 拆分或用别的传输方式 |
| `上传文件失败 code=… msg=…` | 权限或文件类型问题 | 确认 `im:resource` 已开通并**发布版本**；上传走 `file_type=stream`（飞书只认 opus/mp4/pdf/doc/xls/ppt 这几种具名类型，Markdown 之类都归 `stream`） |
| `发送文件失败 code=… msg=…` | 发消息这一步被拒 | 确认 `im:message:send_as_bot`，并检查机器人还在这个聊天里 |
| 想同时发文字和文件 | 同一个动作里 `file` 优先于 `text` | 分两次调用 |

---

## 14. `/help` 里的原生命令列表不全

**现象**：新聊天里发 `/help`，机器人指令都在，但「DSH 原生命令」那一段只写一句「本会话尚未建立，先随便发一条消息即可使用。」

**原因**：原生命令清单是向部署的命令注册表实时查询的，查询需要一个**活着的 agent**；刚建好的聊天还没有会话，所以查不到。这不是故障。

**处置**：先发任意一条消息（或直接发那条原生命令，比如 `/compact` —— 它会顺手把这个会话建起来），之后再 `/help` 就能看到完整清单。

---

## 15. 日志速查

| 日志行 | 含义 |
| --- | --- |
| `feishu-bot ready (transport=…, route=…, credentials=set/missing)` | 插件激活完成；`credentials=missing` 说明凭据为空 |
| `HTTP ingress registered at /feishu/events on port N` | 本地 HTTP 入站已注册 |
| `credentials OK — bot "…" (…)` | 凭据校验通过（会去调 `/bot/v3/info`） |
| `event im.message.receive_v1 via=ws-bridge` | 事件到达；`via=webhook` 表示是直连进来的 |
| `turn start chat=… session=… cwd=… chars=…` | 这一轮开始（准入检查已通过） |
| `turn done chat=… via=… replyChars=… metrics=…` | 这一轮结束并投递 |
| `turn failed: …` | 本轮抛错，占位卡会被改写成错误 |
| `session swap deferred` / `deferred swap applied` / `session swap forced` | 换会话被排队 / 生效 / 走逃生口 |
| `turn still settling (…)` | 等子代理树静默 |
| `turn timeout held: …` | 超时被推迟（还在产出 / 有人在回答） |
| `question asked … delivered=…` / `approval asked … delivered=…` | 提问卡 / 审批卡已发出 |
| `delivered text that preceded a question …` | 提问前的正文已单独送达 |
| `duplicate delivery for …, ignored` | 同一条消息重复投递，已去重 |
| `state save skipped: …` / `config save refused: …` | 读失败的自我保护，不是数据损坏 |
| `bridge is not running; restart attempt #N` | 桥进程死了，正在按退避重启 |

想看运行时的即时状态，除了日志还可以直接请求本地路由（GET 会返回一段 JSON 状态）：

```sh
curl -s http://127.0.0.1:3080/feishu/events
```

## 从「profile 里的一个文件」迁移过来

老装法把实现放在 `~/.dsh/profiles/<profile>/plugins/feishu-bot.mjs`，它自己去读 `~/.dsh/.feishu-bot/host.js`。新装法是包。

**升级步骤**

```bash
dsh plugin --profile web add github:wang1078564969/dsh-plugin-feishu-bot   # 装包 + 自动挂上 bundle 层
# 然后重启 DSH
```

重启是必须的：bundle 列表在启动时合成，改 `package.json` 不会让正在跑的进程重新合成整棵树。

**旧行必须先删掉。** 如果你之前手写过 `cordis.patch.yml` 里的 `feishu-bot` 行，它和 bundle 自带的行**同 id 会变成两行**（实测），于是两个桥接、两条 `/feishu/events` 路由、激活失败。二选一：

```yaml
# 删掉手工的 insert，让 bundle 提供这一行
- id: feishu-bot
  config: { ... }        # 需要改配置时用这种「按 id 覆盖」的写法
```

**数据不会丢。** `config.json` / `state.json` 在 `$DSH_HOME/feishu-bot`，首次启动时若发现老的 `$DSH_HOME/.feishu-bot` 会自动复制过来。

**如果重启后机器人没反应**，先看 `feishu_bot action: status`（工具都没有 = 行没挂上），再看 DSH 终端——装载器的报错只打在那里，不写进 `plugin.log`。回滚就是把手工的 `insert` 行改回旧路径、把包从 `dsh.profile.bundles` 里删掉。

**已知未验证的一点**：把一个**正在运行**的 profile 行从旧路径直接改指到包，在运行中的进程里可能不生效（行不会重新激活），装载器的错误只出现在 DSH 终端。改完重启即可，不要在运行中反复改行名。

## 设置页显示不出来 / 读不到配置

设置里的「飞书机器人」这一页是**随包发布的浏览器半边**（`lib/client.js`，由 `package.json` 的 `dsh.client` 声明）。它要工作，两件事都得成立：

| 检查 | 怎么看 |
| --- | --- |
| 浏览器半边被挂载 | 设置左栏有没有「飞书机器人」这一项。**没有** → `package.json` 的 `dsh.client.platform` 必须是 `"web"`，`exports` 必须有 `"./client"`，且装完要**重启 DSH**（客户端清单在启动时扫描） |
| host 半边注册了路由 | `plugin.log` / DSH 终端里有没有 `the connection service is unavailable — the settings page will not load its configuration (the bot itself is unaffected)`。有 → 这个 profile 没装 web bundle，页面读不到配置（**聊天本身不受影响**） |

页面报错时会直接显示出来（红框 + 重试），常见的两条：

- `HTTP 401`：浏览器 cookie 过期。刷新页面重新登录即可。
- `HTTP 404`：路由没注册上，看上面第二行。

**页面里的密钥为什么永远是空的**：接口只回「是否已设置」，从不回传明文。这不是 bug；`appSecret` 留空保存＝不修改。

**为什么页面不能改 `bridgeToken`**：它由插件生成，任何外部来源都不该能设置或清除它。接口会拒绝这个键。

---

## 怎么升级到新版本

git 依赖会被 pnpm 锁到一个**具体 commit**（`pnpm-lock.yaml` 里表现为 `codeload.github.com/…/tar.gz/<sha>`），所以「仓库推了新 commit」不等于「你装的是新的」：

```sh
dsh plugin --profile web update dsh-plugin-feishu-bot    # 重新解析到 main 上最新的 commit
dsh plugin --profile web list | grep feishu              # 确认已经变了
# 然后重启 DSH（bundle 列表在启动时合成）
```

要固定到某个版本就写全 ref（tag 或 commit sha 都可以，实测 `#<sha>` 会原样写进 specifier）：

```sh
dsh plugin --profile web add github:wang1078564969/dsh-plugin-feishu-bot#<sha>
```

自己改代码的场景用 `add link:/path/to/clone`——那是符号链接，改完文件即生效，不需要 update。

## 写完插件后 DSH 起不来：`cannot get property "xxx" without inject`

排查顺序里最该先看的一条，因为这个错误的后果最重：**启动审计会把失败行的错误重新抛出去，整个 DSH 起不来**。

Cordis 的服务代理有两种读法，规则不同：

```js
ctx.get('shell')        // 可选读取：不需要 inject，拿不到就是 undefined
ctx.interval(fn, 3000)  // 属性访问：要求 inject 里声明了 'timer'
ctx.tools.register(t)   // 属性访问：要求 inject 里声明了 'tools'
ctx.get('tools').register(t)  // 也可以，但那样拿不到就用不了
```

报错信息里的 `xxx` 就是漏掉的那个服务名。本插件踩过的两次：

| 漏掉的 | 报错位置 | 现象 |
| --- | --- | --- |
| `tools` | `harness.registerTool`（apply 的最后一步） | **整个 DSH 启动失败**，因为注册工具抛在 apply 尾部 |
| `timer` | `ctx.interval(...)` | 同样的错误，但只在重试时偶发 |

所以 `lib/index.js` 里是 `export const inject = ['timer', 'tools']`，而 `ctx.get('shell')` / `ctx.get('webServer')` 不需要声明。

**两条防御性写法**（都已在这个包里）：

1. `registerTool` 包在 try/catch 里——注册模型工具失败不该让 harness 起不来；聊天链路在那一刻其实已经跑起来了。
2. 入口的 `apply` 对**加载**失败是吞掉并记日志的（`<数据目录>/load-report.txt`），因为一个聊天桥接没有资格让整个 harness 陪葬。

另外一条与 inject 无关但同样致命：**别把"能不能解析某个依赖"写成闸门**。`lib/bot.js` 一开始用 `createRequire().resolve()` 探测飞书 SDK，解析失败就不启动桥接；结果主进程（在依赖装完之前就已经启动了）解析失败，而桥接子进程自己解析完全正常——一道防错的检查制造了它本来要防的故障。现在它只是探测，只影响日志措辞。
