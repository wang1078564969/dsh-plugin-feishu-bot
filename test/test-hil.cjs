/*
 * The human-in-the-loop seam: the questions and permission requests the bot
 * forwards into a Feishu chat, the cards it renders them as, and the way it
 * reads the reply back — index, exact label, or free text — into the answer
 * DSH is waiting for.
 *
 * Two waterfalls feed it. `user-questions/request` carries `ask_user_question`;
 * `approval/request` carries a tool call that needs a permission decision. A
 * browser answerer composes onto the same waterfall at boot, so the bot claims
 * ONLY a session with a Feishu-driven turn in flight — the person who must
 * answer is the one who sent the message, and a request raised by a GUI-driven
 * turn still belongs to the GUI. Everything below is about that contract:
 * which request is claimed, what the chat sees, what the reply means, what
 * happens when the turn is aborted, and how the per-turn ceiling behaves while
 * a human is being asked.
 *
 * The suite does not restate any of it. It slices the HIL region out of the
 * real host.js, wraps it in stub globals (there is no Cordis service, and no
 * session, in a script), and drives the exported functions. Editing host.js
 * changes the result here.
 *
 * Run: node tests/test-hil.cjs        (from any working directory)
 */
'use strict'

const fs = require('fs')
const path = require('path')

const HOST = path.join(__dirname, '..', 'lib', 'bot.js')
const SCRATCH = path.join(__dirname, '.scratch')
const HARNESS = path.join(SCRATCH, 'hil-under-test.cjs')

const src = fs.readFileSync(HOST, 'utf8')

/**
 * The real source, between two literal markers, inclusive of both. A marker
 * that is no longer there is a hard error, by name: a silently empty slice
 * would turn this suite into a test of nothing.
 */
function slice(startMarker, endMarker) {
  const from = src.indexOf(startMarker)
  if (from === -1) throw new Error('start marker not found in host.js: ' + JSON.stringify(startMarker))
  const to = src.indexOf(endMarker, from + startMarker.length)
  if (to === -1) {
    throw new Error('end marker not found in host.js after ' + JSON.stringify(startMarker) + ': ' + JSON.stringify(endMarker))
  }
  return src.slice(from, to + endMarker.length)
}

/* The plan-review cap, sliced so a change to it shows up as a failure. */
const detailMaxChars = slice('const DETAIL_MAX_CHARS =', '\n')
/* How long the tree must be silent before a turn counts as settled. */
const settleMs = slice('const SETTLE_MS =', '\n')

/**
 * The HIL block is contiguous in host.js, so one slice brings the whole
 * neighbourhood: `parentSessionOf`/`liveTree`/`quietFor` (the ceiling is
 * measured in silence), `delay`/`waitForWorkToSettle` (unused here, already
 * covered by test-settle.cjs) and `flushStrandedText` (both blocking seams
 * call it before they show a card).
 */
const hil = slice(
  '    function chatForSession(sessionId) {',
  '        return outcome === undefined ? next() : outcome\n      })\n    }'
)

/* If a function ever leaves the sliced region, say which one. */
const REQUIRED = [
  'chatForSession', 'pendingForSession', 'armTurnTimer', 'questionTitle', 'questionText', 'questionHint',
  'approvalText', 'approvalChoice', 'readChoice', 'looksLikeAnswer', 'questionError', 'finishPending',
  'watchAbort', 'postPendingCard', 'patchPendingCard', 'cancelPendingInteraction', 'acceptAnswer',
  'tryAnswerPending', 'askQuestionsOnFeishu', 'askApprovalOnFeishu', 'claimTarget', 'answerUserQuestion',
  'answerApproval',
]
const absent = REQUIRED.filter(function (name) { return hil.indexOf('function ' + name + '(') === -1 })
if (absent.length > 0) throw new Error('the HIL slice in host.js no longer contains: ' + absent.join(', '))

/*
 * Everything the sliced code reaches for that a script has to supply: the chat
 * table, the pending/interaction state, and the outbound Feishu calls. The
 * stubs record rather than send, so "what did the chat actually see" has an
 * exact answer.
 */
