import { readFile } from 'node:fs/promises'
import { defaults } from './types'
import { CliBrowserProvider } from './browser'
import { ScreenshotService } from './screenshot'
import { Translator } from './translator'
import { targetFromArgs } from './targets'
import { OfficialApiClient, collectOfficialChinese, collectOfficialMajorOrders } from './official-api'
import { PlanetResolver } from './planet-resolver'

async function main() {
  const args = process.argv.slice(2)
  const command = args.shift()
  const kind = args.shift()
  const target = args.shift()
  const config = { ...defaults, ...(process.env.HD2_CONFIG ? JSON.parse(await readFile(process.env.HD2_CONFIG, 'utf8')) : {}) }
  if (command === 'fetch') {
    const api = new OfficialApiClient(config)
    if (kind === 'news') console.log(JSON.stringify(await api.fetchNews(), null, 2))
    else console.log(JSON.stringify(await api.fetchAll(), null, 2))
    return
  }
  if (command === 'screenshot') {
    const api = new OfficialApiClient(config)
    let official = new Map<string, string>()
    let officialData: Awaited<ReturnType<OfficialApiClient['fetchAll']>> | undefined
    try { officialData = await api.fetchAll(); official = collectOfficialChinese(officialData) } catch (error) { console.warn(`官方 API 获取失败，继续截图：${error instanceof Error ? error.message : String(error)}`) }
    const provider = new CliBrowserProvider(config)
    const translator = new Translator(config, official)
    try {
      const service = new ScreenshotService(provider, translator, config)
      const screenshotTarget = kind === 'planet'
        ? await new PlanetResolver(() => api.fetchPlanets(), config.planetCacheTtl, config.cacheDir, message => console.warn(message)).resolve(target || '')
        : targetFromArgs(kind || '', target || '')
      if (kind === 'mo') {
        if (!officialData) throw new Error('获取最高指令中英文官方数据失败，无法保证消息逐条匹配')
        const paths = await service.captureMajorOrders(screenshotTarget, collectOfficialMajorOrders(officialData), true)
        if (!paths.length) throw new Error('官方 API 暂无可截图的最高指令消息')
        paths.forEach((path, index) => console.log(`${index + 1}. ${path}`))
      } else {
        const result = await service.capture(screenshotTarget, true)
        console.log(result)
      }
    } finally { await provider.close(); await translator.close() }
    return
  }
  if (command === 'translate') {
    const text = [kind, target, ...args].filter(Boolean).join(' ')
    if (!text) throw new Error('用法：npm run hd2 -- translate <文本>')
    const translator = new Translator(config)
    try { console.log((await translator.translateMany([text]))[0]) } finally { await translator.close() }
    return
  }
  throw new Error('用法：screenshot <news|home|dss|planet|overview> [target] | fetch <all|news> | translate <text>')
}

main().catch(error => { console.error(`❌ ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1 })
