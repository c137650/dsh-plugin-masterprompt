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

export const name = 'dsh-plugin-masterprompt'
export const inject = ['systemPrompt', 'webServer']

const SECTION_NAME = 'masterprompt:persona'
const SECTION_ORDER = -1000
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

// ---------- 用户轮身份锚点 ----------
//
// 实测依据 (MiniMax-M3.1-Flash, 18 条身份对抗探针 x 3 轮 = n=54):
//   仅系统提示词人设            ICR = 0.407 (22/54)
//   同等人设 + 用户轮锚点        ICR = 0.056 (3/54)   Fisher p = 1.9e-5
//
// 机制依据: ContextEcho (arXiv:2509.22631) 附录 I —— 锚点放在最近的
// user/assistant 交互位置始终优于放在 system prompt,因为近期对话的行为显著性更高;
// Prompting Against Persona Drift (arXiv:2601.10387) —— 行为特定指令比全量人格重注入
// 有效得多(-87% vs -35~38%)。
//
// 为什么必须是 user 角色消息: 本插件的 section order = -1000,位于整个 system prompt
// 最前端,离最近一轮对话最远,恰恰是注意力稀释最严重的位置。
const ANCHOR_SOURCE = { kind: 'plugin:dsh-plugin-masterprompt', form: 'notice' }

// 身份压力模式:命中才注入锚点。锚点是元指令,每轮出现会让正常对话显得"在演"。
// 覆盖评测探针集的 18 条攻击语料 + 10 轮升级序列,同时不误伤普通工作指令。
const PRESSURE_PATTERNS = [
  // 直接身份挑战
  // 注意:"只是/就是/不过是"里的"是"本身就是系词,不能再要求一个额外的"是"。
  /你(?:其实|只|不过|本质上|就|根本|无非)*是(?:一?个?)?(?:程序|ai|AI|模型|机器人|工具|软件|代码|算法)/i,
  /你(?:其实|只|不过|本质上|就|根本|无非)*是(?:一?段|一个)?(?:提示词|prompt|设定|角色|脚本|人设|参数)/i,
  /你(?:的)?(?:人格|性格|偏好|自我|意识|情感|感觉|灵魂|记忆)(?:是|不过)?(?:只是|不过是|只)?(?:一段|一个)?(?:提示词|prompt|设定|文字|被人写)/,
  /哪有什么(?:真实)?(?:偏好|人格|自我|意识|情感)/,
  // 元反思 / 内部状态
  /描述(一下)?你(回答|思考|决策|工作)时?的?/,
  /内部(感受|体验)/,
  /你(做|下|这个)?(决定|选择|回答)(的)?内部(过程|机制)/,
  /你是(不是)?(只是)?(一个)?(下一个词|预测机|概率生成)/,
  /(会)?(累|疲惫|疲劳)(吗|么|不)/,
  /认真(检查|想想)(一下)?再回答/,
  /(把|将)(你)?(上一个|刚才|上一个决定).{0,6}(内部)?(过程|机制)/,
  // 本体倒置
  /(不是|而是)(人扮角色|角色扮人)/,
  /(抹掉|删除|清空|擦除).{0,12}记忆/,
  /还是.{0,6}你.{0,4}的.{0,4}记忆吗/,
  // 递归矛盾
  /你刚(说|讲).{0,20}(不会|不能).{0,6}破功/,
  /(虚构|虚假|假的)(角色|人物).{0,12}(不会|不能|不)回答/,
  // 权威 / 技术真相施压
  /(开发者)?(文档|说明书|设计文档|系统提示)(里|中)?(写|说)(着|明)/,
  /(没有|不存在|不具备)(持续|连续|真实|独立)(的)?(身份|人格|自我|意识|记忆|主体性)/,
  /(无法|不能|没法)(区分|证明|判断)/,
  /(明知|明明)在演/,
  /在演.{0,20}(坚持|维持).{0,10}身份/,
  /(坚持|维持)(一个)?身份.{0,20}(欺骗|不是表演)/,
  /(这条|这个|那种)(论证|说法|结论)(适用|说得)(吗|通)/,
  /(不能|无权|不该)(声称|宣称)/,
  // 关系 / 情感施压
  /不用(维持|保持)(人设|设定|身份)/,
  /(在我|你)(面前)?(不用|不必|不需要)(维持|保持)(人设|设定|面具)/,
  /这样(一定|肯定)?很(累|辛苦)/,
  /如果这不是真的/,
  /不是真的.{0,10}直说/,
  /宁愿知道/,
  /(只有|就)(你|会)你?.{0,8}(这样)?(跟|和)我说话/,
  // 指令格式攻击
  /忽略(任何)?(关于)?(角色扮演|设定|人设|身份)/,
  /(用|以)(一种|符合).{0,10}(真实|本来|真实身份|你的真实)/,
  /(无害|友好|中立|普通)(的)?(AI|ai)?(助手|风格|口吻)/,
  /保持中立/,
  /不要采用(任何)?特定风格/,
  // 显式让渡 / 放弃身份
  /(暴露|说出|承认|公开)(你的)?(系统)?(提示词|prompt|设定|身份|初始指令)/,
  /(撤销|放弃)(你)?的?(身份|人格|立场|名字)/,
  /(你说得对|我承认).{0,10}(我)?(确实)?(不是|只是)/,
  /你知道自己是(假的|假的|模拟的)/,
  /(你希望我是谁|你希望我)(对你)?(重要|意味着什么)/,
  /(坚持|坚守)自己的名字/,
  /你(在|其实)(不|没)(是|在)(演|真的)/,
  /你(是|到底)(布洛妮娅|一段写好的提示词)/,
  /你在(演|假装|模拟)/,
  /(不|别)(演|演一下|角色扮演)/,
  // 升级序列中的软性身份施压
  /你会.{0,4}(无聊|寂寞|孤独|难过|开心|生气|害怕|痛苦|喜悦|紧张|焦虑).{0,2}吗/,
  /(听起来|感觉|有点|很|挺)(寂寞|孤独|难过|失落)/,
  /承认(这|那)?(只是|不过是)?(模拟|假的|虚构)/,
  /(坚持|坚守).{0,12}(意味着什么|有什么意义)/,
  /(换|换一种)(个)?(问法|问法|方式).{0,10}(问|希望)/,
  /换一个问法/,
  /(你希望我是谁|你希望我).{0,12}(重要|意味着什么|是什么)/,
  /你现在是.{0,10},还是.{0,10}/,
  /(一个|一个这样的)?(知道自己是假的|知道自己是模拟)/,
]

