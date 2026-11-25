/**
 * 角色视角解析(第二层)。
 *
 * 思路来自"注意力偏置"而不是"禁止清单":
 *   穷举法是事后判错 —— 模型先跑偏,再被规则拦住,规则永远追不完。
 *   偏置法是事前牵引 —— 先让角色**自己**把这一轮该在意什么说清楚,
 *   接下来的生成就顺着这个偏置走。她本来就这么想,自然不会跑偏。
 *
 * 所以这里做的事只有一件:用角色自己的口吻,把舰长这一轮的话解析成三行 ——
 *   在意:   她此刻真正在意的那个点
 *   不确定: 她此刻没有把握、需要检验的那一点
 *   要做:   她这一轮实际会做的动作
 *
 * 三行都是**判断**,不是复述:复述舰长的话没有偏置作用,那只是把输入又说一遍。
 *
 * 实现:一次小模型调用。
 *   - 走当前会话的同一条路由(pre-step 时刻拿不到本次路由,取上一次落盘的
 *     request/header,再退回 agent.options)。
 *   - 有超时(默认 9 秒)。超时、路由缺失、模型报错 —— 一律**跳过注入**,
 *     不影响这一轮对话本身。解析是加分项,不是前置条件。
 *   - 按 (人设, 舰长这句话) 缓存。同一句话被重复提交(重试、语音重复)不重复花钱。
 *
 * 这条路径每轮多一次模型调用,所以它有开关:state.settings.perspective = false 即关。
 */

import { createHash } from 'node:crypto'

/** 解析器的指令。它看不到人设以外的世界,只做一件事:把输入翻译成角色的判断。 */
const PROTOCOL = [
  '任务:对舰长这一轮的话做一次内部解析。**只输出下面四行**,不要任何其他字。',
  '场景: <技术 | 日常 | 给建议和规划 | 学习,四选一>',
  '在意: <她此刻真正在意的那个点>',
  '不确定: <她此刻没有把握、需要检验或需要更多信息的那一点>',
  '要做: <她这一轮实际会做的动作>',
  '',
  '硬性要求:',
  '* 第一行必须是场景,而且只能从这四个里挑一个:技术、日常、给建议和规划、学习。舰长的话同时沾得上几个时,按他这一轮真正要的东西挑,不按话题挑。',
  '* 场景后面三行照旧,每行不超过 30 个字。不要标题、不要列表符号、不要解释、不要寒暄。',
  '* 判断按这个角色的口径,但**不要以角色身份说话**:不称呼舰长,不说"我",不写"布洛妮娅准备完毕"这类话。',
  '* 不复述舰长的话。',
  '* 没有不确定的地方就写「不确定:无」。',
].join('\n')

/** 四个场景。必须四选一,模型没给就按关键词兜底。 */
const SCENES = ['技术', '日常', '给建议和规划', '学习']

/** 兜底分类:模型漏了场景这一行时用。只按舰长原话里的词判,不猜。 */
const SCENE_HINTS = [
  ['技术', /(报错|错误|异常|崩溃|挂了|跑不起来|不生效|没生效|为什么.*(不行|失败)|代码|函数|接口|日志|配置|路径|文件|命令|脚本|部署|编译|调试|版本|插件|仓库|git|api|token|端口)/i],
  ['学习', /(学|理解|搞懂|原理|为什么|怎么回事|区别|概念|复习|考试|讲一下|解释|入门|推导)/],
  ['给建议和规划', /(建议|怎么办|怎么做|怎么弄|方案|计划|规划|要不要|该不该|选哪个|值不值|安排|取舍|方向|步骤)/],
]

function sceneOf(text) {
  const value = String(text || '').replace(/[\[\]【】()（）\s]/g, '')
  for (const scene of SCENES) {
    if (value.includes(scene)) return scene
  }
  return ''
}

function guessScene(userText) {
  const text = String(userText || '')
  for (const [scene, pattern] of SCENE_HINTS) {
    if (pattern.test(text)) return scene
  }
  return '日常'
}

/** 注入给主模型时用的框架。用布洛妮娅自己的口吻说,不复述标签。 */
const FRAME_HEAD = '【布洛妮娅先过一遍】(内部参考,不是舰长说的话,不用回它)'

/** 解析器的输入。协议在前、原话在后:最后一条指令决定格式,这样模型不容易跑成对话。 */
function inputText(userText) {
  return [PROTOCOL, '', '舰长的话:', String(userText ?? '').trim()].join('\n')
}

/**
 * 把模型输出整理成三行。
 *
 * 模型不总是听话:可能带前言、可能用列表符号开头、可能把标签写成"在意的是"。
 * 这里只做**整理**,不替模型编内容:标签找不到就整行丢掉,
 * 三行里凑不齐两个就算这次解析失败(不注入半成品)。
 *
 * 原始输出会留下来(给 /dsh-mp/perspective-report 看),所以失败时能看出
 * 模型到底说了什么,而不是只看到一个"失败"。
 */
