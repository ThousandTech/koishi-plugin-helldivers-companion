import { createHash } from 'node:crypto'
import type { PageKind, PluginConfig } from './types'
import { TranslationCache } from './translation-cache'
import { hasTranslatableEnglish, preapplyGlossary, staticTranslations } from './glossary'

export interface CompanionTranslationResult {
  translations: Record<string, string>
  untranslatedCount: number
  complete: boolean
  cacheable: boolean
}

export class Translator {
  readonly cache: TranslationCache
  private cooldownUntil = 0
  private transientUntil = 0
  private active = 0
  private waiters: Array<() => void> = []
  private jobs = new Set<Promise<void>>()
  private inflight = new Map<string, Promise<string>>()
  constructor(private config: PluginConfig, private official = new Map<string, string>()) {
    this.cache = new TranslationCache(config.cacheDir, this.providerFingerprint(), config.translationFallbackTtl)
  }
  setOfficial(values: Map<string, string>) { this.official = values }
  mergeOfficial(values: Map<string, string>) {
    for (const [source, localized] of values) this.official.set(source, localized)
  }
  private findOfficial(normalized: string) {
    for (const [source, localized] of this.official) {
      if (source.replace(/\s+/g, ' ').trim().toLowerCase() === normalized) return localized
    }
  }
  getOfficialEntries(): Array<[string, string]> { return [...this.official.entries()] }
  providerFingerprint() { return createHash('sha256').update(['translation-protocol-v4-hd2-localization', this.config.translationMode, this.config.translationApiUrl, this.config.translationModel, this.config.translationTargetLang].join('|')).digest('hex').slice(0, 16) }
  inTransientFailure() { return Date.now() < this.transientUntil || Date.now() < this.cooldownUntil }
  async close() { await Promise.allSettled([...this.jobs]); await this.cache.flush() }

  async translateCompanionFragments(kind: PageKind, texts: string[]): Promise<CompanionTranslationResult> {
    const translations: Record<string, string> = Object.create(null)
    const pending: Array<{ source: string; key: string }> = []
    for (const source of new Set(texts.filter(text => text.trim()))) {
      const normalized = source.replace(/\s+/g, ' ').trim().toLowerCase()
      const exact = this.official.get(source.trim()) ?? this.findOfficial(normalized) ?? (Object.hasOwn(staticTranslations, normalized) ? staticTranslations[normalized] : undefined)
      if (exact) { translations[source] = exact; continue }
      const prepared = preapplyGlossary(source)
      if (!hasTranslatableEnglish(prepared)) { if (prepared !== source) translations[source] = prepared; continue }
      const digest = createHash('sha1').update(normalized).digest('hex').slice(0, 12)
      const key = 'companion_page_v3:' + kind + ':' + normalized.slice(0, 80) + ':' + digest
      const cached = await this.cache.get(key, source)
      if (cached?.success && cached.translated !== source) translations[source] = cached.translated
      else pending.push({ source, key })
    }
    if (!this.config.translationEnabled) return { translations, untranslatedCount: 0, complete: true, cacheable: true }
    const promises: Promise<void>[] = []
    const fresh = pending.filter(item => !this.inflight.has(item.key))
    for (let start = 0; start < fresh.length; start += 16) this.launch(fresh.slice(start, start + 16))
    for (const item of pending) {
      const request = this.inflight.get(item.key)!.then(value => { if (value !== item.source) translations[item.source] = value })
      promises.push(waitWithin(request, this.config.translationBatchTimeout).then(() => undefined))
    }
    await waitWithin(Promise.all(promises), this.config.translationBudget)
    const untranslatedCount = pending.filter(item => {
      const value = translations[item.source]
      return !value || hasTranslatableEnglish(value)
    }).length
    return { translations: { ...translations }, untranslatedCount, complete: untranslatedCount === 0, cacheable: untranslatedCount === 0 }
  }

