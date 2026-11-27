/**
 * 语言习惯表。
 *
 * 舰长把这层定死了:不要"审查",不要"改写",只留一张**第一人称写的习惯表**,
 * 而且是能在小框里直接编辑的那种。
 *
 * 表分两半:
 *   should    —— 布洛妮娅说话的样子,写成陈述句段落,渲染时直出正文
 *   lines     —— 负面清单(只在还有模板用它时才出现)
 *
 * 以前那套形态检测(禁 Markdown、禁第一人称、字数上限、签名检查)整层删掉了。
 * 删的理由是它判的是形态、不是语言习惯,而且它只能在事后记账:
 * 记了账,写出来的还是那个腔调。习惯表是从生成那侧说话,不需要回读。
 */

/** 把一个模板里的习惯行取出来,去重保序。 */
function linesOf(list, seen) {
  const out = []
  if (!Array.isArray(list)) return out
  for (const line of list) {
    if (typeof line !== 'string') continue
    const text = line.trim()
    if (!text || seen.has(text)) continue
    seen.add(text)
    out.push(text)
  }
  return out
}

/**
 * 合并多份人设的语言习惯。
 *
 * @param {object[]} templates - 参与合并的模板对象
 * @returns {{should: string[], shouldNot: string[]}}
 */
export function mergeVoice(templates) {
  const should = []
  const shouldNot = []
  const openers = []
  const seenShould = new Set()
  const seenNot = new Set()
  const seenOpener = new Set()
  for (const t of templates) {
    const style = t && t.style
    if (!style || typeof style !== 'object') continue
    should.push(...linesOf(style.should, seenShould))
    shouldNot.push(...linesOf(style.lines, seenNot))
    openers.push(...linesOf(style.openers, seenOpener))
  }
  return { should, shouldNot, openers }
}

/**
 * 渲染成可以塞进 system prompt 的一段。
 *
 * should 每项一段,直接接成正文:不加节标题、不加项目符号。
 * 标题和 `* ` 会把它变成一张待核对的清单,而那正是要拆掉的东西 ——
 * 一条被勾选的规则和一句对布洛妮娅的描述,读进去不是一回事。
 * lines 仍是负面清单,保留原来的带条目写法。
 *
 * @param {{should: string[], shouldNot: string[]}} voice
 * @returns {string} 没有习惯时返回空串
 */
export function voiceBlock(voice) {
  if (!voice) return ''
  const parts = []
  if (Array.isArray(voice.should) && voice.should.length) {
    parts.push(voice.should.join('\n\n'))
  }
  if (Array.isArray(voice.shouldNot) && voice.shouldNot.length) {
    parts.push(['【我不能这样说】', ...voice.shouldNot.map((line) => '* ' + line)].join('\n'))
  }
  return parts.join('\n\n')
}

/**
 * 首句模板：单独一段,由 order 排到 system prompt 最末。
 * 不并进 should 的理由:首句决定整段走向,和习惯表挤在一段里会被淹掉。
 *
 * @param {{openers: string[]}} voice
 * @returns {string} 没有首句模板时返回空串
 */
export function voiceOpenerBlock(voice) {
  if (!voice || !Array.isArray(voice.openers) || !voice.openers.length) return ''
  return ['【第一句从这里起头】', ...voice.openers.map((line) => '* ' + line)].join('\n')
}
