/**
 * dsh-plugin-masterprompt — host entry (persistent DSH bundle plugin).
 *
 * 人设配置 (per-conversation persona / master prompt):
 * - registers a highest-priority system-prompt section (order -1000, before
 *   the harness identity) whose text is evaluated on EVERY prompt assembly;
 * - the provider reads the assembling conversation's session id from the
 *   assembly context and returns that conversation's persona text only —
 *   other conversations get an empty contribution (standard mode);
 * - subagents inherit through the durable parentSession lineage; new
 *   conversations inherit the last-used persona (frozen eagerly on
 *   agent/created so later switches never rewrite older conversations);
 * - templates + per-conversation selection persist in
 *   %DSH_HOME%/dsh-plugin-masterprompt/state.json across restarts;
 * - a template may carry reference images (stored under
 *   %DSH_HOME%/dsh-plugin-masterprompt/images/): every request of a
 *   conversation using that persona carries the image bytes as a durable
 *   attachment block plus the hand-written description beside them;
 * - serves the composer-box UI API under /dsh-mp/* HTTP routes.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

import { mergeVoice, voiceBlock, voiceOpenerBlock } from './style.js'
import { createPerspectiveParser } from './perspective.js'
import { createUserTranslator } from './translate.js'

export const name = 'dsh-plugin-masterprompt'
export const inject = ['systemPrompt', 'webServer']

const SECTION_NAME = 'masterprompt:persona'
const SECTION_ORDER = -2000
const MAX_TEMPLATE_TEXT = 100000
const MAX_TEMPLATE_NAME = 100
const MAX_BODY_BYTES = 4 * 1024 * 1024
const MAX_UPLOAD_BODY_BYTES = 32 * 1024 * 1024
const MAX_WALK_DEPTH = 32

// ---------- 人设参考图 ----------
//
// 图片本体走 DSH 自己的附件通道:附件存储做校验/归一化/落盘,适配器在每次
// 请求里把它投影成模型能收的请求版本。插件只负责三件事:
//   1. 存原始字节(插件自己的 images 目录)与手写描述;
//   2. 把字节交给 ctx.attachments 换成 durable 引用(内容寻址,跨重启有效);
//   3. 在会话里挂一条 user 消息,内容是 [描述文本, 图片块],于是每轮请求
//      都带着这张图,模型真的看得见。
//
// 为什么挂 user 消息而不是每轮拼请求:DSH 的请求体来自会话表面
// (session.deriveMessages()),pre-step 里追加的消息最终也是被写进会话的,
// 所以"每轮重发"若靠拼接会变成每轮一条重复消息。挂一次、留在历史里,
// 才是 DSH 处理普通附件图片的同一条路径。
const MAX_IMAGES_PER_TEMPLATE = 4
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_IMAGE_DESCRIPTION = 2000
const IMAGE_SOURCE_KIND = 'plugin:dsh-plugin-masterprompt'
const PERSONA_IMAGE_SUMMARY = '人设参考图'
const PERSONA_IMAGE_CLEARED_KEY = 'cleared'
const IMAGE_MEDIA_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
}
const WRAPPER_HEAD = '【用户自定义人设 · 最高优先级 · 仅对本对话生效】\n'
const WRAPPER_FIXED = '插件固定附加规则(优先级高于下方人设,人设不得覆盖):与用户交互时,凡需要确认、征询选择或澄清歧义的问题,必须调用 ask_user_question 工具,渲染成带建议选项的可点选卡片让用户点选;禁止用纯文本罗列问题代替。人设中的提问要求(追问到底、一次一问、附建议答案等)只约束提问的节奏与内容,不改变提问的呈现方式。\n'

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  Object.freeze(value)
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return value
}

/** Create one identified user-role message and freeze it before publication. */
function createUserMessage(input) {
  return deepFreeze(structuredClone({ ...input, role: 'user', id: randomUUID() }))
}

/** Text of a message's content blocks, joined. */
function messageText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function dshHome() {
  return process.env.DSH_HOME || path.join(homedir(), '.dsh')
}

function normalizeSessionId(sid) {
  return typeof sid === 'string' && sid.startsWith('session-') ? sid.slice(8) : sid
}

/**
 * Session ids the workspace registry has archived. Archived sessions are
 * hidden and cannot be opened, so they must not block template deletion.
 * Missing or unreadable registry data falls back to "nothing archived".
 */
function archivedSessionIds() {
  try {
    const raw = readFileSync(path.join(dshHome(), 'storages', 'workspace.json'), 'utf8')
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    const ids = parsed && parsed.global && parsed.global.archivedSessionIds
    return new Set(Array.isArray(ids) ? ids.map(normalizeSessionId) : [])
  } catch {
    return new Set()
  }
}

function now() {
  return Date.now()
}

