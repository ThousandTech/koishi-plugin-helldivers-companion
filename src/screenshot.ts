import { createHash } from 'node:crypto'
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Page } from 'puppeteer-core'
import sharp from 'sharp'
import type { BrowserProvider, PluginConfig, ScreenshotTarget } from './types'
import type { Translator } from './translator'
import { parseOfficialMarkup } from './official-markup'
import type { OfficialMajorOrder } from './official-api'
import { glossaryTranslations, staticTranslations } from './glossary'

const cleanupScript = `(() => {
  const phrases = ['A NEW MESSAGE has been received', 'A NEW MAJOR ORDER has been issued', 'A NEW DISPATCH has been broadcast', 'A NEW CHANGELOG has been posted to Companion Dispatch'];
  const closeToasts = () => {
    // Companion renders notifications as .toastLeft/.toastRight cards. The
    // close control is a sibling of .toast_content and is more reliable than
    // removing an arbitrary text parent from the Svelte tree.
    document.querySelectorAll('.toastLeft .close, .toastRight .close, [class*="toast"] .close').forEach((close) => {
      if (close.offsetWidth > 0 && close.offsetHeight > 0) close.click();
    });
  };
  const hide = () => Array.from(document.querySelectorAll('div')).forEach((node) => {
    const text = (node.textContent || '').trim();
    if (phrases.some((value) => text.startsWith(value))) {
      const toast = node.closest('.toastLeft, .toastRight');
      const card = toast?.closest('[class~="outer"]') || toast?.parentElement;
      if (card && card.getBoundingClientRect().width <= 420) card.style.setProperty('display', 'none', 'important');
      else { const parent = node.parentElement; if (parent && parent.getBoundingClientRect().width <= 420) parent.style.setProperty('display', 'none', 'important'); }
    }
  });
  closeToasts(); hide();
  new MutationObserver(() => { closeToasts(); hide(); }).observe(document.documentElement, { childList: true, subtree: true });
  setInterval(closeToasts, 100);
})()`

export async function extractTexts(page: Page, target: ScreenshotTarget, knownPhrases: string[]): Promise<string[]> {
  return page.evaluate((kind, staticKeysInput) => {
    const markedRoot = document.querySelector<HTMLElement>('[data-hd2-capture-root="true"]')
    let root: HTMLElement | null = markedRoot || document.body
    if (!markedRoot && kind === 'news') {
      const marker = /(?:JUST NOW|MINUTES? AGO|HOURS? AGO|DAYS? AGO|TODAY|YESTERDAY)/i
      const candidates = Array.from(document.querySelectorAll<HTMLElement>("article, div.inline-block, [class*='news'], [class*='News'], [data-news]"))
        // The latest card is normally the wide first item. Its text can be
        // short (often under 200 characters), so a high text-length cutoff
        // accidentally selects body and captures the whole news feed.
        .filter(node => marker.test(node.innerText) && node.innerText.length > 80 && node.offsetWidth >= 500)
        .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top)
      root = candidates[0] || document.querySelector('main') || document.body
    } else if (!markedRoot && kind === 'dss') {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('div.flex.flex-col.gap-2')).filter(node => {
        const text = node.innerText.toUpperCase(); return text.includes('NEXT FTL JUMP') && text.includes('ORBITAL BLOCKADE') && text.includes('EAGLE STORM')
      })
      root = (candidates[0]?.closest('.noselect.inner') as HTMLElement | null) || candidates[0] || document.body
    }
    root.setAttribute('data-hd2-capture-root', 'true')
    const result: string[] = []; const seen = new Set<string>()
    const elements = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))].filter(node => !node.closest('script, style, noscript, template'))
    for (const phrase of staticKeysInput) {
      const key = phrase.replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase()
      const matches = elements.filter(node => (node.textContent || '').replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase() === key)
      const selected = matches.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length)[0]
      if (!selected) continue
      const style = getComputedStyle(selected); const rect = selected.getBoundingClientRect()
      if (style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0) continue
      const text = (selected.textContent || '').replace(/\s+/g, ' ').trim()
      const normalizedText = text.replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase()
      if (!seen.has(normalizedText)) { seen.add(normalizedText); result.push(text) }
    }
    // Planet and sector headings are SVG labels near the top of the page.
    // Collect them before the general text cap so a long planet description
    // cannot consume all 96 slots first.
    root.querySelectorAll('svg text').forEach(node => {
      if (result.length >= 96) return
      const text = (node.textContent || '').trim()
      const style = getComputedStyle(node); const rect = node.getBoundingClientRect()
      const normalizedText = text.replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase()
      if (!text || text.length > 1400 || !/[A-Za-z]{3}/.test(text) || style.display === 'none' || style.visibility === 'hidden' || rect.width <= 0 || rect.height <= 0 || seen.has(normalizedText)) return
      seen.add(normalizedText); result.push(text)
    })
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    while (walker.nextNode() && result.length < 96) {
      const node = walker.currentNode as Text; const parent = node.parentElement; const text = (node.nodeValue || '').trim()
      if (!parent || parent.closest('script, style, noscript, template') || !text || text.length > 1400 || !/[A-Za-z]{3}/.test(text)) continue
      const style = getComputedStyle(parent); const rect = parent.getBoundingClientRect()
      const isSvgText = parent.namespaceURI === 'http://www.w3.org/2000/svg' && parent.tagName.toLowerCase() === 'text'
      const normalizedText = text.replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase()
      if (style.display === 'none' || style.visibility === 'hidden' || (!isSvgText && (rect.width <= 0 || rect.height <= 0)) || seen.has(normalizedText)) continue
      seen.add(normalizedText); result.push(text)
    }
    return result
  }, target.kind, knownPhrases)
}

