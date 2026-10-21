// @vitest-environment happy-dom
import { mkdtemp, readFile, rm, stat, utimes, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ScreenshotService, applyOfficialBlocks, applyTranslations, extractTexts, captureDisposition } from '../src/screenshot'
import { defaults, type BrowserProvider, type PluginConfig, type ScreenshotTarget } from '../src/types'
import type { Translator } from '../src/translator'

const dirs: string[] = []
afterEach(async () => Promise.all(dirs.splice(0).map(path => rm(path, { recursive: true, force: true }))))

const target: ScreenshotTarget = { kind: 'home', key: 'home', url: 'https://companion.test/#home', label: 'home', viewport: { width: 1280, height: 900 } }

function browser(): BrowserProvider {
  return { async createPage() {
    const page: any = {
      setViewport: vi.fn(async () => undefined), goto: vi.fn(async () => undefined), waitForFunction: vi.fn(async () => undefined), close: vi.fn(async () => undefined),
      evaluate: vi.fn(async (callback: unknown) => {
        if (typeof callback === 'string') return undefined
        return String(callback).includes('createTreeWalker') ? ['English dispatch headline', 'Another English fragment', 'FORI PRIME', 'DRACO SECTOR'] : undefined
      }),
      screenshot: vi.fn(async (options: { path: string }) => { await writeFile(options.path, Buffer.from('png-fixture')); return Buffer.from('png-fixture') }),
    }
    return page
  } }
}

function config(directory: string, extra: Partial<PluginConfig> = {}): PluginConfig { return { ...defaults, ...extra, cacheDir: directory, screenshotWaitMs: 0, pageLoadTimeout: 1000, screenshotCacheTtl: 300 } }
function translator(result: { translations: Record<string, string>; untranslatedCount: number; complete: boolean; cacheable: boolean }) {
  return { getOfficialEntries: () => [], providerFingerprint: () => 'test-provider', translateCompanionFragments: vi.fn(async () => ({ ...result, translations: { ...result.translations } })) } as unknown as Translator
}