  private launch(items: Array<{ source: string; key: string }>) {
    const batch = this.translateTexts(items.map(item => preapplyGlossary(item.source))).catch(() => items.map(item => preapplyGlossary(item.source)))
    const work = items.map((item, index) => {
      const result = batch.then(async values => {
        const value = values[index]
        // An unchanged preprocessed payload is a failure, not a translated fragment.
        if (value && value !== preapplyGlossary(item.source)) { await this.cache.store(item.key, item.source, value); return value }
        // Keep deterministic glossary substitutions visible even when the
        // provider fails; the remaining English fragment is counted below.
        return value || item.source
      }).catch(() => item.source)
      this.inflight.set(item.key, result)
      return result.finally(() => this.inflight.delete(item.key)).then(() => undefined)
    })
    const job = Promise.all(work).then(() => undefined)
    this.jobs.add(job)
    void job.finally(() => this.jobs.delete(job))
  }

  async translateMany(texts: string[]) {
    const result = await this.translateCompanionFragments('overview', texts)
    return texts.map(text => result.translations[text] ?? text)
  }
  private mode() {
    if (this.config.translationMode !== 'auto') return this.config.translationMode
    const path = new URL(this.config.translationApiUrl).pathname.toLowerCase()
    return /\/chat\/completions$|\/v1$|\/openai|\/oneapi/.test(path) || path === '/' ? 'openai' : 'builtin'
  }
  private async translateTexts(texts: string[]): Promise<string[]> {
    if (!this.config.translationApiUrl || this.inTransientFailure()) return texts
    if (this.mode() === 'builtin') return this.translateBuiltin(texts)
    if (texts.length === 1) return [await this.translateSingle(texts[0])]
    const content = await this.requestOpenAi(texts, true)
    if (!content) return texts
    const parsed = extractBatch(content)
    if (!parsed) return this.translateSingles(texts)
    return parsed.slice(0, texts.length).concat(await this.translateSingles(texts.slice(parsed.length)))
  }
  private async translateBuiltin(texts: string[]) {
    const marker = texts.length === 1 ? texts[0] : texts.map((text, index) => '[[HD2_' + index + ']] ' + text).join('\n')
    const url = new URL(this.config.translationApiUrl)
    const isUapi = url.pathname.endsWith('/ai/translate')
    if (isUapi) url.searchParams.set('target_lang', this.config.translationTargetLang.startsWith('zh') ? 'zh' : this.config.translationTargetLang)
    const data = await this.request(url.toString(), isUapi ? { text: marker, style: 'professional', context: 'entertainment', preserve_format: true } : { text: marker, sourceLanguage: 'auto', targetLanguage: this.config.translationTargetLang })
    if (!data) return texts
    const nested = data.data && typeof data.data === 'object' ? data.data as Record<string, unknown> : {}
    const value = [data.translatedText, data.translated_text, data.translation, nested.translatedText, nested.translated_text].find(item => typeof item === 'string')
    if (typeof value !== 'string') return texts
    if (texts.length === 1) return [value.trim()]
    if (!texts.every((_, index) => value.includes('[[HD2_' + index + ']]'))) return texts
    return texts.map((text, index) => value.split('[[HD2_' + index + ']]')[1].split(index + 1 < texts.length ? '[[HD2_' + (index + 1) + ']]' : '\0')[0].trim() || text)
  }
  private async translateSingle(text: string) { return await this.requestOpenAi([text], false) || text }
  private async translateSingles(texts: string[]) {
    const result = [...texts]
    for (let index = 0; index < Math.min(10, texts.length); index++) {
      if (this.inTransientFailure()) break
      if (index) await new Promise(resolve => setTimeout(resolve, 1500))
      result[index] = await this.translateSingle(texts[index])
    }
    return result
  }
  private async requestOpenAi(texts: string[], batch: boolean) {
    const endpoint = this.config.translationApiUrl.replace(/\/$/, '').replace(/\/chat\/completions$/, '') + '/chat/completions'
    const data = await this.request(endpoint, { model: this.config.translationModel, temperature: 0.2, stream: false, max_tokens: this.config.translationMaxTokens || undefined, messages: [{ role: 'system', content: localizationPrompt(this.config.translationTargetLang, batch) }, { role: 'user', content: batch ? JSON.stringify(texts) : texts[0] }] })
    const choices = data?.choices as Array<{ message?: { content?: unknown } }> | undefined
    const content = choices?.[0]?.message?.content
    return typeof content === 'string' ? content.trim() : ''
  }
  private async request(url: string, body: unknown): Promise<Record<string, unknown> | undefined> {
    if (this.active >= 3) await new Promise<void>(resolve => this.waiters.push(resolve))
    else this.active++
    try {
      if (this.inTransientFailure()) return
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(this.config.translationTimeout), headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(this.config.translationApiKey ? { Authorization: 'Bearer ' + this.config.translationApiKey } : {}) }, body: JSON.stringify(body) })
        if (response.ok) return await response.json() as Record<string, unknown>
        await response.text()
        if ([500, 502, 503, 504].includes(response.status) && attempt === 0) { await new Promise(resolve => setTimeout(resolve, 2000)); continue }
        if ([429, 567, 500, 502, 503, 504].includes(response.status)) {
          const retry = Number(response.headers.get('Retry-After')) * 1000
          this.cooldownUntil = Date.now() + Math.max(this.config.translationErrorCooldown, Number.isFinite(retry) ? retry : 0)
        }
        console.warn('[HD2] Translation API status=' + response.status)
        return
      }
    } catch (error) { this.transientUntil = Date.now() + this.config.translationErrorCooldown; console.warn('[HD2] Translation API failed', error instanceof Error ? error.name : 'network error') }
    // Pass the occupied slot directly to a waiter, so a new request cannot steal it.
    finally { const next = this.waiters.shift(); if (next) next(); else this.active-- }
  }
}