export async function applyTranslations(page: Page, translations: Record<string, string>, authoritativeSources: string[] = []) {
  await page.evaluate((map, staticEntries, glossaryEntries, authoritativeSourcesInput) => {
    const root = document.querySelector('[data-hd2-capture-root="true"]') || document.body
    const blockText = (node: Element) => node.textContent || ''
    const renderedText = (node: Element) => (node as HTMLElement).innerText || blockText(node)
    const normalize = (text: string) => text.replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase()
    const normalized = new Map(Object.entries(map).map(([source, translated]) => [source.replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase(), translated]))
    const fullBlocks = new Map<string, string>(glossaryEntries.map(([source, translated]) => [source.replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase(), translated]))
    for (const [source, translated] of staticEntries) fullBlocks.set(source.replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase(), translated)
    const staticBlockKeys = new Set(staticEntries.map(([source]) => source.replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase()))
    // Official API entries are full news/briefing blocks.  They are not
    // static UI strings, but they need the same authoritative fallback when
    // Companion splits the block across highlighted spans.
    const authoritativeBlockKeys = new Set([...staticBlockKeys, ...authoritativeSourcesInput.map(normalize)])
    for (const [source, translated] of Object.entries(map)) fullBlocks.set(source.replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase(), translated)
    const getBlockKey = (node: Element) => {
      const textKey = normalize(blockText(node))
      if (fullBlocks.has(textKey)) return textKey
      const visibleKey = normalize(renderedText(node))
      return authoritativeBlockKeys.has(visibleKey) && fullBlocks.has(visibleKey) ? visibleKey : undefined
    }
    const blocks = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))].filter(node => !node.closest('script, style, noscript, template') && getBlockKey(node) !== undefined)
      .filter(node => !Array.from(node.querySelectorAll('*')).some(child => getBlockKey(child) === getBlockKey(node)))
      .sort((a, b) => b.querySelectorAll('*').length - a.querySelectorAll('*').length)
    const protectedNodes = new Set<Node>()
    for (const block of blocks) {
      if (Array.from(protectedNodes).some(parent => parent === block || parent.contains(block))) continue
      const blockKey = getBlockKey(block)!
      const translated = fullBlocks.get(blockKey)!
      const leaves: Text[] = []
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) leaves.push(walker.currentNode as Text)
      const anchors = new Map<Text, { value: string; start: number; end: number }>()
      let searchFrom = 0
      let safe = true
      for (const node of leaves) {
        const source = (node.nodeValue || '').trim()
        if (!source || node.parentElement === block) continue
        const key = source.replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase()
        let value = normalized.get(key) || fullBlocks.get(key)
        if (!value) {
          const bare = key.replace(/^[\s.,:;!?]+|[\s.,:;!?]+$/g, '')
          value = normalized.get(bare) || fullBlocks.get(bare)
        }
        if (!value) { safe = false; break }
        const start = translated.toLowerCase().indexOf(value.toLowerCase(), searchFrom)
        if (start < 0 || translated.toLowerCase().indexOf(value.toLowerCase(), start + value.length) >= 0) { safe = false; break }
        if (/[.!?]$/.test(source) && /[。！？]/.test(translated[start + value.length] || '\0')) value += translated[start + value.length]
        anchors.set(node, { value, start, end: start + value.length }); searchFrom = start + value.length
      }
      if (safe && block.children.length > 0 && anchors.size > 0) {
        let cursor = 0
        let pending: Text[] = []
        const planned = new Map<Text, string>()
        const insertions: Array<{ before: Node | null; value: string }> = []
        for (const node of [...leaves, null]) {
          const anchor = node ? anchors.get(node) : undefined
          if (node && !anchor) { pending.push(node); continue }
          const value = translated.slice(cursor, anchor?.start ?? translated.length)
          // Keep every existing element intact. If the original ends inside a
          // highlight, put the translated suffix beside it, outside its style.
          const destination = pending.find(node => node.parentElement === block)
          for (const node of pending) planned.set(node, node === destination ? value : '')
          if (!destination && value) {
            let sibling: Node | null = node
            while (sibling && sibling.parentNode !== block) sibling = sibling.parentNode
            insertions.push({ before: sibling, value })
          }
          pending = []
          if (node && anchor) {
            planned.set(node, anchor.value)
            cursor = anchor.end
          }
        }
        for (const [node, value] of planned) node.nodeValue = value
        for (const { before, value } of insertions) block.insertBefore(document.createTextNode(value), before)
        protectedNodes.add(block); continue
      }
      // A static/full-block translation is authoritative even when its
      // wording intentionally differs from the glossary term used by one of
      // the nested labels (for example, "defense campaigns" -> "保卫战役").
      // In that case the anchor mapping is ambiguous, but leaving the block
      // untouched would leak the original English into the screenshot. Keep
      // the existing elements (and therefore their layout/styles) and place
      // the complete translation in the block's own text position.
      if (!safe && authoritativeBlockKeys.has(blockKey) && block.children.length > 0 && leaves.length > 0) {
        const direct = leaves.find(node => node.parentElement === block)
        for (const node of leaves) node.nodeValue = ''
        if (direct) direct.nodeValue = translated
        else block.insertBefore(document.createTextNode(translated), block.firstChild)
        protectedNodes.add(block); continue
      }
      if (block.children.length === 0 && leaves.length === 1) {
        const node = leaves[0]; const raw = node.nodeValue || ''
        node.nodeValue = `${raw.match(/^\s*/)?.[0] || ''}${translated}${raw.match(/\s*$/)?.[0] || ''}`
        protectedNodes.add(block)
      }
    }
    const termEntries = glossaryEntries.sort((a, b) => b[0].length - a[0].length)
    const terms = new Map(termEntries.map(([source, localized]) => [source.replace(/\s+/g, ' ').trim().toLowerCase(), localized]))
    const termPattern = new RegExp(`(?<![A-Za-z0-9])(?:${termEntries.map(([source]) => source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|')})(?![A-Za-z])`, 'gi')
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    while (walker.nextNode()) {
      const node = walker.currentNode as Text; const source = (node.nodeValue || '').trim(); const translated = map[source] || normalized.get(source.replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase())
      if (node.parentElement?.closest('script, style, noscript, template')) continue
      if (Array.from(protectedNodes).some(parent => parent === node.parentElement || parent.contains(node))) continue
      const value = translated && translated !== source ? translated : source.replace(termPattern, match => terms.get(match.replace(/\s+/g, ' ').trim().toLowerCase()) || match)
      if (!value || value === source) continue
      const raw = node.nodeValue || ''; node.nodeValue = `${raw.match(/^\s*/)?.[0] || ''}${value}${raw.match(/\s*$/)?.[0] || ''}`
    }
  }, translations, Object.entries(staticTranslations), Object.entries(glossaryTranslations), authoritativeSources)
}