const prelude = `
const chats = {
  'oc_p2p': { sessionId: 'feishu-oc_p2p-g1', generation: 1, chatType: 'p2p' },
  'oc_grp': { sessionId: 'feishu-oc_grp', generation: 0, chatType: 'group' },
}
const config = { useReply: true, groupRequireMention: true }
const pendings = new Map()
const activeTurns = new Set()
const lastInbound = new Map([['oc_p2p', 'om_asked_from']])
/** Text a turn produced before its question; left empty, the flush is a no-op. */
const captures = new Map()
/** Last event time per session, read by quietFor. */
const lastActivity = new Map()
const logged = []
function log() { logged.push(Array.prototype.join.call(arguments, ' ')) }
function describeError(e) { return String(e && e.message ? e.message : e) }
function j(v) { return JSON.stringify(v) }
async function flushLog() {}
function cardJson(markdown, entry, options) { return JSON.stringify({ markdown: markdown, footer: options && options.footer }) }
function textJson(text) { return JSON.stringify({ text: text }) }
function extractText(message) { return message && typeof message.text === 'string' ? message.text : '' }
function stripMentions(text) { return text.replace(/@_user_[0-9]+/g, '').replace(/\\s+/g, ' ').replace(/^\\s+|\\s+$/g, '') }
function botWasMentioned(message) { return message.mentioned === true }
function effectiveTimeout() { return 1000 }
function svc(name) {
  if (name !== 'agents') throw new Error('unexpected service ' + name)
  return { list: function () { return [] } }
}

/* Outbound traffic: one array, cards and hints alike, as they were sent. */
const sent = []
let messageSeq = 0
async function send(chatId, msgType, content, replyTo) {
  messageSeq += 1
  const parsed = JSON.parse(content)
  sent.push({ chatId: chatId, msgType: msgType, markdown: parsed.markdown === undefined ? parsed.text : parsed.markdown, footer: parsed.footer, replyTo: replyTo, id: 'om_' + messageSeq })
  return { code: 0, data: { message_id: 'om_' + messageSeq } }
}
async function sendText(chatId, messageId, body) { sent.push({ chatId: chatId, kind: 'hint', markdown: body }); return { code: 0 } }
const patched = []
async function patchCard(messageId, markdown, entry, options) { patched.push({ messageId: messageId, markdown: markdown }); return { code: 0 } }

/* Fiber-owned timers, recorded and fired by hand: no test waits on a clock. */
const timers = []
const ctx = {
  timeout: function (callback, ms) {
    const record = { callback: callback, ms: ms, killed: false }
    timers.push(record)
    return function () { record.killed = true }
  },
}
`

const epilogue = `
module.exports = {
  chats, config, pendings, activeTurns, lastInbound, captures, lastActivity, logged, sent, patched, timers, ctx,
  describeError,
  chatForSession, pendingForSession, quietFor, armTurnTimer,
  questionTitle, questionText, questionHint, approvalText, approvalChoice, readChoice, looksLikeAnswer,
  finishPending, postPendingCard, patchPendingCard, cancelPendingInteraction, acceptAnswer,
  tryAnswerPending, askQuestionsOnFeishu, askApprovalOnFeishu,
  claimTarget, answerUserQuestion, answerApproval,
  reset: function () {
    pendings.clear(); activeTurns.clear()
    lastInbound.clear(); lastInbound.set('oc_p2p', 'om_asked_from')
    captures.clear(); lastActivity.clear()
    logged.length = 0; sent.length = 0; patched.length = 0
    timers.length = 0; messageSeq = 0
  },
}
`

fs.mkdirSync(SCRATCH, { recursive: true })
fs.writeFileSync(HARNESS, detailMaxChars + '\n' + settleMs + '\n' + prelude + '\n' + hil + '\n' + epilogue)
const M = require(HARNESS)

/*
 * The recovered suite ran 78 assertions. The count is not part of the output
 * (the recorded run has none), so a drift is reported on stderr rather than
 * smuggled in as one more `ok` line.
 */
const EXPECTED_ASSERTIONS = 78

let ran = 0
let failed = 0
function check(name, ok, detail) {
  ran += 1
  if (ok === true) {
    console.log('  ok   ' + name)
    return
  }
  failed += 1
  console.log('  FAIL ' + name + (detail === undefined ? '' : '\n       ' + detail))
}

const P2P = 'oc_p2p'
const GRP = 'oc_grp'
const P2P_SESSION = 'feishu-oc_p2p-g1'
const GRP_SESSION = 'feishu-oc_grp'

/** What the chat saw: cards are everything that is not a hint. */
const cards = () => M.sent.filter((entry) => entry.kind !== 'hint')
const hints = () => M.sent.filter((entry) => entry.kind === 'hint')