export async function waitWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), milliseconds) })]) }
  finally { if (timer) clearTimeout(timer) }
}

export function extractBatch(content: string): string[] | undefined {
  try {
    const parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, '').trim())
    const values = Array.isArray(parsed) ? parsed : parsed.translations ?? parsed.data?.translations
    return Array.isArray(values) && values.every(value => typeof value === 'string') ? values : undefined
  } catch { return undefined }
}

export function localizationPrompt(language: string, batch: boolean) {
  const prompt = '你是《绝地潜兵2》简体中文本地化编辑，为超级地球真理部改写战时新闻与战场简报。把英文游戏文本改写成自然流畅的' + language + '，像中文母语军官写的播报稿，坚决消除机翻腔。\n' +
    '输入中已内嵌的中文专有名词是官方译名，直接沿用；整句按中文语序重新组织，不要逐词替换。核心术语：Helldivers→绝地潜兵，Super Earth→超级地球，Managed Democracy→管理式民主，Ministry of Truth→真理部，Major Order→最高指令，Democracy Space Station/DSS→民主空间站/DSS，Terminids→终结族，Automatons→机器人，Illuminate→光能者，Defense Campaigns→防御战役，Liberation Campaigns→解放战役，Voteless→无票者，SEAF→超级地球武装部队，Galactic War→银河战争，Stratagem→战略配备，Hellpod→地狱舱，Eagle→飞鹰，Orbital→轨道，Reinforce→增援，Extract→撤离。其余专名简洁音译，罗马数字保留。\n' +
    '多用主动句和短句，军报节奏；删掉直译冠词，不用“被”“进行”“性的”等翻译腔；UI 标签≤6字。数字、百分比、日期、倒计时、ID、单位、原有换行和标记原样保留，不添加解释。\n' +
    '译感对照：✗ 超级地球的公民们被提醒要保持警惕 → ✓ 超级地球提醒各位公民保持警惕；✗ 一个针对终结族的新的解放战役已经被启动 → ✓ 针对终结族的新一轮解放战役已经打响。'
  return prompt + (batch ? '\n输入是同一页面的 JSON 字符串数组，可参考相邻上下文，但每条译文必须独立成立。只返回 JSON 对象 {"translations":["译文1","译文2"]}，数组长度和顺序与输入一致，不要 markdown 或其他内容。' : '\n只返回译文本身，不要解释、引号或 markdown。')
}