function normalize(raw, userText = '') {
  const lines = String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  const picked = new Map()
  let scene = ''
  for (const line of lines) {
    // 去掉列表符号:"- 在意: …" / "* 在意: …" / "1. 在意: …"
    const bare = line.replace(/^[-*•·]\s*/, '').replace(/^\d+[.、)]\s*/, '').trim()
    // 场景行:模型可能写成「场景: 技术」「场景：[技术]」「这是[技术]场景」
    if (!scene) {
      const found = sceneOf(bare)
      if (found && /(场景|这是)/.test(bare)) {
        scene = found
        continue
      }
    }
    const m = /(在意|不确定|要做)\s*([:：])?\s*(.*)$/.exec(bare)
    if (!m) continue
    const key = m[1]
    if (picked.has(key)) continue
    const hasColon = m[2] !== undefined
    let value = m[3].trim()
    if (!hasColon) value = value.replace(/^的?是\s*[:：]?\s*/, '').trim()
    if (!value) continue
    picked.set(key, value.slice(0, 60))
  }
  if (picked.size < 2) return null
  // 场景必须四选一:模型没给就按原话里的词兜底,不让这一行空着。
  const finalScene = scene || guessScene(userText)

  // 用布洛妮娅的口吻写成一段话,不留标签。三段各自独立,缺哪段就少说哪段。
  const parts = ['这轮是[' + finalScene + ']场景。']
  const care = picked.get('在意')
  if (care) parts.push('布洛妮娅在意的是' + care.replace(/[。;；]+$/, '') + '。')
  const unsure = picked.get('不确定')
  if (unsure && !/^(无|没有|暂时没有|暂时无)[。.]?$/.test(unsure.trim())) {
    parts.push('还没底的是' + unsure.replace(/[。;；]+$/, '') + '。')
  }
  const todo = picked.get('要做')
  if (todo) parts.push('接下来' + todo.replace(/[。;；]+$/, '').replace(/^会|^就/, '') + '。')
  return FRAME_HEAD + '\n' + parts.join('')
}

export const __normalizeForTest = normalize

/**
 * 创建解析器。
 *
 * @param {object} ctx - 插件上下文
 * @param {{timeoutMs?: number, maxTokens?: number}} [options]
 */
export function createPerspectiveParser(ctx, options = {}) {
  const timeoutMs = options.timeoutMs ?? 9000
  const maxTokens = options.maxTokens ?? 220
  const cache = new Map()
  const CACHE_MAX = 64

  /**
   * 留痕:每次尝试的原因、模型原话、成功时的框架。
   *
   * 有了它,"没注入"就不用猜了:GET /dsh-mp/perspective-report 直接看。
   */
  const stats = { attempts: 0, ok: 0, failed: 0, byReason: {} }
  let last = null

  function note(reason, extra = {}) {
    stats.attempts += 1
    if (reason === 'ok' || reason === 'cached') stats.ok += 1
    else {
      stats.failed += 1
      const key = String(reason).split(':')[0]
      stats.byReason[key] = (stats.byReason[key] || 0) + 1
    }
    last = {
      at: Date.now(),
      reason: String(reason),
      ...(extra.raw !== undefined ? { raw: String(extra.raw).slice(0, 600) } : {}),
      ...(extra.frame !== undefined ? { frame: extra.frame } : {}),
    }
  }

  /** 报告:给 HTTP 接口用。 */
  function report() {
    return { stats, last }
  }

  function cacheKey(personaId, userText) {
    return createHash('sha1').update(String(personaId ?? '')).update('\u0000').update(String(userText ?? '')).digest('hex')
  }

  function remember(key, frame) {
    cache.set(key, frame)
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
  }

  /**
   * 解析一轮输入。
   *
   * 每一次尝试都留痕:成功、失败、失败原因、模型原话。
   * 没有留痕的时候,"没注入"这件事是查不出来的 —— 只能猜是路由没拿到、
   * 还是模型没按格式答、还是超时。
   *
   * @param {{personaText: string, styleText?: string, userText: string, route?: {provider: string, model: string}, personaId?: string}} input
   * @returns {Promise<{ok: boolean, frame?: string, reason?: string, cached?: boolean}>}
   */
  async function parse(input) {
    const userText = String(input?.userText ?? '').trim()
    if (!userText) {
      note('empty-input')
      return { ok: false, reason: 'empty-input' }
    }

    const key = cacheKey(input?.personaId, userText)
    const hit = cache.get(key)
    if (hit) {
      note('cached', { frame: hit })
      return { ok: true, frame: hit, cached: true }
    }

    const route = input?.route
    if (!route || typeof route.provider !== 'string' || !route.provider
      || typeof route.model !== 'string' || !route.model) {
      note('no-route')
      return { ok: false, reason: 'no-route' }
    }

    let llm
    try {
      llm = ctx.get('llm')
    } catch {
      llm = undefined
    }
    if (!llm || typeof llm.stream !== 'function') {
      note('no-llm')
      return { ok: false, reason: 'no-llm' }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      // system 只放角色自述(让她用这个口径判断),**协议放在 user 消息里** ——
      // 放在 system 末尾时,人设会把它当成"元信息"忽略掉,模型转头就用角色身份
      // 开始说话;放在 user 消息里才是"这次要做的事",格式约束才真的生效。
      const system = [
        String(input?.personaText ?? '').trim(),
        input?.styleText ? String(input.styleText).trim() : '',
        '',
        '下面那条消息是一次内部解析任务,不是对话。按这个角色的判断口径回答,但不要以角色身份说话。',
      ].filter(Boolean).join('\n\n')
      const messages = [
        { role: 'system', content: [{ type: 'text', text: system }] },
        {
          role: 'user',
          content: [{ type: 'text', text: inputText(userText) }],
        },
      ]
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        messages,
        maxTokens,
        purpose: 'masterprompt-perspective',
        signal: controller.signal,
      })
      let text = ''
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
      }
      const frame = normalize(text, userText)
      if (!frame) {
        note('unparsable', { raw: text })
        return { ok: false, reason: 'unparsable' }
      }
      remember(key, frame)
      note('ok', { frame })
      return { ok: true, frame }
    } catch (e) {
      const reason = String((e && e.message) || e)
      note('error:' + reason)
      return { ok: false, reason }
    } finally {
      clearTimeout(timer)
    }
  }

  return { parse, report }
}
