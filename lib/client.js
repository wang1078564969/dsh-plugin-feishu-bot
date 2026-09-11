/*
 * The shipped settings page: the browser half of dsh-plugin-feishu-bot.
 *
 * HAND-WRITTEN BUNDLE, no build step. DSH's own client packages are produced by
 * tsdown into this exact wrapper — three strings in its preset:
 *
 *   banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`
 *   intro:  'var module = { exports: {} }; var exports = module.exports;'
 *   footer: 'return module.exports; } });'
 *
 * and the loader validates nothing beyond `id` and `factory`. The maintainers'
 * own cookbook says a package outside their repository "has to reproduce the
 * same output format itself", which is what this file does. Consequences that
 * are easy to get wrong:
 *
 *   - It is served as a CLASSIC SCRIPT: no top-level `import`/`export`.
 *   - `id` must be the PACKAGE NAME; the loader aliases `<id>/client` to it.
 *   - React and friends arrive through `require`, seeded by the platform module
 *     list — never bundled, never imported.
 *   - `module.exports` is returned as-is. Do NOT set `__esModule` unless a
 *     `default` is also set, or the loader unwraps to `undefined`.
 *
 * HOW IT TALKS TO ITS HOST HALF. There is no `host.call` here: that builtin
 * belongs to the DYNAMIC Cordis runner. A shipped browser half reaches its own
 * host through an exact Fetch route on the connection service, which is also
 * what gives it the GUI's browser-cookie authentication. That route is
 * registered by `lib/index.js` and served by `lib/bot.js`.
 *
 * Plain JavaScript only: no JSX, no TypeScript. `React.createElement` is the
 * whole vocabulary, and the styling below is the theme's own CSS variables so
 * the page is correct in light and dark without a hard-coded colour.
 */

/** The route `lib/bot.js` serves the configuration on. */
const SETTINGS_URL = '/api/feishu-bot/config'

const SECTIONS = [
  {
    title: '凭据',
    note: 'appId / appSecret 通过环境变量传给桥接子进程，改动会自动重连（几秒内）。密钥只显示“已设置”，不回传明文，留空即不修改。',
    fields: [
      { key: 'appId', label: 'App ID', type: 'text', placeholder: 'cli_xxxxxxxxxxxxxxxx' },
      { key: 'appSecret', label: 'App Secret', type: 'secret' },
    ],
  },
  {
    title: '连接',
    note: 'ws 是长连接，不需要公网地址；webhook 需要 DSH 跑在有公网 HTTPS 的机器上。切换会重连。',
    fields: [
      {
        key: 'transport', label: '传输方式', type: 'select',
        options: [
          ['ws', 'ws — 长连接（默认）', 'DSH 主动外连飞书，不需要公网地址、不需要隧道，换网络也不用改回调地址。'],
          ['webhook', 'webhook — 请求地址', '飞书把事件 POST 到 DSH 的 HTTPS 地址。需要 DSH 跑在有公网 HTTPS 的机器上；本机 127.0.0.1 飞书够不到。'],
          ['both', 'both — 两者都要', '同时启用长连接与请求地址两条入站链路。'],
        ],
      },
    ],
  },
  {
    title: '会话',
    note: '新聊天默认用这里的工作区与预设；聊天里用 /ws 可以单独切换。permissionPreset 不追溯已存在的会话。',
    fields: [
      { key: 'workspacePath', label: '默认工作区', type: 'text', placeholder: '/absolute/path' },
      /*
       * Wording copied VERBATIM from DSH so this page and the product say the
       * same thing. Sources:
       *   preset names   packages/client/ui-agent-preset/src/client/locales.ts
       *   descriptions   the same file plus each preset's own preset.yml
       *   permissions    packages/client/ui-permission-presets/src/client/locales.ts
       */
      {
        key: 'agentPreset', label: 'Agent 预设', type: 'select',
        options: [
          ['standard', '标准模式', '功能完整的编码 Agent，支持文件编辑、Shell、文件与网页检索、Skills、计划、目标、子代理和工作流。'],
          ['ptc', 'PTC 模式', '功能完整的编码 Agent，但默认不提供 workflow 工具；其他工具通过 PTC 模式 SDK 呈现，让模型用一个 TypeScript 程序组合多步操作。'],
          ['minimal', '极简模式', '仅提供持久 shell 的单工具编码 Agent。'],
          ['cordis', '创造模式', '用于创建自定义 Agent preset：具备标准模式的全部能力，并提供运行时检查、插件实验和 preset 创作指导。'],
        ],
      },
      /*
       * DSH's own Permission row offers exactly three presets. The EMPTY value
       * is this plugin's own state — '' makes the bridge inherit whatever policy
       * the deployment configured — so it is kept and labelled as what it is.
       */
      {
        key: 'permissionPreset', label: '权限预设', type: 'select',
        options: [
          ['', '跟随部署（留空）', '插件不指定权限模式，沿用 DSH 本部署自己的策略。DSH 自身的权限设置里没有这一项。'],
          ['read-only', '仅可查看', '只读，不允许任何修改。'],
          ['workspace-write', '工作区内修改', '只能改动工作区内的文件。'],
          ['danger-full-access', '完全权限', '减少确认步骤，并可直接执行更多操作，包括敏感操作、文件修改或外部命令。'],
        ],
      },
    ],
  },
  {
    title: '回复',
    note: '改这些不会断开长连接，下一条回复就按新设置走。',
    fields: [
      { key: 'groupRequireMention', label: '群里需要 @ 机器人', type: 'boolean' },
      {
        key: 'replyStyle', label: '回复形式', type: 'select',
        options: [
          ['card', 'card — 交互卡片', '默认。表格会重建为飞书原生 table 元素，底部可显示耗时 / 上下文 / 缓存。'],
          ['text', 'text — 纯文本', '只发纯文本，不带卡片格式；表格会退化成对齐的代码块。'],
        ],
      },
      { key: 'acknowledge', label: '先回执「收到」', type: 'boolean' },
      { key: 'cardHeader', label: '卡片显示标题栏', type: 'boolean' },
      { key: 'replyMetrics', label: '卡片底部显示耗时 / 上下文 / 缓存', type: 'boolean' },
    ],
  },
]