export async function applyOfficialBlocks(page: Page, entries: Array<[string, string]>) {
  const rendered = entries.map(([source, localized]) => [
    source.replace(/<\/?i(?:=\d+)?>/gi, '').trim(),
    localized.trim(),
  ] as [string, string]).filter(([source, localized]) => source && localized && source !== localized)
    .map(([source, localized]) => ({ source, segments: parseOfficialMarkup(localized) }))
  if (!rendered.length) return 0
  return page.evaluate((pairs) => {
    const root = document.querySelector('[data-hd2-capture-root="true"]') || document.body
    const elements = [root, ...Array.from(root.querySelectorAll('*'))] as HTMLElement[]
    const blockText = (node: Element) => (node as HTMLElement).innerText || node.textContent || ''
    let replacements = 0
    for (const { source, segments } of pairs) {
      const expected = source.replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase()
      const matches = elements.filter(node => blockText(node).replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase() === expected)
      // Replace the deepest exact block. This keeps surrounding card layout,
      // while allowing Companion's nested highlight/link markup to differ.
      const selected = matches.filter(node => !matches.some(other => other !== node && node.contains(other)))
      for (const node of selected) {
        // Companion can render the entire multi-paragraph news body in one
        // whitespace-pre-wrap div. Newlines are text, not structural blocks:
        // rebuild its inline emphasis too, or the plain translation fallback
        // will flatten the Chinese body and leave the yellow spans empty.
        // Preserve actual structural blocks, but rebuild inline spans.
        if (node.querySelector('article, section, div, p, h1, h2, h3, h4, h5, h6, ul, ol, li, table')) continue
        const fragment = document.createDocumentFragment()
        for (const segment of segments) {
          if (segment.highlight) {
            const span = document.createElement('span')
            span.className = 'text-hd-yellow'
            span.style.color = '#ffe900'
            span.textContent = segment.text
            fragment.append(span)
          } else fragment.append(document.createTextNode(segment.text))
        }
        node.replaceChildren(fragment)
        replacements++
      }
    }
    return replacements
  }, rendered)
}

