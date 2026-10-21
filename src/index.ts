import { h, Schema, type Context } from 'koishi'
import { join, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import type { PageKind, PluginConfig } from './types'
import { defaults } from './types'
import { KoishiBrowserProvider } from './browser'
import { ScreenshotService } from './screenshot'
import { Translator } from './translator'
import { getTarget } from './targets'
import { PlanetResolver } from './planet-resolver'
import { OfficialApiClient, collectOfficialChinese, collectOfficialMajorOrders, type OfficialTextKind } from './official-api'
import { SubscriptionStore, SubscriptionPoller, majorOrderFingerprint } from './subscription'

export const name = 'helldivers-companion'
export const inject = ['puppeteer']

export const Config = Schema.intersect([
  Schema.object({
    planetApiBase: Schema.string().description('星球查询社区 API 地址').default(defaults.planetApiBase),
    planetApiClient: Schema.string().description('社区 API 客户端标识，用于接口署名').default(defaults.planetApiClient),
    planetApiContact: Schema.string().description('社区 API 联系方式，建议填写可联系的邮箱').default(defaults.planetApiContact),
    planetApiTimeout: Schema.natural().description('星球 API 请求超时时间（毫秒）').default(defaults.planetApiTimeout),
    planetCacheTtl: Schema.natural().description('星球列表缓存有效期（毫秒，默认 6 小时）').default(defaults.planetCacheTtl),
  }),
  Schema.object({
    enabled: Schema.boolean().description('插件总开关，关闭后不注册指令和订阅轮询').default(defaults.enabled),
    apiBase: Schema.string().description('官方新闻 / 重要指令 / 战争状态 API 地址').default(defaults.apiBase),
    warId: Schema.number().description('官方 API 使用的战争编号').default(defaults.warId),
    apiTimeout: Schema.natural().description('官方 API 请求超时时间（毫秒）').default(defaults.apiTimeout),
    executablePath: Schema.string().description('独立 CLI 浏览器路径；Koishi 运行时由 Puppeteer 服务管理').default(defaults.executablePath),
  }),
  Schema.object({
    cacheDir: Schema.string().description('缓存目录，相对于 Koishi 根目录').default(defaults.cacheDir),
    screenshotCacheTtl: Schema.natural().description('截图缓存有效期（秒，默认 5 分钟）').default(defaults.screenshotCacheTtl),
    screenshotWaitMs: Schema.natural().description('页面截图前额外等待时间（毫秒，最多 5 秒）').default(defaults.screenshotWaitMs),
    pageLoadTimeout: Schema.natural().description('页面加载与就绪检查超时（毫秒）').default(defaults.pageLoadTimeout),
  }),
  Schema.object({
    translationEnabled: Schema.boolean().description('启用外部翻译补齐英文内容，关闭后仅使用官方中文、静态短语、术语和已有译文缓存').default(defaults.translationEnabled),
    translationMode: Schema.union(['auto', 'builtin', 'openai']).description('翻译协议：auto 自动识别，openai 使用 Chat Completions 兼容协议，builtin 使用普通翻译接口协议').default(defaults.translationMode),
    translationApiUrl: Schema.string().description('翻译接口地址').default(defaults.translationApiUrl),
    translationApiKey: Schema.string().role('secret').description('翻译接口密钥，以 Authorization: Bearer 方式发送').default(defaults.translationApiKey),
    translationModel: Schema.string().description('OpenAI 兼容协议使用的模型名称').default(defaults.translationModel),
    translationTimeout: Schema.natural().description('单次翻译请求超时时间（毫秒）').default(defaults.translationTimeout),
    translationTargetLang: Schema.string().description('翻译目标语言，官方文本固定请求简体中文').default(defaults.translationTargetLang),
    translationMaxTokens: Schema.natural().description('OpenAI 兼容接口输出上限，0 表示不发送该参数').default(defaults.translationMaxTokens),
    translationBatchTimeout: Schema.natural().description('单批翻译的前台等待时间（毫秒）').default(defaults.translationBatchTimeout),
    translationBudget: Schema.natural().description('本轮翻译前台总等待预算（毫秒），超时后转后台继续').default(defaults.translationBudget),
    translationErrorCooldown: Schema.natural().description('翻译接口异常后的冷却时间（毫秒）').default(defaults.translationErrorCooldown),
    translationFallbackTtl: Schema.natural().description('旧版失败 / 回退译文记录的有效期（毫秒）').default(defaults.translationFallbackTtl),
  }),
  Schema.object({
    subscriptionEnabled: Schema.boolean().description('自动订阅推送总开关，关闭时不推送').default(defaults.subscriptionEnabled),
    subscriptionIntervalSeconds: Schema.natural().description('订阅轮询间隔（秒，最低 60 秒）').default(defaults.subscriptionIntervalSeconds),
    subscriptionNewsChannels: Schema.array(String).description('新闻推送频道列表，格式为 平台:频道ID，如 onebot:123456；留空表示不订阅').default(defaults.subscriptionNewsChannels),
    subscriptionMoChannels: Schema.array(String).description('MO（最高指令）推送频道列表，格式为 平台:频道ID；留空表示不订阅').default(defaults.subscriptionMoChannels),
  }),
])

export function apply(ctx: Context, raw: Partial<PluginConfig>) {
  const config = { ...defaults, ...raw, cacheDir: resolve(ctx.baseDir, raw.cacheDir ?? defaults.cacheDir) } as PluginConfig
  if (!config.enabled) return
  const official = new OfficialApiClient(config)
  const subscriptions = new SubscriptionStore(join(config.cacheDir, 'subscriptions.json'))
  const translator = new Translator(config)
  ctx.on('dispose', () => translator.close())
  const screenshots = new ScreenshotService(new KoishiBrowserProvider(ctx), translator, config)
  // Official locale data is opportunistic; screenshot capture remains available if this endpoint is offline.
  // News screenshots must not race the initial locale fetch: otherwise the
  // first command can send English fragments to the model before the
  // authoritative API Chinese has been installed.
  const officialReady = official.fetchAll().then(data => translator.setOfficial(collectOfficialChinese(data))).catch(error => {
    ctx.logger.warn(`HD2 官方中文文本预取失败：${error instanceof Error ? error.message : String(error)}`)
  })
  const refreshOfficial = async (kind: OfficialTextKind, localized?: unknown) => {
    const data = await official.fetchText(kind, localized)
    translator.mergeOfficial(collectOfficialChinese(data))
    return data
  }
  const commandWithReceipt = (definition: string) => ctx.command(definition).before(async ({ session }) => {
    if (!session) return
    try {
      await session.send('正在接收合法广播，请稍候...')
    } catch (error) {
      ctx.logger.warn(`HD2 指令回执发送失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  const send = async (session: any, kind: Exclude<PageKind, 'planet'>, force = false) => {
    await officialReady
    if (kind === 'mo') {
      const current = await refreshOfficial('mo')
      const orders = collectOfficialMajorOrders(current)
      const paths = await screenshots.captureMajorOrders(getTarget('mo'), orders, force)
      if (!paths.length) throw new Error('官方 API 暂无可截图的最高指令消息')
      return Promise.all(paths.map(async path => h.image(await readFile(path), 'image/png')))
    }
    const refreshKind = kind === 'news' || kind === 'overview' ? kind : undefined
    const path = await screenshots.capture(getTarget(kind), force, refreshKind ? async () => {
      try { await refreshOfficial(refreshKind) } catch (error) {
        ctx.logger.warn(`HD2 ${kind} 官方中文刷新失败，继续使用现有文本：${error instanceof Error ? error.message : String(error)}`)
      }
    } : undefined)
    return [h.image(await readFile(path), 'image/png')]
  }
  for (const [command, kind] of [['hd2.news', 'news'], ['hd2.home', 'home'], ['hd2.dss', 'dss'], ['hd2.overview', 'overview'], ['hd2.mo', 'mo']] as const) {
    commandWithReceipt(command).action(async ({ session }) => {
      try { return await send(session, kind) } catch (error) { return `❌ ${error instanceof Error ? error.message : String(error)}` }
    })
  }
  const planets = new PlanetResolver(() => official.fetchPlanets(), config.planetCacheTtl, config.cacheDir, message => ctx.logger.warn(message))
  commandWithReceipt('hd2.planet <target:text>').action(async ({ session }, target) => {
    try {
      await officialReady
      const path = await screenshots.capture(await planets.resolve(target))
      return [h.image(await readFile(path), 'image/png')]
    } catch (error) { return `❌ ${error instanceof Error ? error.message : String(error)}` }
  })
  commandWithReceipt('hd2.test <kind:string> [target:text]').action(async ({ session }, kind, target) => {
    try {
      await officialReady
      if (kind === 'planet') {
        const path = await screenshots.capture(await planets.resolve(target || ''), true)
        return [h.image(await readFile(path), 'image/png')]
      }
      return await send(session, kind as Exclude<PageKind, 'planet'>, true)
    } catch (error) { return `❌ ${error instanceof Error ? error.message : String(error)}` }
  })
  if (config.subscriptionEnabled) {
    const channels = { news: config.subscriptionNewsChannels, mo: config.subscriptionMoChannels }
    const poller = new SubscriptionPoller(subscriptions, channels)
    const broadcast = async (channels: string[], content: ReturnType<typeof h.image>[]) => {
      for (const channel of channels) {
        // Koishi swallows adapter send errors and returns no message IDs.
        const ids = await ctx.broadcast([channel], content)
        if (!ids.length) throw new Error(`频道 ${channel} 未返回消息 ID，保留更新等待重试`)
      }
    }
    ctx.setInterval(async () => {
      await officialReady
      const kinds = (['news', 'mo'] as const).filter(kind => channels[kind].length)
      await Promise.all(kinds.map(async kind => {
        try {
          await poller.poll(kind, async () => {
            if (kind === 'mo') {
              const data = await refreshOfficial('mo')
              const orders = collectOfficialMajorOrders(data)
              // Do not mistake an unmatched bilingual response for an empty queue.
              const status = data.status as { globalEvents?: unknown } | null
              const source = data.source?.status as { globalEvents?: unknown } | null
              if (!Array.isArray(status?.globalEvents) || !Array.isArray(source?.globalEvents)) throw new Error('MO API 未返回有效消息列表')
              const hasText = (event: any) => typeof event?.title === 'string' && event.title.trim() && typeof event?.message === 'string' && event.message.trim()
              if (source.globalEvents.filter(hasText).length !== orders.length || status.globalEvents.filter(hasText).length !== orders.length) throw new Error('MO 中英文消息未完整匹配，等待下次重试')
              return {
                fingerprint: majorOrderFingerprint(orders), empty: !orders.length,
                send: async channels => {
                  const paths = await screenshots.captureMajorOrders(getTarget('mo'), orders, true)
                  if (!paths.length) throw new Error('暂无可推送的最高指令截图')
                  await broadcast(channels, await Promise.all(paths.map(async path => h.image(await readFile(path), 'image/png'))))
                },
              }
            }
            const news = await official.fetchNews()
            return {
              fingerprint: createHash('sha1').update(JSON.stringify(news)).digest('hex'),
              send: async channels => {
                const path = await screenshots.capture(getTarget('news'), true, async () => {
                  try { await refreshOfficial('news', news) } catch (error) {
                    ctx.logger.warn(`HD2 news 官方中文刷新失败，继续使用现有文本：${error instanceof Error ? error.message : String(error)}`)
                  }
                })
                await broadcast(channels, [h.image(await readFile(path), 'image/png')])
              },
            }
          })
        } catch (error) {
          ctx.logger.warn(`HD2 ${kind === 'mo' ? 'MO' : '新闻'}订阅轮询失败：${error instanceof Error ? error.message : String(error)}`)
        }
      }))
    }, Math.max(60, config.subscriptionIntervalSeconds) * 1000)
  }
}

export default { name, inject, Config, apply }
