/**
 * 语言习惯表。
 *
 * 舰长把这层定死了:不要"审查",不要"改写",只留一张**第一人称写的习惯表**,
 * 而且是能在小框里直接编辑的那种。
 *
 * 表分两半:
 *   should    —— "我应该这样说"(正面示范,从游戏台词里提炼出来的说话方式)
 *   lines     —— "我不能这样说"(负面清单)
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
  const seenShould = new Set()
  const seenNot = new Set()
  for (const t of templates) {
    const style = t && t.style
    if (!style || typeof style !== 'object') continue
    should.push(...linesOf(style.should, seenShould))
    shouldNot.push(...linesOf(style.lines, seenNot))
  }
  return { should, shouldNot }
}

/**
 * 渲染成可以塞进 system prompt 的一段。
 *
 * @param {{should: string[], shouldNot: string[]}} voice
 * @returns {string} 没有习惯时返回空串
 */
export function voiceBlock(voice) {
  if (!voice) return ''
  const parts = []
  if (Array.isArray(voice.should) && voice.should.length) {
    parts.push(['【我应该这样说】', ...voice.should.map((line) => '* ' + line)].join('\n'))
  }
  if (Array.isArray(voice.shouldNot) && voice.shouldNot.length) {
    parts.push(['【我不能这样说】', ...voice.shouldNot.map((line) => '* ' + line)].join('\n'))
  }
  return parts.join('\n\n')
}