const CSS = [
  '.feicfg { display: flex; flex-direction: column; gap: 20px; max-width: 760px; padding: 2px 2px 40px; font-size: 13px; color: var(--dsw-alias-label-primary); }',
  '.feicfg-head { display: flex; flex-direction: column; gap: 6px; }',
  '.feicfg-title { font-size: 15px; font-weight: 600; }',
  '.feicfg-card { display: flex; flex-direction: column; gap: 12px; padding: 14px 16px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; background: var(--dsw-alias-bg-layer-1); }',
  '.feicfg-card-title { font-weight: 600; }',
  '.feicfg-note { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.5; }',
  '.feicfg-row { display: flex; flex-direction: column; gap: 5px; }',
  '.feicfg-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }',
  '.feicfg-input, .feicfg-select { width: 100%; max-width: 420px; box-sizing: border-box; padding: 7px 9px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); font-size: 13px; font-family: inherit; }',
  '.feicfg-input:focus, .feicfg-select:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }',
  '.feicfg-check { display: flex; align-items: center; gap: 8px; }',
  '.feicfg-check input { width: 14px; height: 14px; accent-color: var(--dsw-alias-brand-primary); }',
  '.feicfg-actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
  '.feicfg-btn { padding: 7px 14px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 7px; background: var(--dsw-alias-bg-layer-2); color: var(--dsw-alias-label-primary); font-size: 13px; font-family: inherit; cursor: pointer; }',
  '.feicfg-btn:hover:not(:disabled) { border-color: var(--dsw-alias-border-l2); }',
  '.feicfg-btn:disabled { opacity: 0.5; cursor: default; }',
  '.feicfg-btn-primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: #fff; font-weight: 600; }',
  '.feicfg-msg { font-size: 12px; line-height: 1.6; white-space: pre-wrap; }',
  '.feicfg-msg-ok { color: var(--dsw-alias-state-success-primary); }',
  '.feicfg-msg-err { color: var(--dsw-alias-state-error-primary); }',
  '.feicfg-msg-warn { color: var(--dsw-alias-state-warn-primary); }',
  '.feicfg-panel { display: flex; flex-direction: column; gap: 10px; padding: 12px 14px; border: 1px solid var(--dsw-alias-state-error-primary); border-radius: 10px; }',
  '.feicfg-secret-set { color: var(--dsw-alias-state-success-primary); }',
].join('\n')