let replySeq = 0
const msg = (text) => {
  replySeq += 1
  return { chat_id: P2P, message_id: 'om_reply_' + replySeq, text: text, chat_type: 'p2p' }
}
const groupMsg = (text, mentioned) => {
  replySeq += 1
  return { chat_id: GRP, message_id: 'om_reply_' + replySeq, text: text, chat_type: 'group', mentioned: mentioned === true }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

const P2P_TARGET = () => ({ chatId: P2P, entry: M.chats[P2P] })
const GRP_TARGET = () => ({ chatId: GRP, entry: M.chats[GRP] })
const agentOf = (sessionId) => ({ session: { id: sessionId } })

/** The question most rounds ask: two options, each with its own description. */
const DEPLOY = {
  id: 'deploy-target',
  question: '把服务部署到哪里？',
  options: [
    { label: '内网', description: '只在内网可达' },
    { label: '公网', description: '对外可访问' },
  ],
}

const patchOf = (cardId) => M.patched.filter((entry) => entry.messageId === cardId).pop()

/**
 * Attach the outcome handlers the moment a round starts. A question can be
 * rejected while the test is still waiting for its card, and a rejection with
 * no handler attached yet takes the whole process down.
 */
const record = (promise) => promise.then(
  (value) => ({ value: value, error: null }),
  (error) => ({ value: null, error: error })
)

async function main() {
  /* ---------------------------------------------------------------- *
   * one reply, read against one question
   * ---------------------------------------------------------------- */
  const ITEM = { id: 'pick', question: '选一个', options: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }] }
  const MULTI = { id: 'pick-many', question: '选几个', multiSelect: true, options: [{ label: 'Alpha' }, { label: 'Beta' }, { label: 'Gamma' }] }
  const OPEN = { id: 'open', question: '还有什么想说的？' }

  const byIndex = M.readChoice(ITEM, '2')
  check('index picks that option',
    byIndex.selected.length === 1 && byIndex.selected[0] === 'Beta' && byIndex.custom === undefined,
    JSON.stringify(byIndex))

  const firstOfTwo = M.readChoice(ITEM, '3 1')
  check('single-select keeps only the first of two numbers',
    firstOfTwo.selected.length === 1 && firstOfTwo.selected[0] === 'Gamma' && firstOfTwo.custom === undefined,
    JSON.stringify(firstOfTwo))

  const both = M.readChoice(MULTI, '1 3')
  check('multi-select keeps both',
    both.selected.length === 2 && both.selected[0] === 'Alpha' && both.selected[1] === 'Gamma' && both.custom === undefined,
    JSON.stringify(both))

  const separators = ['1,3', '1，3', '1、3', '1;3', '1；3', '1/3', '1 3']
  const separated = separators.map((text) => M.readChoice(MULTI, text))
  check('separators are all accepted',
    separated.every((choice) => choice.selected.join('+') === 'Alpha+Gamma'),
    JSON.stringify(separators.map((text, i) => [text, separated[i].selected])))

  const labelled = M.readChoice(ITEM, 'Beta')
  check('exact label selects',
    labelled.selected.length === 1 && labelled.selected[0] === 'Beta' && labelled.custom === undefined,
    JSON.stringify(labelled))

  const cased = M.readChoice(ITEM, 'bEtA')
  check('label match ignores case',
    cased.selected.length === 1 && cased.selected[0] === 'Beta' && cased.custom === undefined,
    JSON.stringify(cased))

  const outOfRange = M.readChoice(ITEM, '9')
  check('out-of-range number is free text, not a wrap-around',
    outOfRange.selected.length === 0 && outOfRange.custom === '9',
    JSON.stringify(outOfRange))

  const free = M.readChoice(ITEM, '都不合适，我再想想')
  check('free text becomes custom with no selection',
    free.selected.length === 0 && free.custom === '都不合适，我再想想',
    JSON.stringify(free))

  const optionless = M.readChoice(OPEN, '就这样吧')
  check('optionless question takes free text',
    optionless.selected.length === 0 && optionless.custom === '就这样吧',
    JSON.stringify(optionless))

  const nothing = M.readChoice(ITEM, '')
  check('no answer is invented for an empty reply',
    nothing.selected.length === 0 && nothing.custom === '',
    JSON.stringify(nothing))

  /* ---------------------------------------------------------------- *
   * what an unaddressed group message may count as
   * ---------------------------------------------------------------- */
  const groupPending = {
    kind: 'question',
    chatId: GRP,
    sessionId: GRP_SESSION,
    index: 0,
    questions: [{ id: 'g', question: '组里问一句', options: [{ label: '甲' }, { label: '乙' }] }],
  }
  check('group: a bare index counts', M.looksLikeAnswer(groupPending, '2') === true)
  check('group: an exact label counts', M.looksLikeAnswer(groupPending, '甲') === true)
  check('group: chatter does not', M.looksLikeAnswer(groupPending, '大家早上好') === false)
  check('group: an out-of-range number does not', M.looksLikeAnswer(groupPending, '3') === false)
  check('group: /cancel always counts',
    M.looksLikeAnswer(groupPending, '/cancel') === true && M.looksLikeAnswer(groupPending, '/取消') === true)

  check('group: /help does not', M.looksLikeAnswer(groupPending, '/help') === false)

  const approvalPending = { kind: 'approval', chatId: P2P, toolName: 'write_file' }
  check('approval: only the two words',
    M.looksLikeAnswer(approvalPending, '1') === true &&
    M.looksLikeAnswer(approvalPending, '2') === true &&
    M.looksLikeAnswer(approvalPending, '允许') === true &&
    M.looksLikeAnswer(approvalPending, 'yes') === true &&
    M.looksLikeAnswer(approvalPending, '3') === false &&
    M.approvalChoice('1') === 'allowed-once' && M.approvalChoice('允许一次') === 'allowed-once' &&
    M.approvalChoice('2') === 'rejected' && M.approvalChoice('拒绝') === 'rejected' &&
    M.approvalChoice('3') === undefined && M.approvalChoice('allow please') === undefined && M.approvalChoice('') === undefined)

  /* ---------------------------------------------------------------- *
   * the card the chat gets, and the answer that closes it
   * ---------------------------------------------------------------- */
  M.reset()
  const deployRound = M.askQuestionsOnFeishu(P2P_TARGET(), { questions: [DEPLOY] })
  await tick()
  const deployPending = M.pendings.get(P2P)
  const deployCard = cards()[0]
  const deployMarkdown = deployCard === undefined ? '' : deployCard.markdown

  check('a pending record appears for the chat',
    deployPending !== undefined && deployPending.kind === 'question' && deployPending.chatId === P2P &&
    deployPending.sessionId === P2P_SESSION && deployPending.index === 0 && deployPending.done === false,
    JSON.stringify(deployPending && { kind: deployPending.kind, chatId: deployPending.chatId, sessionId: deployPending.sessionId, index: deployPending.index }))

  check('the card is threaded under the message that started the turn',
    deployCard !== undefined && deployCard.msgType === 'interactive' && deployCard.chatId === P2P && deployCard.replyTo === 'om_asked_from',
    JSON.stringify(deployCard))

  check('the card shows the question and both options',
    deployMarkdown.indexOf('把服务部署到哪里？') !== -1 &&
    deployMarkdown.indexOf('**1.** 内网') !== -1 && deployMarkdown.indexOf('**2.** 公网') !== -1,
    deployMarkdown)

  check('option descriptions reach the card',
    deployMarkdown.indexOf('只在内网可达') !== -1 && deployMarkdown.indexOf('对外可访问') !== -1 &&
    deployMarkdown.indexOf('**1.** 内网') < deployMarkdown.indexOf('只在内网可达') &&
    deployMarkdown.indexOf('只在内网可达') < deployMarkdown.indexOf('**2.** 公网') &&
    deployMarkdown.indexOf('**2.** 公网') < deployMarkdown.indexOf('对外可访问'),
    deployMarkdown)

  check('the hint names the range and the escape',
    deployCard !== undefined && deployCard.footer === '回复序号 1-2，或直接回复你的答案；发送 /cancel 取消这次提问。',
    deployCard && JSON.stringify(deployCard.footer))

  check('the hint is a card note, not the body',
    deployCard !== undefined && deployMarkdown.indexOf('回复序号 1-2') === -1 && deployMarkdown.indexOf('/cancel') === -1,
    deployMarkdown)

  const consumed = await M.tryAnswerPending(deployPending, msg('1'))
  check('the answer message is consumed',
    consumed === true && deployPending.answers.length === 1,
    'consumed=' + consumed + ' answers=' + deployPending.answers.length)

  const deployAnswers = await deployRound
  check('the answer batch carries the chosen label',
    deployAnswers.answers.length === 1 && deployAnswers.answers[0].id === 'deploy-target' &&
    deployAnswers.answers[0].selected.length === 1 && deployAnswers.answers[0].selected[0] === '内网' &&
    deployAnswers.answers[0].custom === undefined,
    JSON.stringify(deployAnswers))

  const deployPatch = patchOf(deployCard.id)
  check('the question card is rewritten with the choice',
    deployPatch !== undefined && deployPatch.markdown.endsWith('\n\n**→ 已选择：内网**'),
    deployPatch && JSON.stringify(deployPatch.markdown))

  check('the chat is no longer pending',
    M.pendings.has(P2P) === false && deployPending.done === true,
    'pendings=' + M.pendings.size)

  const freeRound = M.askQuestionsOnFeishu(P2P_TARGET(), { questions: [DEPLOY] })
  await tick()
  await M.tryAnswerPending(M.pendings.get(P2P), msg('先放内网机房吧'))
  const freeAnswers = await freeRound
  check('free text is returned as custom with an empty selection',
    freeAnswers.answers.length === 1 && freeAnswers.answers[0].selected.length === 0 &&
    freeAnswers.answers[0].custom === '先放内网机房吧',
    JSON.stringify(freeAnswers))

  M.reset()
  const openRound = M.askQuestionsOnFeishu(P2P_TARGET(), { questions: [{ id: 'open-q', question: '还有什么要补充的吗？' }] })
  await tick()
  const openCard = cards()[0]
  check('an optionless question says to just reply',
    openCard !== undefined && openCard.footer === '直接回复你的答案；发送 /cancel 取消这次提问。',
    openCard && JSON.stringify(openCard.footer))

  await M.tryAnswerPending(M.pendings.get(P2P), msg('没有了'))
  const openAnswers = await openRound
  check('an optionless answer is custom',
    openAnswers.answers.length === 1 && openAnswers.answers[0].id === 'open-q' &&
    openAnswers.answers[0].selected.length === 0 && openAnswers.answers[0].custom === '没有了',
    JSON.stringify(openAnswers))

  /* ---------------------------------------------------------------- *
   * a batch of questions, asked one card at a time
   * ---------------------------------------------------------------- */
  M.reset()
  const TWO = [
    { id: 'first-q', question: '第一个问题', options: [{ label: '甲' }, { label: '乙' }] },
    { id: 'second-q', question: '第二个问题', options: [{ label: '丙' }, { label: '丁' }] },
  ]
  const batchRound = M.askQuestionsOnFeishu(P2P_TARGET(), { questions: TWO })
  await tick()
  const batchPending = M.pendings.get(P2P)
  check('the first card says 1/2',
    cards().length === 1 && cards()[0].markdown.startsWith('**❓ 需要你确认（第 1/2 个）**'),
    cards()[0] && JSON.stringify(cards()[0].markdown))

  await M.tryAnswerPending(batchPending, msg('2'))
  check('a second card follows the first answer',
    cards().length === 2 && cards()[1].markdown.indexOf('第二个问题') !== -1 &&
    M.pendings.get(P2P) === batchPending && batchPending.index === 1,
    'cards=' + cards().length + ' index=' + batchPending.index)

  check('the second card says 2/2',
    cards().length === 2 && cards()[1].markdown.startsWith('**❓ 需要你确认（第 2/2 个）**'),
    cards()[1] && JSON.stringify(cards()[1].markdown))

  await M.tryAnswerPending(batchPending, msg('丙'))
  const batchAnswers = await batchRound
  check('both answers come back in order',
    batchAnswers.answers.length === 2 &&
    batchAnswers.answers[0].id === 'first-q' && batchAnswers.answers[0].selected[0] === '乙' &&
    batchAnswers.answers[1].id === 'second-q' && batchAnswers.answers[1].selected[0] === '丙',
    JSON.stringify(batchAnswers))

  /* ---------------------------------------------------------------- *
   * another command is not an answer
   * ---------------------------------------------------------------- */
  M.reset()
  const strayRound = M.askQuestionsOnFeishu(P2P_TARGET(), { questions: [DEPLOY] })
  await tick()
  const strayPending = M.pendings.get(P2P)
  const strayConsumed = await M.tryAnswerPending(strayPending, msg('/help'))
  check('another command is consumed but not accepted',
    strayConsumed === true && strayPending.answers.length === 0 && strayPending.index === 0 &&
    strayPending.done === false && cards().length === 1,
    'consumed=' + strayConsumed + ' answers=' + strayPending.answers.length + ' cards=' + cards().length)

  check('the question stays open after a stray command',
    M.pendings.get(P2P) === strayPending && strayPending.cardText.indexOf('把服务部署到哪里？') !== -1,
    'pending=' + (M.pendings.get(P2P) === strayPending))

  const strayHint = hints().pop()
  check('the stray command gets a hint',
    strayHint !== undefined && strayHint.chatId === P2P &&
    strayHint.markdown === '当前还有一个问题没有回答。请回复序号或答案，或发送 /cancel 取消这次提问。',
    JSON.stringify(strayHint))

  await M.tryAnswerPending(strayPending, msg('2'))
  await strayRound

  /* ---------------------------------------------------------------- *
   * /cancel
   * ---------------------------------------------------------------- */
  M.reset()
  const cancelRound = record(M.askQuestionsOnFeishu(P2P_TARGET(), { questions: [DEPLOY] }))
  await tick()
  const cancelPending = M.pendings.get(P2P)
  const cancelCard = cards()[0]
  await M.tryAnswerPending(cancelPending, msg('/cancel'))
  const cancelSettled = await cancelRound
  const cancelOutcome = cancelSettled.value
  const cancelError = cancelSettled.error
  check('/cancel rejects with ASK_CANCELLED',
    cancelOutcome === null && cancelError !== null && cancelError.code === 'ASK_CANCELLED' &&
    cancelError.name === 'UserQuestionError',
    'outcome=' + JSON.stringify(cancelOutcome) + ' error=' + M.describeError(cancelError))

  check('/cancel closes the pending record',
    M.pendings.has(P2P) === false && cancelPending.done === true,
    'pendings=' + M.pendings.size + ' done=' + cancelPending.done)

  const cancelPatch = patchOf(cancelCard.id)
  check('/cancel rewrites the card',
    cancelPatch !== undefined && cancelPatch.markdown.endsWith('**⛔ 已取消这次提问。**'),
    cancelPatch && JSON.stringify(cancelPatch.markdown))

  /* ---------------------------------------------------------------- *
   * in a group, an unaddressed reply is only an answer when it reads
   * like one
   * ---------------------------------------------------------------- */
  M.reset()
  const groupRound = M.askQuestionsOnFeishu(GRP_TARGET(), {
    questions: [{ id: 'grp-q', question: '组里问一句', options: [{ label: '甲' }, { label: '乙' }] }],
  })
  await tick()
  const groupOpen = M.pendings.get(GRP)
  const chatter = await M.tryAnswerPending(groupOpen, groupMsg('大家早上好', false))
  check('group chatter is not consumed', chatter === false, 'consumed=' + chatter)

  check('group chatter leaves the question open',
    M.pendings.get(GRP) === groupOpen && groupOpen.answers.length === 0 && groupOpen.done === false,
    'answers=' + groupOpen.answers.length)

  const bareIndex = await M.tryAnswerPending(groupOpen, groupMsg('1', false))
  check('group: a bare index is consumed', bareIndex === true && groupOpen.answers.length === 1, 'consumed=' + bareIndex)

  const groupAnswers = await groupRound
  check('group: the bare index answered it',
    groupAnswers.answers.length === 1 && groupAnswers.answers[0].id === 'grp-q' && groupAnswers.answers[0].selected[0] === '甲',
    JSON.stringify(groupAnswers))

  M.reset()
  const mentionRound = M.askQuestionsOnFeishu(GRP_TARGET(), {
    questions: [{ id: 'mention-q', question: '他叫什么？', options: [{ label: '小明' }, { label: '小红' }] }],
  })
  await tick()
  const mentionPending = M.pendings.get(GRP)
  const refused = await M.tryAnswerPending(mentionPending, groupMsg('他叫小刚', false))
  check('an unaddressed free-text answer is still refused',
    refused === false && mentionPending.answers.length === 0 && M.pendings.get(GRP) === mentionPending,
    'consumed=' + refused + ' answers=' + mentionPending.answers.length)

  const taken = await M.tryAnswerPending(mentionPending, groupMsg('@_user_1 他叫小刚', true))
  check('an @-mentioned free-text answer is taken',
    taken === true && mentionPending.done === true,
    'consumed=' + taken + ' done=' + mentionPending.done)

  const mentionAnswers = await mentionRound
  check('the mentioned answer is custom',
    mentionAnswers.answers.length === 1 && mentionAnswers.answers[0].id === 'mention-q' &&
    mentionAnswers.answers[0].selected.length === 0 && mentionAnswers.answers[0].custom === '他叫小刚',
    JSON.stringify(mentionAnswers))

  /* ---------------------------------------------------------------- *
   * whose request is it: this chat's, or the GUI's
   * ---------------------------------------------------------------- */
  M.reset()
  const delegated = []
  const delegate = (value) => () => { delegated.push(value); return value }

  const idle = await M.answerUserQuestion({ agent: agentOf(P2P_SESSION), questions: [DEPLOY] }, delegate('gui-idle'))
  check('no turn in flight: the GUI keeps it',
    idle === 'gui-idle' && delegated.length === 1 && cards().length === 0 && M.pendings.size === 0,
    'returned=' + JSON.stringify(idle) + ' delegated=' + delegated.length + ' cards=' + cards().length)

  M.activeTurns.add(P2P_SESSION)
  const headless = await M.answerUserQuestion({ agent: {} }, delegate('gui-headless'))
  const anonymous = await M.answerUserQuestion({ agent: undefined }, delegate('gui-anonymous'))
  check('an agent with no session is not claimed',
    headless === 'gui-headless' && anonymous === 'gui-anonymous' && delegated.length === 3 && cards().length === 0,
    'headless=' + JSON.stringify(headless) + ' anonymous=' + JSON.stringify(anonymous))

  let claimedWentToGui = null
  const claimedRound = M.answerUserQuestion(
    { agent: agentOf(P2P_SESSION), questions: [DEPLOY] },
    (value) => { claimedWentToGui = value; return 'gui-claimed' }
  )
  await tick()
  check('a Feishu turn in flight: the bot claims it',
    M.pendings.has(P2P) === true && claimedWentToGui === null && cards().length === 1 &&
    cards()[0].markdown.indexOf('把服务部署到哪里？') !== -1,
    'pending=' + M.pendings.has(P2P) + ' gui=' + JSON.stringify(claimedWentToGui) + ' cards=' + cards().length)

  M.activeTurns.add('some-gui-session')
  const stranger = await M.answerUserQuestion({ agent: agentOf('some-gui-session') }, delegate('gui-stranger'))
  check('another session is not this bot"s',
    stranger === 'gui-stranger' && delegated.length === 4 && cards().length === 1,
    'returned=' + JSON.stringify(stranger) + ' delegated=' + delegated.length)

  const stacked = await M.answerUserQuestion({ agent: agentOf(P2P_SESSION), questions: [DEPLOY] }, delegate('gui-stacked'))
  check('a second question cannot stack on one chat',
    stacked === 'gui-stacked' && M.pendings.size === 1 && cards().length === 1,
    'returned=' + JSON.stringify(stacked) + ' pendings=' + M.pendings.size)

  const guiAnswer = { answers: [{ id: 'from-gui', selected: ['GUI'] }] }
  let unclaimedCalls = 0
  const unclaimed = await M.answerUserQuestion({ agent: agentOf('nobody-at-all') }, () => {
    unclaimedCalls += 1
    return guiAnswer
  })
  check('an unclaimed question is delegated',
    unclaimed === guiAnswer && unclaimedCalls === 1 && cards().length === 1,
    'identity=' + (unclaimed === guiAnswer) + ' calls=' + unclaimedCalls)

  await M.tryAnswerPending(M.pendings.get(P2P), msg('1'))
  const claimedAnswer = await claimedRound
  check('a claimed question is answered, not delegated',
    claimedWentToGui === null && claimedAnswer.answers.length === 1 &&
    claimedAnswer.answers[0].selected[0] === '内网',
    'gui=' + JSON.stringify(claimedWentToGui) + ' answer=' + JSON.stringify(claimedAnswer))

  /* ---------------------------------------------------------------- *
   * the turn is aborted under the question
   * ---------------------------------------------------------------- */
  M.reset()
  const controller = new AbortController()
  const abortedRound = record(M.askQuestionsOnFeishu(P2P_TARGET(), { questions: [DEPLOY], signal: controller.signal }))
  await tick()
  const abortedPending = M.pendings.get(P2P)
  const abortedCard = cards()[0]
  controller.abort()
  await tick()
  const abortedSettled = await abortedRound
  const abortOutcome = abortedSettled.value
  const abortError = abortedSettled.error
  check('an aborted turn rejects the question',
    abortOutcome === null && abortError !== null && abortError.code === 'ASK_ABORTED' &&
    abortError.name === 'UserQuestionError',
    'outcome=' + JSON.stringify(abortOutcome) + ' error=' + M.describeError(abortError))

  check('an aborted question is dropped from the chat',
    M.pendings.has(P2P) === false && abortedPending.done === true,
    'pendings=' + M.pendings.size + ' done=' + abortedPending.done)

  const abortTrace = patchOf(abortedCard.id)
  check('an aborted question leaves a visible trace on the card',
    abortTrace !== undefined && abortTrace.markdown.endsWith('**⏹️ 本轮已中断，这个问题作废。**'),
    abortTrace && JSON.stringify(abortTrace.markdown))

  const deadController = new AbortController()
  deadController.abort()
  let preAbortError = null
  const cardsBefore = cards().length
  try {
    await M.askQuestionsOnFeishu(P2P_TARGET(), { questions: [DEPLOY], signal: deadController.signal })
  } catch (error) {
    preAbortError = error
  }
  check('an already-aborted request is refused without a card',
    preAbortError !== null && preAbortError.code === 'ASK_ABORTED' &&
    cards().length === cardsBefore && M.pendings.has(P2P) === false,
    'error=' + M.describeError(preAbortError) + ' cards=' + cards().length + '/' + cardsBefore)

  /* ---------------------------------------------------------------- *
   * approvals: allow once, or reject
   * ---------------------------------------------------------------- */
  M.reset()
  M.activeTurns.add(P2P_SESSION)
  const allowRound = M.askApprovalOnFeishu(P2P_TARGET(), { toolName: 'write_file', reason: '要写入工作区外的文件' })
  await tick()
  const allowPending = M.pendings.get(P2P)
  const allowCard = cards()[0]
  check('the approval card names the tool and the reason',
    allowCard !== undefined &&
    allowCard.markdown === '**🔐 需要你批准一个操作**\n工具 `write_file` 需要你决定是否放行。\n\n原因：要写入工作区外的文件\n\n**1.** 允许一次\n\n**2.** 拒绝',
    allowCard && JSON.stringify(allowCard.markdown))

  check('the approval card offers allow-once and reject',
    allowCard !== undefined && allowCard.markdown.endsWith('**1.** 允许一次\n\n**2.** 拒绝') &&
    allowCard.footer === '回复 1 允许一次，2 拒绝；发送 /cancel 取消（按拒绝处理）。' &&
    allowPending !== undefined && allowPending.kind === 'approval' && allowPending.toolName === 'write_file',
    allowCard && JSON.stringify(allowCard.footer))

  await M.tryAnswerPending(allowPending, msg('1'))
  const allowOutcome = await allowRound
  check('replying 1 allows once', allowOutcome === 'allowed-once', JSON.stringify(allowOutcome))

  const allowPatch = patchOf(allowCard.id)
  check('the approval card records the decision',
    allowPatch !== undefined && allowPatch.markdown.endsWith('**✅ 已允许（仅本次）**'),
    allowPatch && JSON.stringify(allowPatch.markdown))

  M.reset()
  const garbledRound = M.askApprovalOnFeishu(P2P_TARGET(), { toolName: 'run_command', reason: '要删除一个目录' })
  await tick()
  const garbledPending = M.pendings.get(P2P)
  let garbledOutcome = null
  garbledRound.then((value) => { garbledOutcome = value })

  const garbledConsumed = await M.tryAnswerPending(garbledPending, msg('或许可以吧'))
  await tick()
  check('an unparsable approval reply is not accepted',
    garbledConsumed === true && garbledOutcome === null && garbledPending.done === false,
    'consumed=' + garbledConsumed + ' outcome=' + JSON.stringify(garbledOutcome) + ' done=' + garbledPending.done)

  const reaskHint = hints().pop()
  check('the approval stays open and asks again',
    M.pendings.get(P2P) === garbledPending && hints().length === 1 && reaskHint !== undefined &&
    reaskHint.markdown === '请回复 1（允许一次）或 2（拒绝）；发送 /cancel 取消。',
    JSON.stringify(hints()))

  const garbledCard = cards()[0]
  await M.tryAnswerPending(garbledPending, msg('/cancel'))
  const garbledCancelled = await garbledRound
  const cancelApprovalPatch = patchOf(garbledCard.id)
  check('/cancel on an approval rejects it',
    garbledCancelled === 'rejected' && cancelApprovalPatch !== undefined &&
    cancelApprovalPatch.markdown.endsWith('**⛔ 已取消，按拒绝处理。**'),
    'outcome=' + JSON.stringify(garbledCancelled))

  M.reset()
  const denyRound = M.askApprovalOnFeishu(P2P_TARGET(), { toolName: 'run_command', reason: '要重启服务' })
  await tick()
  const denyPending = M.pendings.get(P2P)
  const denyCard = cards()[0]
  await M.tryAnswerPending(denyPending, msg('拒绝'))
  const denyOutcome = await denyRound
  const denyPatch = patchOf(denyCard.id)
  check('approval: 拒绝 is a rejection',
    denyOutcome === 'rejected' && denyPending.done === true && denyPatch !== undefined &&
    denyPatch.markdown.endsWith('**⛔ 已拒绝**'),
    'outcome=' + JSON.stringify(denyOutcome))

  M.reset()
  let guiApproval = null
  const delegatedApproval = await M.answerApproval(
    { agent: agentOf(P2P_SESSION) },
    () => { guiApproval = 'gui'; return 'gui-approval' }
  )
  check('an approval for a GUI turn is delegated',
    delegatedApproval === 'gui-approval' && guiApproval === 'gui' && cards().length === 0 && M.pendings.size === 0,
    'returned=' + JSON.stringify(delegatedApproval) + ' cards=' + cards().length)

  /* ---------------------------------------------------------------- *
   * the per-turn ceiling while a human is being asked
   * ---------------------------------------------------------------- */
  const session = { id: P2P_SESSION }
  /* Long enough ago that the ceiling's silence test is satisfied. */
  const startedAt = Date.now() - 60000

  M.reset()
  const cancels = []
  const timer = M.armTurnTimer({ cancel: (reason) => cancels.push(reason) }, session, startedAt)
  check('the timer arms once',
    M.timers.length === 1 && M.timers[0].ms === 1000 && M.timers[0].killed === false && timer.timedOut === false,
    'timers=' + M.timers.length)

  M.timers[0].callback()
  check('with nobody being asked, the ceiling cancels the turn',
    cancels.length === 1 && cancels[0].kind === 'hook' && cancels[0].reason === 'feishu bot timeout' &&
    timer.timedOut === true && M.timers.length === 1,
    JSON.stringify(cancels))

  M.reset()
  const heldCancels = []
  const heldTimer = M.armTurnTimer({ cancel: (reason) => heldCancels.push(reason) }, session, startedAt)
  M.pendings.set(P2P, { chatId: P2P, sessionId: P2P_SESSION, kind: 'question', done: false })
  M.timers[0].callback()
  check('while a question is pending the ceiling re-arms instead',
    heldCancels.length === 0 && M.timers.length === 2 &&
    M.logged.some((line) => line.indexOf('waiting on a human answer') !== -1),
    'cancels=' + JSON.stringify(heldCancels) + ' timers=' + M.timers.length + ' log=' + JSON.stringify(M.logged))

  M.pendings.clear()
  M.timers[1].callback()
  check('the ceiling fires again once the question is gone',
    heldCancels.length === 1 && heldCancels[0].reason === 'feishu bot timeout' && heldTimer.timedOut === true,
    JSON.stringify(heldCancels))

  M.reset()
  const stoppedCancels = []
  const stoppedTimer = M.armTurnTimer({ cancel: (reason) => stoppedCancels.push(reason) }, session, startedAt)
  let stopThrew = false
  stoppedTimer.stop()
  try {
    stoppedTimer.stop()
  } catch (error) {
    stopThrew = true
  }
  M.timers[0].callback()
  check('stopping the timer is idempotent',
    stopThrew === false && stoppedCancels.length === 0 && M.timers.length === 1 &&
    M.timers[0].killed === true && stoppedTimer.timedOut === false,
    'threw=' + stopThrew + ' cancels=' + JSON.stringify(stoppedCancels) + ' timers=' + M.timers.length)

  M.reset()
  M.pendings.set(P2P, { chatId: P2P, sessionId: 'some-other-session', kind: 'question' })
  check('no pending session is found when none exists',
    M.pendingForSession(P2P_SESSION) === undefined && M.pendingForSession('some-other-session') !== undefined,
    'pendings=' + M.pendings.size)

  /* ---------------------------------------------------------------- *
   * what the card renders, on its own
   * ---------------------------------------------------------------- */
  const plan = M.questionText(
    { id: 'plan', question: '这个计划可以吗？', detail: '## 计划\n\n1. 先做 A\n2. 再做 B' },
    0,
    1
  )
  check('a plan review shows the plan itself',
    plan === '**❓ 需要你确认**\n这个计划可以吗？\n\n## 计划\n\n1. 先做 A\n2. 再做 B',
    JSON.stringify(plan))

  const huge = M.questionText({ id: 'huge', question: '批准吗？', detail: 'X'.repeat(9000) }, 0, 1)
  check('an oversized detail is truncated loudly',
    huge.indexOf('X'.repeat(8000)) !== -1 && huge.indexOf('X'.repeat(8001)) === -1 &&
    huge.endsWith('…（内容过长，已截断）'),
    'length=' + huge.length)

  const single = M.questionText({ id: 'single', question: '只有一个问题' }, 0, 1)
  check('a single question carries no counter',
    single === '**❓ 需要你确认**\n只有一个问题',
    JSON.stringify(single))

  const headed = M.questionText({ id: 'headed', header: '部署确认', question: '确定吗？' }, 0, 1)
  check('a header is rendered when given',
    headed === '**❓ 需要你确认**\n**部署确认**\n确定吗？',
    JSON.stringify(headed))

  const numbered = [
    M.questionText({ id: 'n1', question: '第一个' }, 0, 2),
    M.questionText({ id: 'n2', question: '第二个' }, 1, 2),
  ]
  check('a batch question is numbered',
    numbered[0] === '**❓ 需要你确认（第 1/2 个）**\n第一个' &&
    numbered[1] === '**❓ 需要你确认（第 2/2 个）**\n第二个',
    JSON.stringify(numbered))

  if (ran !== EXPECTED_ASSERTIONS) {
    process.stderr.write(
      'note: ' + ran + ' assertions ran; the recovered suite recorded ' + EXPECTED_ASSERTIONS + '\n'
    )
  }
  console.log(failed === 0 ? '\nall assertions passed' : '\n' + failed + ' FAILED')
  process.exitCode = failed === 0 ? 0 : 1
}

main().catch((error) => {
  console.error('harness error:', error)
  process.exit(2)
})
