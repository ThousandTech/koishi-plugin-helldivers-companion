import type { Page } from 'puppeteer-core'

export interface BrowserProvider {
  createPage(): Promise<Page>
}

export type PageKind = 'news' | 'home' | 'dss' | 'planet' | 'overview' | 'mo'

export interface ScreenshotTarget {
  kind: PageKind
  key: string
  url: string
  label: string
  viewport: { width: number; height: number }
  clip?: { x: number; y: number; width: number; height: number }
}

export interface PluginConfig {
  enabled: boolean
  apiBase: string
  planetApiBase: string
  planetApiClient: string
  planetApiContact: string
  planetCacheTtl: number
  planetApiTimeout: number
  warId: number
  apiTimeout: number
  executablePath: string
  cacheDir: string
  screenshotCacheTtl: number
  screenshotWaitMs: number
  pageLoadTimeout: number
  translationEnabled: boolean
  translationMode: 'auto' | 'builtin' | 'openai'
  translationApiUrl: string
  translationApiKey: string
  translationModel: string
  translationTimeout: number
  translationTargetLang: string
  translationMaxTokens: number
  translationBatchTimeout: number
  translationBudget: number
  translationErrorCooldown: number
  translationFallbackTtl: number
  subscriptionEnabled: boolean
  subscriptionIntervalSeconds: number
  subscriptionNewsChannels: string[]
  subscriptionMoChannels: string[]
}

export const defaults: PluginConfig = {
  enabled: true,
  apiBase: 'https://api.live.prod.thehelldiversgame.com',
  planetApiBase: 'https://api.helldivers2.dev',
  planetApiClient: 'koishi_plugin_Helldivers',
  planetApiContact: 'noreply@example.com',
  planetCacheTtl: 21600000,
  planetApiTimeout: 10000,
  warId: 801,
  apiTimeout: 20000,
  executablePath: '',
  cacheDir: 'data/helldivers-companion',
  screenshotCacheTtl: 300,
  screenshotWaitMs: 20000,
  pageLoadTimeout: 120000,
  translationEnabled: true,
  translationMode: 'auto',
  translationApiUrl: 'https://api.deepseek.com/v1',
  translationApiKey: '',
  translationModel: 'deepseek-chat',
  translationTimeout: 60000,
  translationTargetLang: 'zh-CN',
  translationMaxTokens: 1200,
  translationBatchTimeout: 20000,
  translationBudget: 60000,
  translationErrorCooldown: 120000,
  translationFallbackTtl: 180000,
  subscriptionEnabled: false,
  subscriptionIntervalSeconds: 300,
  subscriptionNewsChannels: [],
  subscriptionMoChannels: [],
}