window.__ModuleLoader__.load({
  id: 'dsh-plugin-feishu-bot',
  factory: function (require) {
    var module = { exports: {} }

    var React = require('react')

    /*
     * CSS, injected the same way a built bundle does it.
     *
     * DSH's own client packages get their CSS from a lightningcss step that
     * inlines each `*.module.css` as a string and appends a `<style>` tag keyed
     * by `data-plugin-css` — there is no `ctx.styles` on this side of the
     * boundary (that is the dynamic runner's builtin). A hand-written bundle has
     * no build step, so it does the same thing by hand:
     *
     *   const tagId = "…/PermissionRow.module.css"
     *   if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) { … }
     *
     * The guard matters: this factory can run more than once in a page's life,
     * and a second identical tag would double every rule.
     *
     * Every `--dsw-alias-*` variable below was checked against the real token
     * file (packages/client/ui-theme/src/styles/design-platform.css, 79 aliases);
     * an invented name would silently render as no colour at all.
     */
    var CSS_TAG_ID = 'dsh-plugin-feishu-bot/client.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG_ID) + ']') === null) {
      var styleTag = document.createElement('style')
      styleTag.setAttribute('data-plugin-css', CSS_TAG_ID)
      styleTag.textContent = CSS
      document.head.appendChild(styleTag)
    }

    function describe(error) {
      if (error === null || error === undefined) return '未知错误'
      if (typeof error === 'string') return error
      if (error.message !== undefined) return String(error.message)
      return String(error)
    }

    /**
     * One request to the host half.
     *
     * Resolves to an outcome rather than rejecting, because every caller has to
     * render something either way and a thrown error would only be caught one
     * line later. `fetch` is same-origin and the browser attaches the GUI's
     * cookie automatically; `credentials: 'same-origin'` states that on purpose
     * rather than relying on the default.
     */
    function callApi(method, body) {
      var options = { method: method, credentials: 'same-origin', headers: { accept: 'application/json' } }
      if (body !== undefined) {
        options.headers['content-type'] = 'application/json'
        options.body = JSON.stringify(body)
      }
      var startedAt = Date.now()
      return fetch(SETTINGS_URL, options).then(function (response) {
        return response.json().then(function (payload) {
          return { status: response.status, payload: payload, elapsed: Date.now() - startedAt, error: null }
        }, function () {
          return { status: response.status, payload: null, elapsed: Date.now() - startedAt, error: 'HTTP ' + String(response.status) + ' 的响应不是 JSON' }
        })
      }, function (error) {
        return { status: 0, payload: null, elapsed: Date.now() - startedAt, error: describe(error) }
      })
    }

    function FeishuSettings() {
      var state = React.useState({ phase: 'loading', data: null, draft: {}, busy: '', notice: null, elapsed: 0 })
      var current = state[0]
      var setState = state[1]

      var load = function (isRetry) {
        setState(function (previous) {
          return Object.assign({}, previous, { phase: 'loading', notice: null, elapsed: 0 })
        })
        callApi('GET').then(function (outcome) {
          var payload = outcome.payload
          if (outcome.error !== null || payload === null || payload.ok !== true) {
            var message = outcome.error !== null
              ? outcome.error
              : (typeof payload.error === 'string' ? payload.error : '接口返回了意外的结果')
            setState({ phase: 'error', data: null, draft: {}, busy: '', elapsed: outcome.elapsed, notice: { kind: 'err', text: (isRetry === true ? '重试仍然失败：' : '') + message } })
            return
          }
          setState({ phase: 'ready', data: payload, draft: Object.assign({}, payload.fields), busy: '', notice: null, elapsed: outcome.elapsed })
        })
      }

      React.useEffect(function () {
        load(false)
      }, [])

      var set = function (key, value) {
        setState(function (previous) {
          var draft = Object.assign({}, previous.draft)
          draft[key] = value
          return Object.assign({}, previous, { draft: draft })
        })
      }

      /* Only real changes are sent, and an untouched secret is never one of them.
       * A null (absent) field compares as the empty string so leaving an empty
       * box alone does not look like a change. */
      var changed = function () {
        if (current.data === null) return []
        var out = []
        var keys = Object.keys(current.draft)
        for (var i = 0; i < keys.length; i += 1) {
          var key = keys[i]
          var next = current.draft[key]
          if (key === 'appSecret' || key === 'encryptKey' || key === 'verificationToken') {
            if (typeof next === 'string' && next !== '') out.push(key)
            continue
          }
          var before = current.data.fields[key]
          if (next !== before && !(next === '' && (before === null || before === undefined))) out.push(key)
        }
        return out
      }

      var doSave = function () {
        var keys = changed()
        if (keys.length === 0) {
          setState(function (previous) { return Object.assign({}, previous, { notice: { kind: 'warn', text: '没有检测到改动' } }) })
          return
        }
        var updates = {}
        for (var i = 0; i < keys.length; i += 1) updates[keys[i]] = current.draft[keys[i]]
        setState(function (previous) { return Object.assign({}, previous, { busy: 'save', notice: null }) })
        callApi('POST', { updates: updates }).then(function (outcome) {
          var payload = outcome.payload
          if (outcome.error !== null || payload === null || payload.ok !== true) {
            var message = outcome.error !== null
              ? outcome.error
              : (typeof payload.error === 'string' ? payload.error : '保存失败')
            setState(function (previous) { return Object.assign({}, previous, { busy: '', notice: { kind: 'err', text: '保存失败：' + message } }) })
            return
          }
          var lines = ['已保存：' + keys.join('、')]
          var notices = Array.isArray(payload.notices) ? payload.notices : []
          for (var n = 0; n < notices.length; n += 1) lines.push(notices[n])
          lines.push(payload.bridgeAffected === true
            ? '涉及桥接，插件会在几秒内重连长连接'
            : '已写入 config.json，下一条回复就按新设置走')
          lines.push('（用时 ' + String(outcome.elapsed) + ' ms）')
          setState(function (previous) {
            var draft = Object.assign({}, previous.draft)
            if (payload.fields !== null && payload.fields !== undefined) {
              var fieldKeys = Object.keys(payload.fields)
              for (var f = 0; f < fieldKeys.length; f += 1) draft[fieldKeys[f]] = payload.fields[fieldKeys[f]]
            }
            draft.appSecret = ''
            return Object.assign({}, previous, {
              busy: '', draft: draft,
              data: Object.assign({}, previous.data, { fields: payload.fields, secretsSet: payload.secretsSet }),
              notice: { kind: 'ok', text: lines.join('\n') },
            })
          })
        })
      }

      var children = []
      children.push(React.createElement('div', { className: 'feicfg-head', key: 'head' },
        React.createElement('div', { className: 'feicfg-title', key: 'title' }, '飞书机器人'),
        React.createElement('div', { className: 'feicfg-note', key: 'sub' }, '这些是插件数据目录里的 config.json。保存后立即生效；改凭据或传输方式会重连长连接。'),
      ))

      if (current.phase === 'loading') {
        children.push(React.createElement('div', { className: 'feicfg-note', key: 'loading' }, '正在读取配置…'))
      }

      if (current.phase === 'error') {
        children.push(React.createElement('div', { className: 'feicfg-panel', key: 'error' },
          React.createElement('div', { className: 'feicfg-msg feicfg-msg-err', key: 'msg' }, current.notice === null ? '读取失败' : current.notice.text),
          React.createElement('div', { className: 'feicfg-actions', key: 'acts' },
            React.createElement('button', { className: 'feicfg-btn', type: 'button', onClick: function () { load(true) } }, '重试'),
          ),
        ))
      }

      if (current.phase === 'ready' && current.data !== null) {
        for (var s = 0; s < SECTIONS.length; s += 1) {
          var section = SECTIONS[s]
          var rows = []
          for (var f = 0; f < section.fields.length; f += 1) {
            var field = section.fields[f]
            var value = current.draft[field.key]

            if (field.type === 'boolean') {
              rows.push(React.createElement('div', { className: 'feicfg-row', key: field.key },
                React.createElement('label', { className: 'feicfg-check' },
                  React.createElement('input', {
                    type: 'checkbox',
                    checked: value === true,
                    onChange: function (event) { set(field.key, event.target.checked) },
                  }),
                  React.createElement('span', null, field.label),
                ),
              ))
              continue
            }

            var control = null
            if (field.type === 'select') {
              var options = []
              for (var o = 0; o < field.options.length; o += 1) {
                var triple = field.options[o]
                var optionProps = { value: triple[0], key: triple[0] }
                if (triple[2] !== undefined) optionProps.title = triple[2]
                options.push(React.createElement('option', optionProps, triple[1]))
              }
              control = React.createElement('select', {
                className: 'feicfg-select',
                value: value === undefined || value === null ? '' : String(value),
                onChange: function (event) { set(field.key, event.target.value) },
              }, options)
            } else if (field.type === 'secret') {
              var isSet = Array.isArray(current.data.secretsSet) && current.data.secretsSet.indexOf(field.key) >= 0
              control = React.createElement('input', {
                className: 'feicfg-input',
                type: 'password',
                autoComplete: 'new-password',
                value: value === undefined || value === null ? '' : String(value),
                placeholder: isSet ? '已设置（留空表示不修改）' : '尚未设置',
                onChange: function (event) { set(field.key, event.target.value) },
              })
            } else {
              var inputProps = {
                className: 'feicfg-input',
                type: 'text',
                value: value === undefined || value === null ? '' : String(value),
                onChange: function (event) { set(field.key, event.target.value) },
              }
              if (field.placeholder !== undefined) inputProps.placeholder = field.placeholder
              control = React.createElement('input', inputProps)
            }

            var labelChildren = [field.label]
            if (field.type === 'secret' && Array.isArray(current.data.secretsSet) && current.data.secretsSet.indexOf(field.key) >= 0) {
              labelChildren.push(React.createElement('span', { className: 'feicfg-secret-set', key: 'set' }, ' · 已设置'))
            }
            rows.push(React.createElement('div', { className: 'feicfg-row', key: field.key },
              React.createElement('div', { className: 'feicfg-label' }, labelChildren),
              control,
            ))
          }

          var cardChildren = [React.createElement('div', { className: 'feicfg-card-title', key: 't' }, section.title)]
          if (section.note !== undefined) cardChildren.push(React.createElement('div', { className: 'feicfg-note', key: 'n' }, section.note))
          for (var r = 0; r < rows.length; r += 1) cardChildren.push(rows[r])
          children.push(React.createElement('div', { className: 'feicfg-card', key: section.title }, cardChildren))
        }

        var dirty = changed()
        var noticeClass = current.notice === null ? '' : (current.notice.kind === 'ok' ? 'feicfg-msg-ok' : current.notice.kind === 'err' ? 'feicfg-msg-err' : 'feicfg-msg-warn')
        children.push(React.createElement('div', { className: 'feicfg-actions', key: 'actions' },
          React.createElement('button', {
            className: 'feicfg-btn feicfg-btn-primary',
            type: 'button',
            disabled: current.busy !== '' || dirty.length === 0,
            onClick: doSave,
          }, current.busy === 'save' ? '保存中…' : (dirty.length === 0 ? '保存' : '保存（' + dirty.length + ' 项改动）')),
          React.createElement('button', {
            className: 'feicfg-btn',
            type: 'button',
            disabled: current.busy !== '',
            onClick: function () { load(true) },
          }, '重新读取'),
        ))

        if (current.notice !== null) {
          children.push(React.createElement('div', { className: 'feicfg-msg ' + noticeClass, key: 'notice' }, current.notice.text))
        }
      }

      return React.createElement('div', { className: 'feicfg' }, children)
    }

    module.exports.apply = function (ctx) {
      ctx.slots.inject('settings.section', function () {
        return ctx.slots.register({
          name: 'settings.section',
          id: 'feishu-bot',
          order: 50,
          label: '飞书机器人',
        }, FeishuSettings)
      })
    }

    /* The real Cordis service injection for this browser module; the `inject`
     * under `dsh.client` in package.json is documentation, not a dependency. */
    module.exports.inject = ['slots']

    return module.exports
  },
})
