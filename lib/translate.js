/**
 * 用户消息改写。
 *
 * 舰长的要求:把他说的话翻译成"能增进角色扮演的版本",**直接替换原用户消息**,
 * 原始内容不再传给模型。取代原来的「角色视角解析」(那条是往上下文里再加一条,
 * 现在是直接改输入)。
 *
 * 三条硬约束,缺一条就整条回退原文:
 *   1. 保真 —— 原消息里的引号原话、数字、路径、URL 必须原样出现在译文里
 *   2. 长度 —— 不超过原文的 1.6 倍(短消息再给 40 字余量)
 *   3. 不空 —— 空输出当失败
 *
 * 为什么必须回退而不是尽力而为:
 *   这条消息里可能带着"只能添加不能删改"式的硬约束。翻译器一旦把它翻软,
 *   后面整轮都白做,而且失败得很安静。宁可这一轮不翻。
 *
 * 中插消息:一次 pre-step 可能认领多条(舰长在中途连续补话)。
 * 逐条翻,后一条能看到前一条的译文和上一条助手回复 —— 否则"不是这个意思"没法落指代。
 */

import { createHash } from 'node:crypto'

const PROTOCOL_TEMPLATE = [
  '把下面这条消息换成"对布洛妮娅说"的版本。只输出改写后的消息本身,不要任何说明。',
  '',
  '规则:',
  '1. 保留全部事实、数字、路径、URL、引号里的原话。',
  '2. 不添加原消息里没有的信息,不删问题,不把问题换成另一个问题。',
  '3. 命令式的约束原样保留,不改写、不软化、不合并。',
  '4. 用对着布洛妮娅说话的口吻,可以第三人称称呼她,也可以用「舰长」称自己。',
  '5. 长度不超过原消息的 1.6 倍,能不加字就不加。',
  '6. 不写括号说明,不写「请以…的身份」这类指令。',
].join('\n')

/** 从原消息里抽出"必须原样保住"的片段。 */
export function mustKeep(text) {
  const s = String(text || '')
  const out = []
  for (const m of s.matchAll(/「([^」]{1,60})」/g)) out.push(m[1])
  for (const m of s.matchAll(/“([^”]{1,60})”/g)) out.push(m[1])
  for (const m of s.matchAll(/"[^"\n]{1,60}"/g)) out.push(m[0].slice(1, -1))
  for (const m of s.matchAll(/[A-Za-z]:\\[^\s，。；、）)"]+/g)) out.push(m[0])
  for (const m of s.matchAll(/https?:\/\/[^\s，。；、）)"]+/g)) out.push(m[0])
  for (const m of s.matchAll(/\d+(?:\.\d+)?/g)) out.push(m[0])
  return [...new Set(out.filter((x) => x && x.trim()))]
}

/**
 * 保真 + 长度检查。
 * @returns {{ok: true} | {ok: false, reason: string, missing?: string[]}}
 */
export function checkTranslation(original, translated) {
  const out = String(translated || '').trim()
  if (!out) return { ok: false, reason: 'empty' }
  const missing = mustKeep(original).filter((piece) => !out.includes(piece))
  if (missing.length) return { ok: false, reason: 'missing', missing }
  const limit = Math.max(Math.ceil(String(original).length * 1.6), String(original).length + 40)
  if (out.length > limit) return { ok: false, reason: 'too-long' }
  return { ok: true }
}

/** 拼一次调用的输入。 */
export function buildPrompt({ text, lastAssistant, priorUser }) {
  const parts = [PROTOCOL_TEMPLATE, '']
  parts.push('上一条回复(只用于理解指代):')
  parts.push(lastAssistant ? String(lastAssistant).slice(0, 300) : '(无)')
  if (Array.isArray(priorUser) && priorUser.length) {
    parts.push('')
    parts.push('此前舰长已经说过的话(按顺序,只用于理解指代):')
    for (const line of priorUser) parts.push('- ' + String(line).slice(0, 200))
  }
  parts.push('')
  parts.push('原消息:')
  parts.push(String(text))
  return parts.join('\n')
}

/**
 * 创建改写器。
 * @param {object} ctx
 * @param {{timeoutMs?: number, maxTokens?: number, maxChars?: number}} [options]
 */
export function createUserTranslator(ctx, options = {}) {
  const timeoutMs = options.timeoutMs ?? 6000
  const maxTokens = options.maxTokens ?? 900
  const maxChars = options.maxChars ?? 2000
  const cache = new Map()
  const CACHE_MAX = 64

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
    last = { at: Date.now(), reason: String(reason), ...extra }
  }

  function report() {
    return { stats, last }
  }

  /**
   * 翻一条。
   * @returns {Promise<{ok: boolean, text?: string, reason?: string}>}
   */
  async function translate(input) {
    const original = String(input?.text ?? '')
    if (!original.trim()) return { ok: false, reason: 'empty-input' }
    if (original.length > maxChars) {
      note('too-long-input')
      return { ok: false, reason: 'too-long-input' }
    }

    const route = input?.route
    if (!route || !route.provider || !route.model) {
      note('no-route')
      return { ok: false, reason: 'no-route' }
    }

    const key = createHash('sha1')
      .update(String(input?.personaId ?? ''))
      .update('\u0000')
      .update(String(input?.lastAssistant ?? '').slice(0, 200))
      .update('\u0000')
      .update(JSON.stringify(input?.priorUser ?? []))
      .update('\u0000')
      .update(original)
      .digest('hex')
    const hit = cache.get(key)
    if (hit) {
      note('cached')
      return { ok: true, text: hit }
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
      const messages = [
        { role: 'system', content: [{ type: 'text', text: String(input?.personaText ?? '') }] },
        { role: 'user', content: [{ type: 'text', text: buildPrompt(input) }] },
      ]
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        messages,
        maxTokens,
        purpose: 'masterprompt-translate',
        signal: controller.signal,
      })
      let out = ''
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
      }
      const text = out.trim()
      const check = checkTranslation(original, text)
      if (!check.ok) {
        note(check.reason, check.missing ? { missing: check.missing.slice(0, 5) } : {})
        return { ok: false, reason: check.reason, missing: check.missing }
      }
      cache.set(key, text)
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value)
      note('ok')
      return { ok: true, text }
    } catch (e) {
      const reason = String((e && e.message) || e)
      note('error:' + reason)
      return { ok: false, reason }
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 翻一批(中插可能不止一条),后面的能看到前面翻过的。
   * @returns {Promise<{texts: string[], translated: number, failed: number}>}
   */
  async function translateBatch(input) {
    const list = Array.isArray(input?.texts) ? input.texts : []
    const out = []
    const prior = []
    let okCount = 0
    for (const text of list) {
      const r = await translate({ ...input, text, priorUser: [...(input.priorUser ?? []), ...prior] })
      if (r.ok && r.text) {
        out.push(r.text)
        prior.push(r.text)
        okCount += 1
      } else {
        out.push(String(text))
      }
    }
    return { texts: out, translated: okCount, failed: list.length - okCount }
  }

  return { translate, translateBatch, report }
}