describe('screenshot translation orchestration', () => {
  it('refreshes official data only when a screenshot must actually be regenerated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'koishi-refresh-hook-')); dirs.push(directory)
    const service: any = new ScreenshotService(browser(), translator({ translations: {}, untranslatedCount: 0, complete: true, cacheable: true }), config(directory))
    const refresh = vi.fn(async () => undefined)
    vi.spyOn(service, 'captureUncached').mockImplementation(async (_target: unknown, output: string) => {
      await writeFile(output, 'fresh')
      return output
    })
    await service.capture(target, false, refresh)
    expect(refresh).toHaveBeenCalledOnce()
    await service.capture(target, false, refresh)
    expect(refresh).toHaveBeenCalledOnce()
    await service.capture(target, true, refresh)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it('captures each popup with its corresponding Chinese even when API order differs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'koishi-mo-test-')); dirs.push(directory)
    const orders = [
      { id: '1', title: 'FIRST', message: 'First body', localizedTitle: '第一', localizedMessage: '第一条正文' },
      { id: '2', title: 'SECOND', message: 'Second body', localizedTitle: '第二', localizedMessage: '第二条正文' },
    ]
    let index = 1
    const page: any = {
      setViewport: vi.fn(), goto: vi.fn(), evaluate: vi.fn(), close: vi.fn(async () => undefined),
      $eval: vi.fn(async (selector: string) => selector.endsWith('.content') ? orders[index].message : orders[index].title),
    }
    const service: any = new ScreenshotService({ createPage: async () => page }, translator({ translations: {}, untranslatedCount: 0, complete: true, cacheable: true }), config(directory))
    vi.spyOn(service, 'waitReady').mockResolvedValue(undefined)
    vi.spyOn(service, 'openMajorOrder').mockResolvedValue(undefined)
    vi.spyOn(service, 'markMajorOrder').mockResolvedValue(undefined)
    const translate = vi.spyOn(service, 'translatePage').mockResolvedValue({ complete: true, cacheable: true })
    vi.spyOn(service, 'captureMajorOrder').mockImplementation(async (_page: unknown, path: unknown) => { await writeFile(String(path), orders[index].localizedMessage) })
    vi.spyOn(service, 'advanceMajorOrder').mockImplementation(async () => { index--; return index >= 0 })
    const paths = await service.captureMajorOrders({ ...target, kind: 'mo' }, orders, true)
    expect(paths).toHaveLength(2)
    expect(await Promise.all(paths.map((path: string) => readFile(path, 'utf8')))).toEqual(['第二条正文', '第一条正文'])
    expect(translate.mock.calls.map(call => call[2])).toEqual([
      [['SECOND', '第二'], ['Second body', '第二条正文']],
      [['FIRST', '第一'], ['First body', '第一条正文']],
    ])
    expect(page.close).toHaveBeenCalledOnce()
  })

  it('advances from a translated popup and stops when CONTINUE closes the final popup', async () => {
    document.body.innerHTML = '<section data-hd2-major-order-modal="true"><div class="content">第一条正文</div></section><div id="continue"><span>CONTINUE</span></div>'
    const modal = document.querySelector('section')!
    modal.append(document.createElement('img'))
    vi.spyOn(modal, 'getBoundingClientRect').mockReturnValue({ width: 400, height: 300 } as DOMRect)
    const control = document.querySelector<HTMLElement>('#continue')!
    for (const node of [modal, control, modal.querySelector('.content')!]) {
      Object.defineProperty(node, 'offsetWidth', { value: 400 })
      Object.defineProperty(node, 'offsetHeight', { value: 300 })
    }
    let clicks = 0
    control.onclick = () => { if (++clicks === 1) modal.querySelector('.content')!.textContent = 'Second body'; else modal.remove() }
    const page: any = {
      $eval: async (selector: string, fn: Function) => fn(document.querySelector(selector)),
      evaluate: async (fn: Function) => fn(),
      waitForFunction: async (fn: Function, _options: unknown, previous: string) => { expect(previous).toBe(clicks === 1 ? '第一条正文' : 'second body'); expect(fn(previous)).toBe(true) },
    }
    const service: any = new ScreenshotService(browser(), translator({ translations: {}, untranslatedCount: 0, complete: true, cacheable: true }), config('unused'))
    try {
      expect(await service.advanceMajorOrder(page)).toBe(true)
      expect(await service.advanceMajorOrder(page)).toBe(false)
    } finally { document.body.innerHTML = '' }
  })

  it('continues when the next popup replaces the marked DOM node', async () => {
    document.body.innerHTML = '<section data-hd2-major-order-modal="true"><div class="content">第一条正文</div></section><div id="continue"><span>CONTINUE</span></div>'
    const control = document.querySelector<HTMLElement>('#continue')!
    const oldModal = document.querySelector('section')!
    const content = oldModal.querySelector('.content')!
    for (const node of [oldModal, control, content]) {
      Object.defineProperty(node, 'offsetWidth', { value: 400 })
      Object.defineProperty(node, 'offsetHeight', { value: 300 })
    }
    control.onclick = () => {
      const replacement = document.createElement('section')
      const nextContent = document.createElement('div')
      nextContent.className = 'content'
      nextContent.textContent = '第二条正文'
      replacement.append(document.createElement('img'), nextContent)
      vi.spyOn(replacement, 'getBoundingClientRect').mockReturnValue({ width: 400, height: 300 } as DOMRect)
      for (const node of [replacement, nextContent]) {
        Object.defineProperty(node, 'offsetWidth', { value: 400 })
        Object.defineProperty(node, 'offsetHeight', { value: 300 })
      }
      oldModal.replaceWith(replacement)
    }
    const page: any = {
      $eval: async (selector: string, fn: Function) => fn(document.querySelector(selector)),
      evaluate: async (fn: Function) => fn(),
      waitForFunction: async (fn: Function, _options: unknown, previous: string) => expect(fn(previous)).toBe(true),
    }
    const service: any = new ScreenshotService(browser(), translator({ translations: {}, untranslatedCount: 0, complete: true, cacheable: true }), config('unused'))
    try { expect(await service.advanceMajorOrder(page)).toBe(true) } finally { document.body.innerHTML = '' }
  })

  it('writes a complete screenshot and reuses the fresh file', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'koishi-screenshot-test-')); dirs.push(directory)
    const service = new ScreenshotService(browser(), translator({ translations: { 'English dispatch headline': '中文标题' }, untranslatedCount: 0, complete: true, cacheable: true }), config(directory))
    const first = await service.capture(target)
    expect(await readFile(first)).toEqual(Buffer.from('png-fixture'))
    expect(await service.capture(target)).toBe(first)
    expect(await readdir(directory)).toContain(first.split(/[\\/]/).pop()!)
  })

  it('keeps incomplete output temporary and retries on the next capture', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'koishi-screenshot-test-')); dirs.push(directory)
    const stub = translator({ translations: {}, untranslatedCount: 1, complete: false, cacheable: false })
    const service = new ScreenshotService(browser(), stub, config(directory))
    const partial = await service.capture(target)
    expect(partial).toMatch(/\.tmp\.png$/); expect(await stat(partial)).toBeTruthy(); expect(stub.translateCompanionFragments).toHaveBeenCalledTimes(1)
    await service.capture(target); expect(stub.translateCompanionFragments).toHaveBeenCalledTimes(2)
  })

  it('serves a recent stale screenshot when translation is incomplete', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'koishi-screenshot-test-')); dirs.push(directory)
    const service = new ScreenshotService(browser(), translator({ translations: {}, untranslatedCount: 0, complete: true, cacheable: true }), config(directory))
    const cached = await service.capture(target); const old = Date.now() - 301 * 1000; await utimes(cached, old / 1000, old / 1000)
    const incomplete = translator({ translations: {}, untranslatedCount: 1, complete: false, cacheable: false })
    expect(await new ScreenshotService(browser(), incomplete, config(directory)).capture(target)).toBe(cached)
    expect(incomplete.translateCompanionFragments).toHaveBeenCalledTimes(1)
  })

  it('does not use a stale screenshot older than two hours and still captures English', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'koishi-screenshot-test-')); dirs.push(directory)
    const service = new ScreenshotService(browser(), translator({ translations: {}, untranslatedCount: 0, complete: true, cacheable: true }), config(directory))
    const cached = await service.capture(target); const old = Date.now() - 7201 * 1000; await utimes(cached, old / 1000, old / 1000)
    const partial = await new ScreenshotService(browser(), translator({ translations: {}, untranslatedCount: 1, complete: false, cacheable: false }), config(directory)).capture(target)
    expect(partial).toMatch(/\.tmp\.png$/); expect(partial).not.toBe(cached); expect(await stat(cached)).toBeTruthy()
  })

  it('captures normally when translation is disabled', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'koishi-screenshot-test-')); dirs.push(directory)
    const stub = translator({ translations: {}, untranslatedCount: 0, complete: true, cacheable: true })
    const service = new ScreenshotService(browser(), stub, config(directory, { translationEnabled: false }))
    expect(await service.capture(target)).toMatch(/companion_home_.*\.png$/); expect(stub.translateCompanionFragments).toHaveBeenCalledTimes(1)
  })

  it('allows uppercase SVG planet and sector labels to be translated', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'koishi-screenshot-test-')); dirs.push(directory)
    const stub = translator({ translations: { 'FORI PRIME': '佛里主星', 'DRACO SECTOR': '天龙座分区' }, untranslatedCount: 0, complete: true, cacheable: true })
    const service = new ScreenshotService(browser(), stub, config(directory))
    expect(await service.capture({ ...target, kind: 'planet', url: 'https://companion.test/#hellpad/planets/fori' })).toMatch(/\.png$/)
    expect(stub.translateCompanionFragments).toHaveBeenCalled()
  })
})
describe('screenshot translation policy', () => {
  it('selects stale, cache, and partial dispositions', () => {
    expect(captureDisposition({ complete: true, cacheable: true }, false)).toBe('cache')
    expect(captureDisposition({ complete: false, cacheable: false }, true)).toBe('stale')
    expect(captureDisposition({ complete: false, cacheable: false }, false)).toBe('partial')
  })
})
describe('generic DOM phrase translation', () => {
  function domPage(html: string) {
    const root = document.createElement('div'); root.innerHTML = html; root.setAttribute('data-hd2-capture-root', 'true'); document.body.append(root)
    return { evaluate: async (fn: Function, ...args: unknown[]) => fn(...args) } as any
  }
  afterEach(() => { document.body.innerHTML = '' })
  it('translates a short title case-insensitively', async () => {
    await applyTranslations(domPage('<h2>eAgLe StOrM</h2>'), { 'EAGLE STORM': '飞鹰风暴' })
    expect(document.body.textContent).toContain('飞鹰风暴')
  })
  it('keeps span styling while applying a split fixed phrase', async () => {
    const page = domPage('<div><span class="text-hd-yellow">Defense Campaigns</span> cannot originate here.</div>')
    await applyTranslations(page, { 'Defense Campaigns cannot originate here.': '防御战役不会从这里发起。' })
    expect(document.querySelector('span')?.className).toBe('text-hd-yellow')
    expect(document.querySelector('span')?.textContent).toBe('防御战役')
    expect(document.querySelector('[data-hd2-capture-root]')?.textContent).toBe('防御战役不会从这里发起。')
  })
  it('translates the complete DSS description across multiple styled spans', async () => {
    const page = domPage('<div><span class="text-hd-yellow">Defense Campaigns</span> cannot originate from this planet. The <span class="text-hd-yellow"><b>Hellpod Space Optimization</b></span> Booster is automatically active for all missions.</div>')
    const spans = [...document.querySelectorAll('span')]
    await applyTranslations(page, {})
    expect(document.querySelector('[data-hd2-capture-root]')?.textContent).toBe('防御战役不会从该星球发起。所有任务都会自动启用地狱舱空间优化强化。')
    expect(document.querySelectorAll('span')[0]).toBe(spans[0])
    expect(document.querySelectorAll('span')[1]).toBe(spans[1])
    expect(document.querySelector('b')?.textContent).toBe('地狱舱空间优化')
  })
  it('keeps existing tags when model word order cannot map safely', async () => {
    const page = domPage('<div><span class="yellow">Defense Campaigns</span> and <em>Liberation Campaigns</em> are active.</div>')
    await applyTranslations(page, { 'Defense Campaigns and Liberation Campaigns are active.': '解放战役和防御战役已开始。' })
    expect(document.querySelector('span.yellow')?.textContent).toBe('防御战役')
    expect(document.querySelector('em')?.textContent).toBe('解放战役')
    expect(document.querySelector('[data-hd2-capture-root]')?.textContent).toContain('are active.')
  })
  it('matches a short phrase split across tags on other pages', async () => {
    await applyTranslations(domPage('<h3><span class="label">Planet</span> Statistics</h3>'), {})
    expect(document.querySelector('span.label')).not.toBeNull()
    expect(document.querySelector('span.label')?.textContent).toBe('星球')
    expect(document.querySelector('h3')?.textContent).toBe('星球统计')
  })
  it('handles actual DSS punctuation inside a highlighted term', async () => {
    const page = domPage('<div>Gives access to the <span class="yellow">Orbital 380mm HE Barrage</span> stratagem during missions. Accelerates progress in <span class="yellow">Liberation Campaigns.</span></div>')
    await applyTranslations(page, {})
    expect(document.querySelector('[data-hd2-capture-root]')?.textContent).toBe('任务期间可调用轨道380mm高爆弹火力网战略配备，同时加快解放战役进度。')
    expect(document.querySelectorAll('span.yellow')).toHaveLength(2)
  })
  it('extracts split short phrases on other pages with normalized whitespace', async () => {
    const page = domPage('<h3><span>pLaNeT</span>  \n STATISTICS</h3>')
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 100, height: 20 } as DOMRect)
    try {
      const texts = await extractTexts(page, target, ['planet statistics'])
      expect(texts[0]).toBe('pLaNeT STATISTICS')
    } finally { vi.restoreAllMocks() }
  })
  it('selects a short latest news card instead of the whole news page', async () => {
    const card = document.createElement('div')
    card.className = 'inline-block'
    card.textContent = `ALERT 10 HOURS AGO STRATEGIC ALERT ${'A'.repeat(100)}`
    document.body.append(card)
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(744)
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 744, height: 473, top: 154, right: 1012, bottom: 627, left: 268 } as DOMRect)
    try {
      await extractTexts({ evaluate: async (fn: Function, ...args: unknown[]) => fn(...args) } as any, { ...target, kind: 'news' }, [])
      expect(document.querySelector('[data-hd2-capture-root="true"]')).toBe(card)
    } finally { vi.restoreAllMocks() }
  })
  it('falls back to term-level replacement when full phrase is unavailable', async () => {
    await applyTranslations(domPage('<div>Defense Campaigns and Eagle Gas Strikes</div>'), {})
    expect(document.body.textContent).toContain('防御战役')
    expect(document.body.textContent).toContain('飞鹰毒气空袭')
  })
  it('uses a static full phrase when its wording differs from a nested term', async () => {
    const page = domPage('<div>deploys periodic <span class="yellow">Eagle Gas Strikes</span> during missions. slows enemy progress in <span class="yellow">defense campaigns</span>.</div>')
    await applyTranslations(page, {})
    expect(document.querySelector('[data-hd2-capture-root]')?.textContent).toBe('在任务中周期性部署飞鹰毒气空袭，减缓敌人在保卫战役中的进展。')
    expect(document.querySelectorAll('span.yellow')).toHaveLength(2)
    expect(document.querySelectorAll('span.yellow')[0].textContent).toBe('')
  })
  it('keeps the official API full-block translation when nested labels do not map cleanly', async () => {
    const page = domPage('<article><h2><span class="yellow">STRATEGIC ALERT</span></h2><p>The Automaton <span class="yellow">Incineration Corps</span> was reported on VINDEMITARIX PRIME.</p></article>')
    await applyTranslations(page, {
      'STRATEGIC ALERT The Automaton Incineration Corps was reported on VINDEMITARIX PRIME.': '战略警告 机器人炽灼部队已在文德米塔里克斯主星现身。',
    }, ['STRATEGIC ALERT The Automaton Incineration Corps was reported on VINDEMITARIX PRIME.'])
    expect(document.querySelector('article')?.textContent).toBe('战略警告 机器人炽灼部队已在文德米塔里克斯主星现身。')
    expect(document.querySelector('span.yellow')).not.toBeNull()
  })
  it('rebuilds official news highlights across nested spans and preserves card structure', async () => {
    const source = 'The Automaton Incineration Corps was reported on VINDEMITARIX PRIME.'
    const localized = '据报告，<i=1>文德米塔里克斯主星</i>上出现了机器人<i=1>炽灼部队</i>。'
    const page = domPage(`<article><h2><span>STRATEGIC ALERT</span></h2><p>The Automaton <span class="yellow">Incineration Corps</span> was reported on <span>VINDEMITARIX PRIME</span>.</p></article>`)
    const entries: Array<[string, string]> = [
      [`STRATEGIC ALERT\n\n${source}`, `<i=3>战略警告</i>\n\n${localized}`],
      ['STRATEGIC ALERT', '<i=3>战略警告</i>'],
      [source, localized],
    ]
    await applyOfficialBlocks(page, entries)
    await applyTranslations(page, { [source]: '据报告，文德米塔里克斯主星上出现了机器人炽灼部队。' }, [source])
    expect(document.querySelector('article > h2')?.textContent).toBe('战略警告')
    expect(document.querySelector('article > p')?.textContent).toBe('据报告，文德米塔里克斯主星上出现了机器人炽灼部队。')
    expect([...document.querySelectorAll('p .text-hd-yellow')].map(node => node.textContent)).toEqual(['文德米塔里克斯主星', '炽灼部队'])
    expect((document.querySelector('p .text-hd-yellow') as HTMLElement).style.color).toBe('#ffe900')
  })
  it('applies highlighting for the malformed bare i closing tag from Chinese news', async () => {
    const source = 'The government approved construction of the Malafon River Monument and Human Rights Interrogation Center.'
    const page = domPage(`<article><p>${source}</p></article>`)
    const count = await applyOfficialBlocks(page, [[source, '政府已批准建造<i=1>麦拉芬蒙河纪念碑与人权审讯中心<i>']])
    expect(count).toBe(1)
    expect(document.querySelector('p')?.textContent).toBe('政府已批准建造麦拉芬蒙河纪念碑与人权审讯中心')
    expect(document.querySelector('p .text-hd-yellow')?.textContent).toBe('麦拉芬蒙河纪念碑与人权审讯中心')
  })
  it('rebuilds the latest multi-paragraph news body before plain translation flattens its highlights', async () => {
    const source = 'The government approved the Memorial. However, enemy aggression threatens this project.\n\nThe Helldivers are ordered to liberate FURY, ESKER, and ZEA RUGOSIA.'
    const localized = '政府已批准建造<i=1>纪念中心</i>。然而，敌人的侵略正威胁着该项目。\n\n绝地潜兵奉命解放<i=1>费里、艾斯克尔和泽亚鲁戈西亚</i>。'
    const plain = '政府已批准建造纪念中心。然而，敌人的侵略正威胁着该项目。\n\n绝地潜兵奉命解放费里、艾斯克尔和泽亚鲁戈西亚。'
    const page = domPage('<article><h2>NEW MAJOR ORDER</h2><div class="hcml_container"><div class="body">The government approved the <span class="text-hd-yellow"><a>Memorial</a></span>. However, enemy aggression threatens this project.\n\nThe Helldivers are ordered to liberate <span class="text-hd-yellow"><a>FURY</a>, <a>ESKER</a>, and <a>ZEA RUGOSIA</a></span>.</div></div><footer>ID 3960</footer></article>')
    const entries: Array<[string, string]> = [[`NEW MAJOR ORDER\n\n${source}`, `<i=3>新重要指令</i>\n\n${localized}`], ['NEW MAJOR ORDER', '<i=3>新重要指令</i>'], [source, localized]]
    expect(await applyOfficialBlocks(page, entries)).toBe(2)
    // The production flow applies deterministic translations twice, around
    // fragment extraction/model translation. Neither pass may erase emphasis.
    for (let pass = 0; pass < 2; pass++) await applyTranslations(page, { [source]: plain }, [source])
    expect(document.querySelector('.body')?.textContent).toBe(plain)
    expect([...document.querySelectorAll('.body .text-hd-yellow')].map(node => node.textContent)).toEqual(['纪念中心', '费里、艾斯克尔和泽亚鲁戈西亚'])
    expect(document.querySelector('article > h2')?.textContent).toBe('新重要指令')
    expect(document.querySelector('article > footer')?.textContent).toBe('ID 3960')
  })
  it('preserves real paragraph elements when an official block spans multiple paragraphs', async () => {
    const page = domPage('<article><p>First paragraph</p><p>Second paragraph</p></article>')
    const paragraphs = [...document.querySelectorAll('p')]
    await applyOfficialBlocks(page, [['First paragraph\n\nSecond paragraph', '第一段\n\n第二段'], ['First paragraph', '<i=1>第一段</i>'], ['Second paragraph', '第二段']])
    expect([...document.querySelectorAll('p')]).toEqual(paragraphs)
    expect(paragraphs.map(node => node.textContent)).toEqual(['第一段', '第二段'])
    expect(paragraphs[0].querySelector('.text-hd-yellow')?.textContent).toBe('第一段')
  })
})