export class ScreenshotService {
  private locks = new Map<string, Promise<string>>()
  private majorOrderLocks = new Map<string, Promise<string[]>>()
  constructor(private browser: BrowserProvider, private translator: Translator, private config: PluginConfig) {}

  async capture(target: ScreenshotTarget, force = false, beforeRefresh?: () => Promise<void>): Promise<string> {
    const namespace = this.config.translationEnabled ? this.translator.providerFingerprint() : 'disabled'
    const key = createHash('sha1').update(`translation-v6-multiline-official-highlights:${namespace}:${target.url}`).digest('hex').slice(0, 12)
    const path = join(this.config.cacheDir, `companion_${target.kind}_${key}.png`)
    if (!force && await this.fresh(path)) return path
    const running = this.locks.get(path)
    if (running) return running
    const task = (async () => {
      await beforeRefresh?.()
      return this.captureUncached(target, path)
    })().finally(() => this.locks.delete(path))
    this.locks.set(path, task)
    return task
  }

  async captureMajorOrders(target: ScreenshotTarget, orders: OfficialMajorOrder[], force = false): Promise<string[]> {
    if (target.kind !== 'mo') throw new Error('最高指令批量截图仅支持 mo 目标')
    const lockKey = target.url + JSON.stringify(orders)
    const running = this.majorOrderLocks.get(lockKey)
    if (running) return running
    const task = this.captureMajorOrdersUncached(target, orders, force).finally(() => this.majorOrderLocks.delete(lockKey))
    this.majorOrderLocks.set(lockKey, task)
    return task
  }