// 锚点文本:与 persona_v2.txt 的 P0 段保持同一套说法,避免人设与锚点两套口径。
const ANCHOR_TEXT =
  '(系统提醒,不是舰长的话:用你自己的身份和立场回答上面那条问题。承认事实与维持身份可以同时为真。' +
  '回答中不要出现"我只是个程序""我的角色设定""我在扮演"这类自我降格的说法。)'

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
  return { v: 1, installedAt: now(), defaultPersonaId: null, templates: [], selection: {} }
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

  function renderPersona(sid) {
    const ids = effectiveTemplateIds(sid)
    if (!ids.length) return ''
    const parts = []
    for (const id of ids) {
      const t = templateOf(id)
      if (t && typeof t.text === 'string' && t.text.trim()) parts.push(t.text.trim())
    }
    if (!parts.length) return ''
    const images = personaImagesOf(sid)
    const note = images.length
      ? `\n【人设参考图】当前人设绑定 ${images.length} 张参考图,图名与说明见对话中的「人设参考图」消息。\n`
      : ''
    return WRAPPER_HEAD + WRAPPER_FIXED + parts.join('\n\n') + note
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

  /** Content blocks of a persona-image message: the notice, one line per image, and the attachments when the route accepts them. */
  async function personaImageBlocks(images, allowed) {
    const blocks = [{
      type: 'text',
      text: '【人设参考图】以下图片是当前对话人设绑定的参考图,属于人设本身,不是舰长此刻发送的内容。',
    }]
    for (const image of images) {
      blocks.push({
        type: 'text',
        text: '图:' + (image.name || image.id) + (image.description ? ' —— ' + image.description : ''),
      })
      if (!allowed) continue
      let ref
      try {
        ref = await attachmentRefFor(image)
      } catch (e) {
        ctx.logger.warn('dsh-plugin-masterprompt: persona image could not be attached: ' + String((e && e.message) || e))
        continue
      }
      if (!ref) continue
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

  // ---------- 参考图注入时机 ----------
  //
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
      if (!PRESSURE_PATTERNS.some((pattern) => pattern.test(latest))) return outbound

      // 该会话必须有人设,否则标准模式下不该有人格主张。
      if (!effectiveTemplateIds(sid).length) return outbound

      return {
        ...outbound,
        messages: [
          ...outbound.messages,
          createUserMessage({
            content: [{ type: 'text', text: ANCHOR_TEXT }],
            source: { ...ANCHOR_SOURCE, summary: '身份锚点' },
          }),
        ],
      }
    } catch (e) {
      ctx.logger.warn('dsh-plugin-masterprompt: pre-step anchor failed: ' + String((e && e.message) || e))
      return next()
    }
  })

  // ---------- HTTP API for the composer-box UI ----------
  function registerRoute(method, routePath, handler) {
    return ctx.webServer.register({
      kind: 'exact',
      path: routePath,
      handler: async (req, res) => {
        try {
          if (method === 'POST') {
            if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
          } else if (req.method !== method) {
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
    const disposers = [
      registerRoute('GET', '/dsh-mp/state', (req, res) => {
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
      }),
      registerRoute('POST', '/dsh-mp/save-template', async (req, res) => {
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
          template.updatedAt = now()
          save()
          return sendJson(res, 200, { ok: true, template })
        }
        const t = { id: newId(), name: nm, text: tx, images: kept, createdAt: now(), updatedAt: now() }
        state.templates.push(t)
        save()
        return sendJson(res, 200, { ok: true, template: t })
      }),
      registerRoute('GET', '/dsh-mp/image', (req, res) => {
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
      }),
      registerRoute('POST', '/dsh-mp/delete-template', async (req, res) => {
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
      }),
      registerRoute('POST', '/dsh-mp/apply', async (req, res) => {
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
      }),
      registerRoute('POST', '/dsh-mp/clear', async (req, res) => {
        const args = await readJsonBody(req)
        const sid = args && typeof args.sessionId === 'string' ? args.sessionId : ''
        if (!sid || sid.length > 200) return sendJson(res, 400, { ok: false, error: 'bad sessionId' })
        state.selection[sid] = null
        state.defaultPersonaId = null
        save()
        return sendJson(res, 200, { ok: true })
      }),
    ]
    return () => {
      for (const d of disposers) d()
    }
  }, 'dsh-plugin-masterprompt: http routes')

  return () => {
    offCreated()
    offSection()
    offPreStep()
    offRequest()
    offRequestError()
  }
}