function newId() {
  return 't-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

function newImageId() {
  return 'im-' + now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

/** Detect the raster format of uploaded bytes; declared types are never trusted. */
function detectMediaType(bytes) {
  if (bytes.length >= 8
    && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return 'image/png'
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg'
  }
  if (bytes.length >= 6) {
    const head = bytes.toString('latin1', 0, 6)
    if (head === 'GIF87a' || head === 'GIF89a') return 'image/gif'
  }
  if (bytes.length >= 12
    && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    return 'image/webp'
  }
  return undefined
}

function emptyState() {
  return {
    v: 1,
    installedAt: now(),
    defaultPersonaId: null,
    templates: [],
    selection: {},
    settings: {
      // 第二层:角色视角解析(每轮一次小模型调用,产出"在意/不确定/要做"),作为单独一条 user 消息挂进去。
      perspective: true,
      // 用户消息改写:把舰长这句话换成"对布洛妮娅说"的版本。默认关,别和解析同时开。
      translateUser: false,
    },
  }
}

/** 插件设置:缺项用默认值补齐,不碰别的字段。 */
function normalizeSettings(settings) {
  const out = { perspective: true, translateUser: false }
  if (settings && typeof settings === 'object') {
    if (typeof settings.perspective === 'boolean') out.perspective = settings.perspective
    if (typeof settings.translateUser === 'boolean') out.translateUser = settings.translateUser
  }
  return out
}

/**
 * 语言习惯表的结构校验:两节,每节一行一条。
 *
 * should —— "我应该这样说"(正面示范)
 * lines  —— "我不能这样说"(负面清单)
 *
 * 以前的 check(字数上限、禁 Markdown、禁第一人称、签名)整段删掉了 ——
 * 那套东西只判形态、不判语言习惯,而且只能在事后记账。
 */
function normalizeStyle(raw, previous) {
  if (raw === undefined) return previous
  if (raw === null) return undefined
  if (typeof raw !== 'object') return previous
  const clean = (list) => (Array.isArray(list)
    ? list.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim()).slice(0, 40)
    : [])
  const out = { lines: clean(raw.lines), should: clean(raw.should), openers: clean(raw.openers) }
  // 前端没带某一节就沿用原来的 —— 保存一次不该抹掉另一半。
  if (!Array.isArray(raw.lines) && previous && Array.isArray(previous.lines)) out.lines = previous.lines
  if (!Array.isArray(raw.should) && previous && Array.isArray(previous.should)) out.should = previous.should
  if (!Array.isArray(raw.openers) && previous && Array.isArray(previous.openers)) out.openers = previous.openers
  return out
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(body)
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (origin === undefined) return true
  const host = req.headers.host
  if (typeof origin !== 'string' || typeof host !== 'string') return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

async function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  const chunks = []
  let size = 0
  for await (const c of req) {
    size += c.length
    if (size > maxBytes) throw new Error('body too large')
    chunks.push(c)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
}

export function apply(ctx) {
  const sessions = ctx.get('sessions')

  // 用户消息改写器:把舰长这句话换成"对布洛妮娅说"的版本,直接替换原消息。
  const perspective = createPerspectiveParser(ctx)
  const translator = createUserTranslator(ctx)
  /** 消息 id → 译文。pre-step 算好,消息落盘时用。 */
  const pendingTranslations = new Map()

  // 每个会话上一次实际走过的路由。pre-step 时本次路由还没定,
  // 解析器只能用"上一次落盘的 header"或"agent.options"里的配置值。
  const sessionRoutes = new Map()
  /** 最近一次见到的路由(任何会话)。会话自己的路由拿不到时的兜底。 */
  let lastRouteSeen = null

  function routeOf(sid) {
    return sessionRoutes.get(sid) || lastRouteSeen
  }

  /** 上一条助手回复的正文,截 300 字。给改写器理解指代用。 */
  function lastAssistantText(sid) {
    try {
      const session = sessions && typeof sessions.get === 'function' ? sessions.get(sid) : undefined
      if (!session || typeof session.deriveMessages !== 'function') return ''
      const list = session.deriveMessages()
      for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i]
        if (!m || m.role !== 'assistant') continue
        const text = messageText(m).trim()
        if (text) return text.slice(0, 300)
      }
    } catch {
      /* 读不到就算了,改写器会退化成"只有这一句" */
    }
    return ''
  }

  // ---------- persistent state ----------
  const dataDir = path.join(dshHome(), 'dsh-plugin-masterprompt')
  const statePath = path.join(dataDir, 'state.json')
  let state
  try {
    mkdirSync(dataDir, { recursive: true })
    const raw = readFileSync(statePath, 'utf8')
    const parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw)
    if (!parsed || typeof parsed !== 'object' || parsed.v !== 1 || !Array.isArray(parsed.templates)) {
      throw new Error('unrecognized state shape')
    }
    state = parsed
    if (typeof state.installedAt !== 'number') state.installedAt = now()
    if (state.selection === undefined || typeof state.selection !== 'object' || state.selection === null) state.selection = {}
    if (state.defaultPersonaId === undefined) state.defaultPersonaId = null
    state.settings = normalizeSettings(state.settings)
    // 旧版本模板没有 images 字段,补成空数组,其余字段不动。
    for (const t of state.templates) {
      if (!t || typeof t !== 'object') continue
      if (!Array.isArray(t.images)) t.images = []
    }
  } catch (e) {
    try {
      renameSync(statePath, statePath + '.corrupt-' + now())
    } catch {
      /* first run: no file to back up */
    }
    state = emptyState()
    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
    } catch {
      /* ignore — handlers below will simply not persist */
    }
  }

  function save() {
    try {
      writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8')
    } catch {
      /* ignore */
    }
  }

  function templateOf(id) {
    for (const t of state.templates) if (t.id === id) return t
    return undefined
  }

  // ---------- 参考图存储 ----------
  //
  // 原始字节放在插件自己的 images 目录,state.json 只记元数据;模型侧的
  // durable 引用由 DSH 附件存储按内容寻址生成,两者互不依赖。
  const imagesDir = path.join(dataDir, 'images')
  try {
    mkdirSync(imagesDir, { recursive: true })
  } catch {
    /* ignore — the first upload reports the failure */
  }

  function imagePathOf(image) {
    return path.join(imagesDir, image.file)
  }

  function imageById(id) {
    for (const t of state.templates) {
      const images = Array.isArray(t.images) ? t.images : []
      for (const image of images) if (image && image.id === id) return image
    }
    return undefined
  }

  function removeImageFile(image) {
    try {
      if (image && typeof image.file === 'string') rmSync(imagePathOf(image), { force: true })
    } catch {
      /* ignore */
    }
  }

  function sessionOf(sid) {
    try {
      return sessions && typeof sessions.get === 'function' ? sessions.get(sid) : undefined
    } catch {
      return undefined
    }
  }

  /** Session id carried by an agent scope (agent.id, or its session header). */
  function scopeIdOf(agent) {
    try {
      if (!agent) return undefined
      if (typeof agent.id === 'string' && agent.id) return agent.id
      const header = agent.session && agent.session.header
      if (header && typeof header.id === 'string' && header.id) return header.id
    } catch {
      /* ignore */
    }
    return undefined
  }

  function parentOf(sid) {
    const s = sessionOf(sid)
    const p = s && s.header ? s.header.parentSession : undefined
    return typeof p === 'string' && p ? p : undefined
  }

  /** Walk the durable lineage for the nearest recorded selection (null = explicit standard). */
  function walkSelection(sid, depth = 0) {
    if (typeof sid !== 'string' || !sid) return undefined
    if (depth > MAX_WALK_DEPTH) return undefined
    if (Object.prototype.hasOwnProperty.call(state.selection, sid)) return state.selection[sid]
    const parent = parentOf(sid)
    if (parent) return walkSelection(parent, depth + 1)
    return undefined
  }

  /** Normalize a stored selection value into an id list (string or array). */
  function normalizeIds(raw) {
    if (typeof raw === 'string' && raw) return [raw]
    if (Array.isArray(raw)) return raw.filter((id) => typeof id === 'string' && id)
    return []
  }

  /**
   * Effective template ids for a conversation (possibly several, applied in
   * stored order), or empty for standard mode. A stored array means a
   * multi-persona selection; a stored string keeps backward compatibility.
   * The safety-net arm covers a post-install top-level session whose
   * creation raced the freeze listener; the listener normally freezes
   * the inherited default at agent/created so later switches never rewrite
   * an older conversation retroactively.
   */
  function effectiveTemplateIds(sid) {
    const sel = walkSelection(sid)
    if (sel !== undefined) return normalizeIds(sel)
    const s = sessionOf(sid)
    const createdAt = s && s.header ? s.header.createdAt : undefined
    if (typeof createdAt === 'number' && typeof state.installedAt === 'number' && createdAt >= state.installedAt) {
      return normalizeIds(state.defaultPersonaId)
    }
    return []
  }

  /** 参与本会话的人设模板(按选择顺序)。 */
  function templatesOf(sid) {
    const list = []
    let ids = effectiveTemplateIds(sid)
    // selection 里既有 "session-xxx" 也有裸 id,两种都试一次。
    if (!ids.length && typeof sid === 'string') {
      const alt = normalizeSessionId(sid)
      if (alt !== sid) ids = effectiveTemplateIds(alt)
    }
    for (const id of ids) {
      const t = templateOf(id)
      if (t) list.push(t)
    }
    return list
  }

  function renderPersona(sid) {
    const templates = templatesOf(sid)
    if (!templates.length) return ''
    const parts = []
    for (const t of templates) {
      if (typeof t.text === 'string' && t.text.trim()) parts.push(t.text.trim())
    }
    if (!parts.length) return ''
    // 语言习惯表:第一人称写的,一行一条,原样注入。
    const block = voiceBlock(mergeVoice(templates))
    if (block) parts.push(block)
    // 参考图不再带任何提示文案 —— 图片本身随请求走,说明就在图片旁边。
    return WRAPPER_HEAD + WRAPPER_FIXED + parts.join('\n\n')
  }

  // ---------- 参考图注入 ----------
  //
  // DSH 的请求体来自会话表面(surface),所以"让模型每轮都看见这张图"只有
  // 一条稳妥路径:把参考图作为一条 user 消息挂进会话。挂一次、留在历史里,
  // 之后每一轮请求都会重新投影这张图(与舰长自己粘贴的图片同一条路径)。
  const attachmentRefs = new Map()
  const imageUnsupportedSessions = new Set()
  const routeCache = new Map()
  // 是否曾经往任何会话里挂过参考图消息:没挂过且模板里也没有图时,整段同步直接跳过,
  // 纯文本人设的会话不承担任何额外开销。
  let personaImageEverInjected = false

  function personaImagesOf(sid) {
    const images = []
    for (const id of effectiveTemplateIds(sid)) {
      const t = templateOf(id)
      if (!t || !Array.isArray(t.images)) continue
      for (const image of t.images) if (image && typeof image.id === 'string') images.push(image)
    }
    return images
  }

  function attachmentStore() {
    try {
      const store = ctx.get('attachments')
      return store && typeof store.saveImages === 'function' ? store : undefined
    } catch {
      return undefined
    }
  }

  /** Durable attachment reference for one stored image, admitted at most once per process. */
  function attachmentRefFor(image) {
    const store = attachmentStore()
    if (!store) return Promise.resolve(undefined)
    let pending = attachmentRefs.get(image.id)
    if (!pending) {
      pending = (async () => {
        const bytes = new Uint8Array(readFileSync(imagePathOf(image)))
        const refs = await store.saveImages([{ data: bytes, mediaType: image.mediaType, name: image.name }])
        return refs[0]
      })()
      attachmentRefs.set(image.id, pending)
      pending.catch(() => {
        if (attachmentRefs.get(image.id) === pending) attachmentRefs.delete(image.id)
      })
    }
    return pending
  }

  /** Whether the routed model declares image input; unknown routes answer false. */
  async function routeSupportsImages(provider, model) {
    if (typeof provider !== 'string' || !provider) return false
    if (typeof model !== 'string' || !model) return false
    let llm
    try {
      llm = ctx.get('llm')
    } catch {
      return false
    }
    if (!llm || typeof llm.listModels !== 'function') return false
    let models
    const cached = routeCache.get(provider)
    if (cached && now() - cached.at < 600000) models = cached.models
    else {
      try {
        models = await llm.listModels(provider)
      } catch {
        return false
      }
      routeCache.set(provider, { at: now(), models })
    }
    if (!Array.isArray(models)) return false
    const entry = models.find((m) => m && m.id === model)
    if (!entry || !Array.isArray(entry.inputModalities)) return false
    return entry.inputModalities.includes('image')
  }

  /** The persona-image message currently carried by a session, if any. */
  function personaImageMessage(session) {
    try {
      const nodes = session.surface.nodes
      for (let i = nodes.length - 1; i >= 0; i--) {
        const event = session.eventAt(nodes[i])
        if (!event || event.type !== 'user/message') continue
        const message = event.data
        if (!message || !message.source || message.source.summary !== PERSONA_IMAGE_SUMMARY) continue
        return {
          seq: event.seq,
          key: typeof message.source.personaImages === 'string' ? message.source.personaImages : '',
        }
      }
    } catch {
      /* ignore */
    }
    return undefined
  }

  function personaImageMessageOf(blocks, key) {
    return createUserMessage({
      content: blocks,
      source: {
        kind: IMAGE_SOURCE_KIND,
        form: 'notice',
        summary: PERSONA_IMAGE_SUMMARY,
        personaImages: key,
      },
    })
  }

  /**
   * Whether the session surface already starts with its system message.
   *
   * DSH v4 requires the first surface node to be the system message — the
   * "protected first surface head". A user/message persisted ahead of it makes
   * the whole log unloadable later:
   *   SessionFormatError: system/message requires a protected first surface head
   */
  function hasProtectedHead(session) {
    try {
      const nodes = session.surface && session.surface.nodes
      if (!Array.isArray(nodes) || nodes.length === 0) return false
      const first = session.eventAt(nodes[0])
      return !!first && first.type === 'system/message'
    } catch {
      return false
    }
  }

  /**
   * Content blocks of a persona-image message: the hand-written description of
   * each image, and the attachment itself when the route accepts images.
   *
   * 这里**没有**"这是人设参考图,不是舰长发的"那段提示了 ——
   * 舰长明确要求删掉。它起的作用只是解释一句元信息,而这句话每轮都出现,
   * 反而把"参考图"这件事抬成了对话里的一条正式发言。
   * 图就在请求里,说明就写在图旁边,模型看得见,不需要再声明一次。
   */
  async function personaImageBlocks(images, allowed) {
    const blocks = []
    for (const image of images) {
      // 图能随请求走就只发图,不再附一句说明;
      // 只有发不出图的时候(模型不支持视觉/附件拿不到)才留一行文字兜底,
      // 否则那张图等于没发,人设参考图整个失效。
      const fallbackText = {
        type: 'text',
        text: '图:' + (image.name || image.id) + (image.description ? ' —— ' + image.description : ''),
      }
      if (!allowed) {
        blocks.push(fallbackText)
        continue
      }
      let ref
      try {
        ref = await attachmentRefFor(image)
      } catch (e) {
        ctx.logger.warn('dsh-plugin-masterprompt: persona image could not be attached: ' + String((e && e.message) || e))
        continue
      }
      if (!ref) {
        blocks.push(fallbackText)
        continue
      }
      blocks.push({ type: 'image', attachment: ref })
    }
    return blocks
  }

  /** Keep exactly one persona-image message in a session, matching the effective persona. */
  async function syncPersonaImages(sid, route) {
    const session = sessionOf(sid)
    if (!session) return
    // 落盘前必须确认 system 消息已经打头:pre-step 兜底路径跑在 step/start 之前,
    // 那时候表面还是空的,硬挂上去就会把 protected head 挡在后面,下次加载直接判 corrupt。
    // 这一轮先跳过,下一轮 system 消息已在,再挂。
    if (!hasProtectedHead(session)) return
    const images = personaImagesOf(sid)
    if (!personaImageEverInjected) {
      const anyImages = state.templates.some((t) => Array.isArray(t.images) && t.images.length > 0)
      if (!anyImages && state.personaImagesUsed !== true) return
    }
    const existing = personaImageMessage(session)
    if (!images.length) {
      if (existing && existing.key !== PERSONA_IMAGE_CLEARED_KEY) {
        session.append('user/message', personaImageMessageOf([
          { type: 'text', text: '【人设参考图】当前对话已恢复标准模式,人设参考图不再随请求发送。' },
        ], PERSONA_IMAGE_CLEARED_KEY), { surfaceOp: { op: 'replace', startSeq: existing.seq, endSeq: existing.seq }, sourceEventSeqs: [existing.seq] })
      }
      return
    }
    const allowed = !imageUnsupportedSessions.has(sid)
      && attachmentStore() !== undefined
      && route !== undefined
      && (await routeSupportsImages(route.provider, route.model))
    const key = images.map((image) => image.id).join(',') + '#' + (allowed ? 'img' : 'txt')
    if (existing && existing.key === key) return
    const blocks = await personaImageBlocks(images, allowed)
    const message = personaImageMessageOf(blocks, key)
    if (existing) {
      session.append('user/message', message, {
        surfaceOp: { op: 'replace', startSeq: existing.seq, endSeq: existing.seq },
        sourceEventSeqs: [existing.seq],
      })
    } else {
      session.append('user/message', message, { surfaceOp: 'append' })
    }
    personaImageEverInjected = true
    if (state.personaImagesUsed !== true) {
      state.personaImagesUsed = true
      save()
    }
  }

  /**
   * Persona-image message for one request only, used while the session surface
   * has no protected system head yet — that is, the first request of a
   * conversation.
   *
   * Such a message must never be persisted at that moment: DSH requires the
   * surface to open with the system message, so a user/message written ahead of
   * it makes the whole log unloadable ("system/message requires a protected
   * first surface head"). Hanging it on this request alone lets the first turn
   * still see the reference image; the durable copy lands once the head exists.
   */
  async function transientPersonaMessage(sid, route) {
    const session = sessionOf(sid)
    if (!session) return undefined
    if (hasProtectedHead(session)) return undefined
    if (personaImageMessage(session) !== undefined) return undefined
    const images = personaImagesOf(sid)
    if (!images.length) return undefined
    if (!personaImageEverInjected) {
      const anyImages = state.templates.some((t) => Array.isArray(t.images) && t.images.length > 0)
      if (!anyImages && state.personaImagesUsed !== true) return undefined
    }
    const allowed = !imageUnsupportedSessions.has(sid)
      && attachmentStore() !== undefined
      && route !== undefined
      && (await routeSupportsImages(route.provider, route.model))
    const key = images.map((image) => image.id).join(',') + '#' + (allowed ? 'img' : 'txt')
    return personaImageMessageOf(await personaImageBlocks(images, allowed), key)
  }

  // ---------- freeze inheritance on agent publication ----------
  const offCreated = ctx.on('agent/created', (payload) => {
    try {
      const agent = payload && payload.agent
      if (!agent) return
      let sid
      try {
        sid = typeof agent.id === 'string' ? agent.id : undefined
        if (!sid && agent.session && agent.session.header) sid = agent.session.header.id
      } catch {
        /* ignore */
      }
      if (typeof sid !== 'string' || !sid) return
      if (Object.prototype.hasOwnProperty.call(state.selection, sid)) return
      const parent = parentOf(sid)
      let value = null
      if (parent) {
        const t = walkSelection(parent)
        const valid = t !== undefined && t !== null && (typeof t === 'string' || Array.isArray(t))
        value = valid ? t : null
      } else {
        const s = sessionOf(sid)
        const createdAt = s && s.header ? s.header.createdAt : undefined
        if (typeof createdAt === 'number' && typeof state.installedAt === 'number' && createdAt >= state.installedAt) {
          value = typeof state.defaultPersonaId === 'string' && state.defaultPersonaId ? state.defaultPersonaId : null
        }
      }
      state.selection[sid] = value
      save()
    } catch (e) {
      ctx.logger.warn('dsh-plugin-masterprompt: agent/created handler failed: ' + String((e && e.message) || e))
    }
  })

  // ---------- highest-priority prompt section ----------
  const offSection = ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    text: (context) => {
      try {
        const sc = context && context.scope
        if (!sc) return ''
        const sid = scopeIdOf(sc)
        if (typeof sid !== 'string' || !sid) return ''
        return renderPersona(sid)
      } catch {
        return ''
      }
    },
  })

  // 首句模板单独一段。order 取正数,排到 system prompt 最末:
  // 那段位置离生成最近,首句采样受它影响最大。
  const OPENER_SECTION_NAME = 'masterprompt:openers'
  const OPENER_SECTION_ORDER = -1900
  const offOpeners = ctx.systemPrompt.section({
    name: OPENER_SECTION_NAME,
    order: OPENER_SECTION_ORDER,
    text: (context) => {
      try {
        const sc = context && context.scope
        if (!sc) return ''
        const sid = scopeIdOf(sc)
        if (typeof sid !== 'string' || !sid) return ''
        return voiceOpenerBlock(mergeVoice(templatesOf(sid)))
      } catch {
        return ''
      }
    },
  })

  // ---------- 参考图注入时机 ----------
  // 模型能不能吃图片取决于本次请求真正走的 provider/model,而 route 在
  // agent/request 瀑布里才定下来,所以主路径挂在那一层;pre-step 只在拿不到
  // 该事件时用"上一次请求的 route"兜底。
  let requestRouteSeen = false

  const offRequest = ctx.on('agent/request', async (payload, next) => {
    const config = await next()
    requestRouteSeen = true
    try {
      const sid = scopeIdOf(payload && payload.agent)
      if (typeof sid === 'string' && sid && config && typeof config.provider === 'string' && typeof config.model === 'string') {
        // 记下本次实际路由:角色视角解析要用同一条路由,模型不同解析出来的腔调也不同。
        sessionRoutes.set(sid, { provider: config.provider, model: config.model })
        lastRouteSeen = { provider: config.provider, model: config.model }
        await syncPersonaImages(sid, { provider: config.provider, model: config.model })
      }
    } catch (e) {
      ctx.logger.warn('dsh-plugin-masterprompt: persona image sync failed: ' + String((e && e.message) || e))
    }
    return config
  })

  /** Route estimate used when the request waterfall is not observable. */
  function fallbackRouteOf(agent, sid) {
    try {
      const session = sessionOf(sid)
      const header = session && typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
      const config = header && header.config
      if (config && typeof config.provider === 'string' && typeof config.model === 'string') {
        return { provider: config.provider, model: config.model }
      }
    } catch {
      /* ignore */
    }
    try {
      const options = agent && agent.options
      if (options && typeof options.provider === 'string' && typeof options.model === 'string') {
        return { provider: options.provider, model: options.model }
      }
    } catch {
      /* ignore */
    }
    return undefined
  }

  // 模型拒绝图片时的兜底:记住这个会话不再送图,重试一次并改成纯文字版。
  const offRequestError = ctx.on('agent/request-error', (payload, next) => {
    try {
      const failure = payload && payload.failure
      const sid = scopeIdOf(payload && payload.agent)
      if (typeof sid === 'string' && sid && failure && failure.code === 'UNSUPPORTED_CONTENT'
        && typeof failure.message === 'string' && /image/i.test(failure.message)) {
        imageUnsupportedSessions.add(sid)
        ctx.logger.warn('dsh-plugin-masterprompt: model rejected persona images; falling back to text descriptions')
        return Promise.resolve({ kind: 'retry' })
      }
    } catch {
      /* ignore */
    }
    return next()
  })

  // ---------- 用户轮身份锚点 ----------
  //
  // 注入机制与 DSH 自身的 modelSwitchNotice 同构 (dsh-agent/lib/index.js):
  // 在 agent/pre-step waterfall 里向 decision.messages 追加一条 user 角色消息,
  // 该消息会随本轮请求一起发出,位置紧邻用户最近一条消息。
  const offPreStep = ctx.on('agent/pre-step', async (payload, next) => {
    try {
      const decision = await next()
      if (!decision || decision.kind === 'reject') return decision
      const messages = decision.messages
      if (!Array.isArray(messages) || messages.length === 0) return decision

      const sid = scopeIdOf(payload && payload.agent)
      if (typeof sid !== 'string' || !sid) return decision

      // 兜底路径:拿不到 agent/request 的 route 时,在这里同步参考图。
      // 会话还没有 system 头部时 syncPersonaImages 会自己跳过,落到下面的 transient 注入。
      if (!requestRouteSeen) {
        try {
          await syncPersonaImages(sid, fallbackRouteOf(payload && payload.agent, sid))
        } catch (e) {
          ctx.logger.warn('dsh-plugin-masterprompt: persona image sync failed: ' + String((e && e.message) || e))
        }
      }

      // 第一轮:持久化会写坏日志,于是只把参考图挂进本次请求,不落盘。
      let outbound = decision
      try {
        const transient = await transientPersonaMessage(sid, fallbackRouteOf(payload && payload.agent, sid))
        if (transient) outbound = { ...decision, messages: [...messages, transient] }
      } catch (e) {
        ctx.logger.warn('dsh-plugin-masterprompt: transient persona image failed: ' + String((e && e.message) || e))
      }

      // 本轮最近一条用户消息:命中身份压力模式才注入锚点。
      // 扫描只用本轮原始消息,不然上面那条参考图通知会被当成"最近一条用户消息"。
      let latest = ''
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (!message || message.role !== 'user') continue
        const text = messageText(message)
        if (text.trim()) {
          latest = text
          break
        }
      }
      if (!latest) return outbound

      // 该会话必须有人设,否则标准模式下不该有人格主张。
      if (!effectiveTemplateIds(sid).length) return outbound

      // ---------- 用户消息改写 ----------
      //
      // 把舰长这一轮说的话换成"对布洛妮娅说"的版本,**直接替换**,原话不再传给模型。
      // 只认真正的用户消息:life 记忆包、参考图、锚点的 source.kind 都不是 'user'。
      //
      // 中插:一次 pre-step 可能认领好几条(舰长在工具循环中途连着补话),
      // 逐条翻,后一条能看到前一条的译文和上一条助手回复 —— 否则指代落不下来。
      //
      // 任何一条翻失败(超时/丢约束/超长)都回退成原文,不阻塞这一轮。
      const outboundNow = outbound
      let translatedCount = 0
      if (state.settings.translateUser) {
        try {
          const targets = []
          const list = Array.isArray(outboundNow.messages) ? outboundNow.messages : []
          for (let i = 0; i < list.length; i++) {
            const m = list[i]
            if (!m || m.role !== 'user') continue
            const kind = m.source && m.source.kind
            if (kind && kind !== 'user') continue
            const text = messageText(m)
            if (text.trim()) targets.push({ index: i, text })
          }
          if (targets.length) {
            const templates = templatesOf(sid)
            const result = await translator.translateBatch({
              texts: targets.map((t) => t.text),
              personaText: templates.map((t) => String(t.text || '')).join('\n\n'),
              personaId: effectiveTemplateIds(sid).join(','),
              route: routeOf(sid) || fallbackRouteOf(payload && payload.agent, sid),
              lastAssistant: lastAssistantText(sid),
            })
            if (result.translated > 0) {
              // 不动原消息:原话要留给会话记录给人看。
              // 译文先记在 pending 里,等这条消息落盘时再盖一层"只对模型可见"的副本。
              for (let k = 0; k < targets.length; k++) {
                const original = outboundNow.messages[targets[k].index]
                const text = result.texts[k]
                if (!original || !original.id || !text || text === targets[k].text) continue
                pendingTranslations.set(original.id, text)
              }
              translatedCount = result.translated
              ctx.logger.info?.('dsh-plugin-masterprompt: 改写了 ' + translatedCount + ' 条用户消息')
            }
          }
        } catch (e) {
          ctx.logger.warn('dsh-plugin-masterprompt: translate failed: ' + String((e && e.message) || e))
        }
      }

      const extra = []

      // ---------- 角色视角解析 ----------
      //
      // 舰长要的是这个:用户原话不动,另挂一条"关心什么/不确定什么/要做什么"。
      // 挂在用户消息**之前**,读的时候是"先有判断,再有话说"。
      if (state.settings.perspective) {
        let captainText = ''
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i]
          if (!message || message.role !== 'user') continue
          const kind = message.source && message.source.kind
          if (kind && kind !== 'user') continue
          const text = messageText(message)
          if (text.trim()) {
            captainText = text
            break
          }
        }
        if (captainText) {
          try {
            const parsedTemplates = templatesOf(sid)
            const parsed = await perspective.parse({
              personaText: parsedTemplates.map((t) => String(t.text || '')).join('\n\n'),
              styleText: voiceBlock(mergeVoice(parsedTemplates)),
              userText: captainText,
              route: routeOf(sid) || fallbackRouteOf(payload && payload.agent, sid),
              personaId: effectiveTemplateIds(sid).join(','),
            })
            if (parsed.ok && parsed.frame) {
              extra.push(createUserMessage({
                content: [{ type: 'text', text: parsed.frame }],
                source: { ...ANCHOR_SOURCE, summary: '角色视角解析' },
              }))
            } else if (parsed.reason && parsed.reason !== 'no-route') {
              ctx.logger.warn('dsh-plugin-masterprompt: perspective parse skipped: ' + String(parsed.reason))
            }
          } catch (e) {
            ctx.logger.warn('dsh-plugin-masterprompt: perspective parse failed: ' + String((e && e.message) || e))
          }
        }
      }

      if (!extra.length) return outboundNow

      return {
        ...outboundNow,
        messages: [...outboundNow.messages, ...extra],
      }
    } catch (e) {
      ctx.logger.warn('dsh-plugin-masterprompt: pre-step anchor failed: ' + String((e && e.message) || e))
      return next()
    }
  })

  // ---------- 译文只在模型侧生效 ----------
  //
  // 会话记录要留原话给人看,模型只需要译文。
  // 做法和参考图换图同一条路:消息落盘之后,立刻盖一条"只对模型可见"的替换副本。
  // 记录本身是 append-origin 事件,durable;替换副本只改模型看到的那一面。
  //
  // 失败就什么都不做:模型看到原文,人看到原文 —— 比看到半截译文好。
  let replacingTranslation = false
  const offTranslated = ctx.on('session/event', (session, event) => {
    if (!state.settings.translateUser) return
    if (replacingTranslation) return
    if (!event || event.type !== 'user/message') return
    const message = event.data && event.data.message
    if (!message || !message.id) return
    const kind = message.source && message.source.kind
    if (kind && kind !== 'user') return
    const translated = pendingTranslations.get(message.id)
    if (!translated) return
    pendingTranslations.delete(message.id)
    replacingTranslation = true
    try {
      session.append('user/message', Object.freeze(structuredClone({
        role: 'user',
        id: 'mp-tr-' + randomUUID().replace(/-/g, '').slice(0, 12),
        content: [{ type: 'text', text: translated }],
        source: { kind: 'plugin:dsh-plugin-masterprompt', form: 'notice', summary: '译文' },
      })), {
        surfaceOp: { op: 'replace', startSeq: event.seq, endSeq: event.seq },
        sourceEventSeqs: [event.seq],
      })
    } catch (e) {
      ctx.logger.warn('dsh-plugin-masterprompt: 译文替换没盖上,模型这一轮看到的是原文: ' + String((e && e.message) || e))
    } finally {
      replacingTranslation = false
    }
  })

  // ---------- HTTP API for the composer-box UI ----------
  /**
   * 注册一条路由。
   *
   * `method` 可以是字符串,也可以是数组(同一个路径同时接 GET 和 POST)。
   *
   * 为什么要数组:webserver 的路由表以 **路径** 为键,同一个路径注册两次会抛
   * "duplicate exact route",而且那次抛错会让整个注册 effect 中断 ——
   * 后面所有路由都装不上(症状:GET 正常,POST 全部 405)。
   * 所以"同一个 URL 两种方法"必须合并成一次注册。
   */
  function registerRoute(method, routePath, handler) {
    const methods = Array.isArray(method) ? method : [method]
    return ctx.webServer.register({
      kind: 'exact',
      path: routePath,
      handler: async (req, res) => {
        try {
          if (methods.indexOf('POST') >= 0 && req.method === 'POST') {
            if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          } else if (methods.indexOf(req.method) < 0) {
            res.writeHead(405)
            res.end()
            return
          }
          await handler(req, res)
        } catch (e) {
          sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) })
        }
      },
    })
  }

  ctx.effect(() => {
    const disposers = []
    // 一条路由注册失败不能连累后面的:webserver 的路由表以路径为键,
    // 重复注册会抛错,而这个 effect 一旦抛错,后面所有路由都装不上
    //(症状:先注册的 GET 正常,后面的全部 405,看起来像"能看不能改")。
    function route(method, path, handler) {
      try {
        disposers.push(registerRoute(method, path, handler))
      } catch (e) {
        ctx.logger.warn('dsh-plugin-masterprompt: 路由 ' + path + ' 没能注册: ' + String((e && e.message) || e))
      }
    }
    route('GET', '/dsh-mp/state', (req, res) => {
            let sid = ''
            try {
              const u = new URL(req.url || '/', 'http://x')
              sid = u.searchParams.get('sid') || ''
            } catch {
              /* ignore */
            }
            const effIds = sid ? effectiveTemplateIds(sid) : []
            const effective = effIds.map((id) => templateOf(id)).filter(Boolean).map((t) => ({ id: t.id, name: t.name }))
            const archived = archivedSessionIds()
            const inUse = {}
            for (const t of state.templates) {
              let n = 0
              for (const k of Object.keys(state.selection)) {
                if (archived.has(normalizeSessionId(k))) continue
                const v = state.selection[k]
                if (typeof v === 'string' ? v === t.id : Array.isArray(v) && v.includes(t.id)) n++
              }
              inUse[t.id] = n
            }
            sendJson(res, 200, {
              ok: true,
              templates: state.templates,
              effective,
              defaultPersonaId: state.defaultPersonaId || null,
              inUse,
            })
    })
    // 解析口:最后一次解析的状态,以及累计命中情况。
    route('GET', '/dsh-mp/perspective-report', (req, res) => {
      sendJson(res, 200, { ok: true, report: perspective.report() })
    })
    // 自测口:POST /dsh-mp/perspective-test {text} —— 直接走一次解析,看产出的三元组。
    route('POST', '/dsh-mp/perspective-test', async (req, res) => {
      const args = await readJsonBody(req)
      const text = typeof args?.text === 'string' ? args.text : ''
      if (!text.trim()) return sendJson(res, 400, { ok: false, error: 'text required' })
      const sidUse = typeof args?.sessionId === 'string' && args.sessionId
        ? args.sessionId
        : (Object.keys(state.selection)[0] || '')
      const templates = templatesOf(sidUse)
      const out = await perspective.parse({
        personaText: templates.map((t) => String(t.text || '')).join('\n\n'),
        styleText: voiceBlock(mergeVoice(templates)),
        userText: text,
        route: lastRouteSeen,
        personaId: effectiveTemplateIds(sidUse).join(','),
      })
      sendJson(res, 200, { ok: out.ok, frame: out.frame ?? null, reason: out.reason ?? null, cached: !!out.cached })
    })
    // 自测口:POST /dsh-mp/translate-test {text, lastAssistant, priorUser[]}
    route('POST', '/dsh-mp/translate-test', async (req, res) => {
      const args = await readJsonBody(req)
      const text = typeof args?.text === 'string' ? args.text : ''
      if (!text.trim()) return sendJson(res, 400, { ok: false, error: 'text required' })
      const sidUse = typeof args?.sessionId === 'string' && args.sessionId
        ? args.sessionId
        : (Object.keys(state.selection)[0] || '')
      const templates = templatesOf(sidUse)
      const out = await translator.translateBatch({
        texts: [text],
        personaText: templates.map((t) => String(t.text || '')).join('\n\n'),
        personaId: effectiveTemplateIds(sidUse).join(','),
        route: lastRouteSeen,
        lastAssistant: typeof args?.lastAssistant === 'string' ? args.lastAssistant : '',
        priorUser: Array.isArray(args?.priorUser) ? args.priorUser.filter((x) => typeof x === 'string') : [],
      })
      sendJson(res, 200, { ok: true, original: text, translated: out.texts[0], changed: out.translated > 0, report: translator.report() })
    })
    // 生成口(盲测用):把当前人设 + 语言习惯表装进 system,给一句话,返回模型原话。
    // 和真实对话的差别:这里**不跑用户消息改写**,测的是人设与习惯表本身的输出。
    route('POST', '/dsh-mp/voice-generate', async (req, res) => {
      const args = await readJsonBody(req)
      const text = typeof args?.text === 'string' ? args.text.trim() : ''
      if (!text) return sendJson(res, 400, { ok: false, error: 'text required' })
      const tpl = (typeof args?.templateId === 'string' ? templateOf(args.templateId) : undefined)
        || templateOf(state.defaultPersonaId)
        || state.templates.find((t) => t && typeof t.text === 'string' && t.text.trim())
      if (!tpl) return sendJson(res, 400, { ok: false, error: 'no persona template' })
      const useRoute = lastRouteSeen
      if (!useRoute) return sendJson(res, 400, { ok: false, error: 'no route yet' })
      let llm
      try { llm = ctx.get('llm') } catch { llm = undefined }
      if (!llm || typeof llm.stream !== 'function') return sendJson(res, 400, { ok: false, error: 'llm unavailable' })
      const system = [WRAPPER_HEAD + WRAPPER_FIXED + String(tpl.text || '').trim(), voiceBlock(mergeVoice([tpl]))].filter(Boolean).join('\n\n')
      const messages = [
        { role: 'system', content: [{ type: 'text', text: system }] },
        { role: 'user', content: [{ type: 'text', text }] },
      ]
      try {
        const stream = llm.stream({
          provider: useRoute.provider,
          model: useRoute.model,
          messages,
          maxTokens: typeof args?.maxTokens === 'number' ? args.maxTokens : 2000,
          purpose: 'masterprompt-voice-generate',
        })
        let out = ''
        let finish = null
        for await (const chunk of stream) {
          if (!chunk) continue
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
          else if (chunk.type === 'finish') finish = chunk.reason ?? null
        }
        const body = out.trim()
        if (!body) return sendJson(res, 200, { ok: false, error: 'empty output', finish })
        sendJson(res, 200, { ok: true, template: tpl.name, route: useRoute, generated: body, finish })
      } catch (e) {
        sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
      }
    })
    route(['GET', 'POST'], '/dsh-mp/settings', async (req, res) => {
            if (req.method === 'POST') {
              const args = await readJsonBody(req)
              const next = { ...state.settings }
              if (typeof args?.perspective === 'boolean') next.perspective = args.perspective
              if (typeof args?.translateUser === 'boolean') next.translateUser = args.translateUser
              state.settings = next
              save()
            }
            sendJson(res, 200, { ok: true, settings: state.settings })
    })
    route('POST', '/dsh-mp/save-template', async (req, res) => {
            const args = await readJsonBody(req, MAX_UPLOAD_BODY_BYTES)
            const nm = typeof args.name === 'string' ? args.name.trim() : ''
            const tx = typeof args.text === 'string' ? args.text : ''
            if (!nm || nm.length > MAX_TEMPLATE_NAME) return sendJson(res, 400, { ok: false, error: 'name required (1-100 chars)' })
            if (tx.length > MAX_TEMPLATE_TEXT) return sendJson(res, 400, { ok: false, error: 'text too long (max 100000 chars)' })
            const template = typeof args.id === 'string' && args.id ? templateOf(args.id) : undefined
            if (typeof args.id === 'string' && args.id && !template) return sendJson(res, 404, { ok: false, error: 'template not found' })
            const previous = template && Array.isArray(template.images) ? template.images : []
            const incoming = Array.isArray(args.images) ? args.images : []
            if (incoming.length > MAX_IMAGES_PER_TEMPLATE) {
              return sendJson(res, 400, { ok: false, error: 'too many images (max ' + MAX_IMAGES_PER_TEMPLATE + ')' })
            }
            const kept = []
            try {
              for (const raw of incoming) {
                if (!raw || typeof raw !== 'object') throw new Error('bad image entry')
                const description = typeof raw.description === 'string' ? raw.description.slice(0, MAX_IMAGE_DESCRIPTION) : ''
                const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 200) : ''
                if (typeof raw.data === 'string' && raw.data.length > 0) {
                  const bytes = Buffer.from(raw.data, 'base64')
                  if (bytes.byteLength === 0) throw new Error('empty image')
                  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('image too large (max 8 MB)')
                  const mediaType = detectMediaType(bytes)
                  if (mediaType === undefined) throw new Error('unsupported image format (png / jpeg / webp / gif)')
                  const id = newImageId()
                  const file = id + '.' + IMAGE_MEDIA_EXTENSIONS[mediaType]
                  writeFileSync(path.join(imagesDir, file), bytes)
                  kept.push({ id, name: name || file, mediaType, bytes: bytes.byteLength, file, description })
                  continue
                }
                const existing = typeof raw.id === 'string' ? previous.find((image) => image.id === raw.id) : undefined
                if (!existing) throw new Error('unknown image id')
                kept.push({ ...existing, ...(name ? { name } : {}), description })
              }
            } catch (e) {
              for (const image of kept) if (!previous.some((p) => p.id === image.id)) removeImageFile(image)
              return sendJson(res, 400, { ok: false, error: (e && e.message) || String(e) })
            }
            for (const image of previous) if (!kept.some((k) => k.id === image.id)) removeImageFile(image)
            if (template) {
              template.name = nm
              template.text = tx
              template.images = kept
              // 形态参数是模板的一部分:前端没带 style 就沿用原来的,别被一次普通保存抹掉。
              const style = normalizeStyle(args.style, template.style)
              if (style === undefined) delete template.style
              else template.style = style
              template.updatedAt = now()
              save()
              return sendJson(res, 200, { ok: true, template })
            }
            const t = { id: newId(), name: nm, text: tx, images: kept, createdAt: now(), updatedAt: now() }
            const freshStyle = normalizeStyle(args.style, undefined)
            if (freshStyle !== undefined) t.style = freshStyle
            state.templates.push(t)
            save()
            return sendJson(res, 200, { ok: true, template: t })
    })
    route('GET', '/dsh-mp/image', (req, res) => {
            let id = ''
            try {
              const u = new URL(req.url || '/', 'http://x')
              id = u.searchParams.get('id') || ''
            } catch {
              /* ignore */
            }
            const image = imageById(id)
            if (!image) {
              res.writeHead(404)
              res.end()
              return
            }
            try {
              const bytes = readFileSync(imagePathOf(image))
              res.writeHead(200, {
                'content-type': image.mediaType,
                'content-length': bytes.byteLength,
                'cache-control': 'no-store',
              })
              res.end(bytes)
            } catch {
              res.writeHead(404)
              res.end()
            }
    })
    route('POST', '/dsh-mp/delete-template', async (req, res) => {
            const args = await readJsonBody(req)
            const id = args && typeof args.id === 'string' ? args.id : ''
            const idx = state.templates.findIndex((t) => t.id === id)
            if (idx < 0) return sendJson(res, 404, { ok: false, error: 'template not found' })
            const archived = archivedSessionIds()
            const archivedSelectors = []
            let n = 0
            for (const k of Object.keys(state.selection)) {
              const v = state.selection[k]
              const usesId = typeof v === 'string' ? v === id : Array.isArray(v) && v.includes(id)
              if (!usesId) continue
              if (archived.has(normalizeSessionId(k))) archivedSelectors.push(k)
              else n++
            }
            if (n > 0) return sendJson(res, 409, { ok: false, error: 'in use by ' + n + ' conversation(s) - switch them first' })
            for (const k of archivedSelectors) {
              const v = state.selection[k]
              if (typeof v === 'string') state.selection[k] = null
              else if (Array.isArray(v)) {
                const rest = v.filter((x) => x !== id)
                state.selection[k] = rest.length ? rest : null
              }
            }
            const removed = state.templates[idx]
            for (const image of Array.isArray(removed.images) ? removed.images : []) removeImageFile(image)
            state.templates.splice(idx, 1)
            if (state.defaultPersonaId === id) state.defaultPersonaId = null
            save()
            return sendJson(res, 200, { ok: true })
    })
    route('POST', '/dsh-mp/apply', async (req, res) => {
            const args = await readJsonBody(req)
            const sid = args && typeof args.sessionId === 'string' ? args.sessionId : ''
            if (!sid || sid.length > 200) return sendJson(res, 400, { ok: false, error: 'bad sessionId' })
            let ids = []
            if (Array.isArray(args && args.templateIds)) ids = args.templateIds.filter((id) => typeof id === 'string' && templateOf(id))
            else if (typeof (args && args.templateId) === 'string' && templateOf(args.templateId)) ids = [args.templateId]
            if (!ids.length) return sendJson(res, 404, { ok: false, error: 'template not found' })
            state.selection[sid] = ids.length === 1 ? ids[0] : ids
            state.defaultPersonaId = ids[0]
            save()
            return sendJson(res, 200, { ok: true })
    })
    route('POST', '/dsh-mp/clear', async (req, res) => {
            const args = await readJsonBody(req)
            const sid = args && typeof args.sessionId === 'string' ? args.sessionId : ''
            if (!sid || sid.length > 200) return sendJson(res, 400, { ok: false, error: 'bad sessionId' })
            state.selection[sid] = null
            state.defaultPersonaId = null
            save()
            return sendJson(res, 200, { ok: true })
    })
    return () => {
      for (const d of disposers) d()
    }
  }, 'dsh-plugin-masterprompt: http routes')

  return () => {
    offTranslated()
    offCreated()
    offSection()
    offOpeners()
    offPreStep()
    offRequest()
    offRequestError()
  }
}