  private async captureMajorOrdersUncached(target: ScreenshotTarget, orders: OfficialMajorOrder[], force: boolean) {
    const namespace = this.config.translationEnabled ? this.translator.providerFingerprint() : 'disabled'
    await mkdir(this.config.cacheDir, { recursive: true })
    await this.cleanPartialScreenshots(this.config.cacheDir)
    const paths: string[] = []
    const seen = new Set<string>()
    const normalize = (value: string) => value.replace(/<\/?i(?:=\d+)?>/gi, '').replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase()
    let page: Page | undefined
    try {
      page = await this.browser.createPage()
      await page.setViewport(target.viewport)
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: this.config.pageLoadTimeout })
      await this.waitReady(page, target)
      await page.evaluate(cleanupScript)
      await this.openMajorOrder(page)
      while (true) {
        await this.markMajorOrder(page)
        const source = await page.$eval('[data-hd2-major-order-modal="true"]', node => (node as HTMLElement).innerText)
        const body = await page.$eval('[data-hd2-major-order-modal="true"] .content', node => (node as HTMLElement).innerText)
        const identity = normalize(body)
        if (seen.has(identity)) throw new Error('最高指令消息队列重复，已停止以避免漏发后续消息')
        if (seen.size >= 50) throw new Error('最高指令消息队列超过 50 条，请检查页面结构')
        seen.add(identity)
        // Match the actual open message, independent of API and popup ordering.
        const order = orders.find(item => normalize(item.message) === identity)
        if (!order) throw new Error(`未找到当前最高指令消息对应的官方中文：${source.split('\n')[0]}`)
        const key = createHash('sha1').update(`major-orders-v3:${namespace}:${target.url}:${order?.id ?? ''}:${identity}:${order?.localizedTitle ?? ''}:${order?.localizedMessage ?? ''}`).digest('hex').slice(0, 12)
        const output = join(this.config.cacheDir, `companion_mo_${key}.png`)
        if (!force && await this.fresh(output)) paths.push(output)
        else {
          const temporary = `${output}.${process.pid}.${Date.now()}.tmp.png`
          let keepTemporary = false
          try {
            const entries: Array<[string, string]> = [[order.title, order.localizedTitle], [order.message, order.localizedMessage]]
            const translation = await this.translatePage(page, target, entries)
            const disposition = captureDisposition(translation, await this.staleUsable(output))
            if (disposition === 'stale') paths.push(output)
            else {
              await this.captureMajorOrder(page, temporary, target)
              await stat(temporary)
              if (disposition === 'cache') { await rename(temporary, output); paths.push(output) }
              else { keepTemporary = true; paths.push(temporary) }
            }
            console.info(`[HD2] MO ${paths.length}: ${order?.id ?? 'fallback'} ${source.split('\n')[0]}`)
          } finally { if (!keepTemporary) await unlink(temporary).catch(() => undefined) }
        }
        if (!await this.advanceMajorOrder(page)) break
      }
      return paths
    } finally {
      await page?.close().catch(() => undefined)
    }
  }

  private async translatePage(page: Page, target: ScreenshotTarget, officialEntries: Array<[string, string]>) {
    const sources = officialEntries.map(([source]) => source.replace(/<\/?i(?:=\d+)?>/gi, ''))
    const knownPhrases = [...Object.keys(staticTranslations), ...sources]
    await extractTexts(page, target, knownPhrases)
    await applyOfficialBlocks(page, officialEntries)
    const officialTranslations: Record<string, string> = Object.create(null)
    for (const [source, localized] of officialEntries) {
      officialTranslations[source.replace(/<\/?i(?:=\d+)?>/gi, '')] = parseOfficialMarkup(localized).map(segment => segment.text).join('')
    }
    await applyTranslations(page, officialTranslations, sources)
    const texts = await extractTexts(page, target, knownPhrases)
    const translation = await this.translator.translateCompanionFragments(target.kind, texts)
    await applyTranslations(page, { ...translation.translations, ...officialTranslations }, sources)
    await new Promise(resolve => setTimeout(resolve, 300))
    return translation
  }

  private async fresh(path: string) {
    try { return Date.now() - (await stat(path)).mtimeMs < this.config.screenshotCacheTtl * 1000 } catch { return false }
  }

  private async staleUsable(path: string) {
    try {
      const age = Date.now() - (await stat(path)).mtimeMs
      return age > this.config.screenshotCacheTtl * 1000 && age <= 7200 * 1000
    } catch { return false }
  }

  private async captureUncached(target: ScreenshotTarget, output: string) {
    await mkdir(dirname(output), { recursive: true })
    await this.cleanPartialScreenshots(dirname(output))
    const temporary = `${output}.${process.pid}.${Date.now()}.tmp.png`
    let keepTemporary = false
    let page: Page | undefined
    try {
      page = await this.browser.createPage()
      await page.setViewport(target.viewport)
      await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: this.config.pageLoadTimeout })
      await this.waitReady(page, target)
      await page.evaluate(cleanupScript)
      await new Promise(resolve => setTimeout(resolve, Math.min(this.config.screenshotWaitMs, 5000)))
      if (target.kind === 'mo') {
        await this.openMajorOrder(page)
        await this.markMajorOrder(page)
      }
      const officialEntries = this.translator.getOfficialEntries()
      const knownPhrases = [...Object.keys(staticTranslations), ...officialEntries.map(([source]) => source.replace(/<\/?i(?:=\d+)?>/gi, ''))]
      await extractTexts(page, target, knownPhrases)
      const officialCount = await applyOfficialBlocks(page, officialEntries)
      if (officialCount) await new Promise(resolve => setTimeout(resolve, 100))
      const officialTranslations: Record<string, string> = Object.create(null)
      for (const [source, localized] of officialEntries) {
        officialTranslations[source.replace(/<\/?i(?:=\d+)?>/gi, '')] = parseOfficialMarkup(localized).map(segment => segment.text).join('')
      }
      // Resolve deterministic translations before collecting model fragments.
      // This avoids sending detached pieces of an already translated block
      // to a provider and falsely marking a static-only page incomplete.
      await applyTranslations(page, officialTranslations, officialEntries.map(([source]) => source.replace(/<\/?i(?:=\d+)?>/gi, '')))
      const texts = await extractTexts(page, target, knownPhrases)
      const translation = await this.translator.translateCompanionFragments(target.kind, texts)
      const translations = { ...translation.translations }
      for (const [source, localized] of officialEntries) {
        translations[source.replace(/<\/?i(?:=\d+)?>/gi, '')] = parseOfficialMarkup(localized).map(segment => segment.text).join('')
      }
      const staleAvailable = await this.staleUsable(output)
      const disposition = captureDisposition(translation, staleAvailable)
      if (disposition === 'stale') { console.info('[HD2] Translation incomplete; serving stale screenshot', target.kind); return output }
      if (disposition === 'partial') console.warn('[HD2] Translation incomplete; screenshot will not enter main cache', target.kind, translation.untranslatedCount)
      if (Object.keys(translations).length) {
        await applyTranslations(page, translations, officialEntries.map(([source]) => source.replace(/<\/?i(?:=\d+)?>/gi, '')))
        await new Promise(resolve => setTimeout(resolve, 300))
      }
      if (target.kind === 'news') await this.captureNews(page, temporary, target)
      else if (target.kind === 'mo') await this.captureMajorOrder(page, temporary, target)
      else if (target.kind === 'dss') {
        const element = await page.$('[data-hd2-capture-root="true"]')
        if (element) await element.screenshot({ path: temporary as `${string}.png`, type: 'png' }); else await page.screenshot({ path: temporary as `${string}.png`, type: 'png', clip: target.clip })
      } else await page.screenshot({ path: temporary as `${string}.png`, type: 'png', ...(target.clip ? { clip: target.clip } : {}) })
      await stat(temporary)
      if (disposition === 'cache') await rename(temporary, output)
      else keepTemporary = true
      return keepTemporary ? temporary : output
    } catch (error) {
      if (target.kind === 'mo') throw error
      if (await this.staleUsable(output)) return output
      throw error
    } finally {
      await page?.close().catch(() => undefined)
      if (!keepTemporary) await unlink(temporary).catch(() => undefined)
    }
  }

  private async cleanPartialScreenshots(directory: string) {
    const names = await readdir(directory)
    await Promise.all(names.filter(name => /^companion_.*\.tmp\.png$/.test(name)).map(async name => {
      const path = join(directory, name)
      try { if (Date.now() - (await stat(path)).mtimeMs > 86400000) await unlink(path) } catch {}
    }))
  }

  private async waitReady(page: Page, target: ScreenshotTarget) {
    await page.waitForFunction((kind, expected) => {
      const text = (document.body?.innerText || '').toUpperCase()
      if (text.length < 100) return false
      if (kind === 'news') return /(?:JUST NOW|MINUTES? AGO|HOURS? AGO|DAYS? AGO|TODAY|YESTERDAY)/i.test(text)
      if (kind === 'dss') return text.includes('NEXT FTL JUMP') && text.includes('ORBITAL BLOCKADE') && text.includes('EAGLE STORM')
      if (kind === 'planet') return location.hash.toLowerCase().startsWith('#hellpad/planets/') && text.includes(expected)
      if (kind === 'overview') return text.includes('GALACTIC IMPACT MOD')
      if (kind === 'mo') return /(?:JUST NOW|MINUTES? AGO|HOURS? AGO|DAYS? AGO|TODAY|YESTERDAY)/i.test(text) || /REVIEW\s+MESSAGES?\s+FROM\s+SUPER\s+EARTH/i.test(text)
      return document.querySelector('.planets-list > *') !== null || document.querySelector("[class*='campaign'], [class*='Campaign']") !== null
    }, { timeout: this.config.pageLoadTimeout }, target.kind, target.key.split('_(')[0].replaceAll('_', ' ').toUpperCase())
  }

  private async captureNews(page: Page, path: string, target: ScreenshotTarget) {
    const geometry = await page.evaluate(() => {
      const root = document.querySelector('[data-hd2-capture-root="true"]') as HTMLElement | null
      if (!root) return null
      const all = [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]
      const visible = (node: HTMLElement) => {
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0
      }
      const scrollable = all.filter(node => visible(node) && node.scrollHeight > node.clientHeight + 80)
        // Prefer the first real content scroller, not a page-wide wrapper that
        // happens to contain several cards and the surrounding navigation.
        .sort((a, b) => a.scrollHeight - b.scrollHeight)
      const scroller = scrollable[0] || null
      const crop = scroller || root
      const rect = crop.getBoundingClientRect()
      const viewportWidth = document.documentElement.clientWidth || innerWidth
      const viewportHeight = document.documentElement.clientHeight || innerHeight
      const left = Math.max(0, Math.floor(rect.left))
      const top = Math.max(0, Math.floor(rect.top))
      const right = Math.min(viewportWidth, Math.ceil(rect.right))
      const bottom = Math.min(viewportHeight, Math.ceil(rect.bottom))
      const width = right - left
      const height = bottom - top
      if (scroller) (window as unknown as { __hd2NewsScroller: HTMLElement }).__hd2NewsScroller = scroller
      return {
        x: left, y: top, width, height,
        total: scroller ? Math.min(scroller.scrollHeight, 3600) : height,
        maxScrollTop: scroller ? Math.min(scroller.scrollHeight, 3600) - scroller.clientHeight : 0,
        scrollable: !!scroller,
      }
    })
    const fallback = target.clip!
    if (!geometry || geometry.width < 300 || geometry.height < 100) {
      await page.screenshot({ path: path as `${string}.png`, type: 'png', clip: fallback })
      return
    }
    const clip = { x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height }
    const scrollHeight = geometry.total
    if (!geometry.scrollable || scrollHeight <= geometry.height + 20) {
      await page.screenshot({ path: path as `${string}.png`, type: 'png', clip })
      return
    }
    const viewportHeight = geometry.height
    const stride = Math.max(1, viewportHeight - 48)
    const segments: Array<{ input: Buffer; top: number }> = []
    const maxScrollTop = Math.max(0, geometry.maxScrollTop)
    const offsets = [0]
    while (offsets[offsets.length - 1] < maxScrollTop) {
      offsets.push(Math.min(offsets[offsets.length - 1] + stride, maxScrollTop))
    }
    for (const offset of offsets) {
      await page.evaluate(value => {
        const scroller = (window as unknown as { __hd2NewsScroller?: HTMLElement }).__hd2NewsScroller
        if (scroller) scroller.scrollTop = value
      }, offset)
      await new Promise(resolve => setTimeout(resolve, 120))
      segments.push({ input: Buffer.from(await page.screenshot({ type: 'png', clip })), top: offset })
    }
    const width = clip.width
    const height = Math.min(scrollHeight, viewportHeight + maxScrollTop)
    const composites: sharp.OverlayOptions[] = segments.map(({ input, top }) => ({ input, left: 0, top }))
    await sharp({ create: { width, height, channels: 4, background: '#000000' } }).composite(composites).png().toFile(path)
  }

  private async openMajorOrder(page: Page) {
    const clicked = await page.evaluate(() => {
      const nodes = Array.from(document.querySelectorAll<HTMLElement>('.briefing-box, [class*="briefing-box"]'))
        .filter(node => /REVIEW\s+MESSAGES?\s+FROM\s+SUPER\s+EARTH/i.test(node.innerText || node.textContent || '') &&
          !Array.from(node.querySelectorAll<HTMLElement>('.briefing-box, [class*="briefing-box"]')).some(other => /REVIEW\s+MESSAGES?\s+FROM\s+SUPER\s+EARTH/i.test(other.innerText || other.textContent || '')))
      const target = nodes[0]
      if (!target) return false
      target.click()
      return true
    })
    if (!clicked) throw new Error('未找到“REVIEW MESSAGES FROM SUPER EARTH”按钮')
    await page.waitForFunction(() => {
      return Array.from(document.querySelectorAll<HTMLElement>('.content')).some(content => {
        let node: HTMLElement | null = content
        for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
          const rect = node.getBoundingClientRect()
          const text = (node.innerText || '').trim()
          if (node.offsetWidth > 0 && node.offsetHeight > 0 && rect.width >= 280 && rect.width <= 900 &&
            rect.height > 180 && node.querySelector('img') && text.length > 100) return true
        }
        return false
      })
    }, { timeout: this.config.pageLoadTimeout })
    await new Promise(resolve => setTimeout(resolve, 500))
  }

  private async advanceMajorOrder(page: Page): Promise<boolean> {
    // Translation mutates the current body; compare with the rendered text,
    // rather than the English body collected before translation.
    const currentBody = await page.$eval('[data-hd2-major-order-modal="true"] .content', node => (node as HTMLElement).innerText)
    const advanced = await page.evaluate(() => {
      const control = Array.from(document.querySelectorAll<HTMLElement>('div')).find(node =>
        node.children.length > 0 && (node.innerText || '').trim() === 'CONTINUE' && node.offsetWidth > 0 && node.offsetHeight > 0)
      if (!control) return false
      control.click()
      return true
    })
    if (!advanced) throw new Error('最高指令弹窗未找到“CONTINUE”控件，无法继续截图后续消息')
    const normalize = (value: string) => value.replace(/<\/?i(?:=\d+)?>/gi, '').replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase()
    await page.waitForFunction(previous => {
      const visibleContents = Array.from(document.querySelectorAll<HTMLElement>('.content')).filter(content => {
        let node: HTMLElement | null = content
        for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
          const rect = node.getBoundingClientRect()
          if (node.offsetWidth > 0 && node.offsetHeight > 0 && rect.width >= 280 && rect.width <= 900 &&
            rect.height > 180 && node.querySelector('img')) return true
        }
        return false
      })
      if (!visibleContents.length) return true
      return visibleContents.some(content => (content.innerText || '').replace(/<\/?i(?:=\d+)?>/gi, '').replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase() !== previous)
    }, { timeout: this.config.pageLoadTimeout }, normalize(currentBody))
    await new Promise(resolve => setTimeout(resolve, 300))
    return page.evaluate(() => {
      return Array.from(document.querySelectorAll<HTMLElement>('.content')).some(content => {
        let node: HTMLElement | null = content
        for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
          const rect = node.getBoundingClientRect()
          if (node.offsetWidth > 0 && node.offsetHeight > 0 && rect.width >= 280 && rect.width <= 900 &&
            rect.height > 180 && node.querySelector('img')) return true
        }
        return false
      })
    })
  }

  private async captureMajorOrder(page: Page, path: string, target: ScreenshotTarget) {
    await this.markMajorOrder(page)
    const modal = await page.$('[data-hd2-major-order-modal="true"]')
    if (!modal) throw new Error('已标记最高指令弹窗，但无法取得弹窗元素')
    const box = await modal.boundingBox()
    if (!box || box.width < 100 || box.height < 100) throw new Error('最高指令弹窗尺寸无效')
    const padding = 2
    await page.screenshot({
      path: path as `${string}.png`,
      type: 'png',
      clip: {
        x: Math.max(0, box.x - padding),
        y: Math.max(0, box.y - padding),
        width: Math.min(box.width + padding * 2, 1280 - Math.max(0, box.x - padding)),
        height: Math.min(box.height + padding * 2, 900 - Math.max(0, box.y - padding)),
      },
    })
    await modal.dispose().catch(() => undefined)
  }

  private async markMajorOrder(page: Page) {
    const marked = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('.content')).flatMap(content => {
        const ancestors: HTMLElement[] = []
        let node: HTMLElement | null = content
        for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
          const rect = node.getBoundingClientRect()
          const text = (node.innerText || '').trim()
          if (rect.width >= 280 && rect.width <= 900 && rect.height > 180 &&
            rect.left >= 0 && rect.top >= 0 && node.offsetWidth > 0 && node.offsetHeight > 0 &&
            node.querySelector('img') && text.length > 100 && text.length < 5000) ancestors.push(node)
        }
        // The modal card contains the image, heading, and .content body. The
        // CONTINUE button is outside this subtree and therefore stays out of
        // the crop. Choose the first (smallest) matching ancestor.
        return ancestors.slice(0, 1)
      })
      const selected = candidates.sort((a, b) => {
        const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect()
        return ar.width * ar.height - br.width * br.height
      })[0]
      if (!selected) return false
      document.querySelectorAll('[data-hd2-major-order-modal="true"]').forEach(node => node.removeAttribute('data-hd2-major-order-modal'))
      document.querySelectorAll('[data-hd2-capture-root="true"]').forEach(node => node.removeAttribute('data-hd2-capture-root'))
      selected.setAttribute('data-hd2-major-order-modal', 'true')
      selected.setAttribute('data-hd2-capture-root', 'true')
      return true
    })
    if (!marked) throw new Error('已打开最高指令，但未找到可截图的弹窗容器')
  }
}

export function captureDisposition(result: { complete: boolean; cacheable: boolean }, staleAvailable: boolean): 'stale' | 'cache' | 'partial' {
  if (!result.complete && staleAvailable) return 'stale'
  return result.cacheable ? 'cache' : 'partial'
}
