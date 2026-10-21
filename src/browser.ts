import puppeteer, { type Browser } from 'puppeteer-core'
import finder from 'puppeteer-finder'
import type { Context } from 'koishi'
import type { BrowserProvider, PluginConfig } from './types'

export class KoishiBrowserProvider implements BrowserProvider {
  constructor(private ctx: Context) {}
  async createPage() {
    const puppeteerService = (this.ctx as Context & { puppeteer?: { page(): Promise<import('puppeteer-core').Page> } }).puppeteer
    if (!puppeteerService?.page) throw new Error('Koishi Puppeteer 服务未启用，请安装并启用 koishi-plugin-puppeteer')
    return puppeteerService.page()
  }
}

export class CliBrowserProvider implements BrowserProvider {
  private browser?: Browser
  constructor(private config: PluginConfig) {}

  async start() {
    if (this.browser?.connected) return
    const executablePath = this.config.executablePath || finder()
    if (!executablePath) throw new Error('未找到 Chrome/Chromium。请安装 Chrome，或在配置中设置 executablePath。')
    try {
      this.browser = await puppeteer.launch({ executablePath, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
    } catch (error) {
      throw new Error(`Chrome/Chromium 启动失败（${executablePath}）：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async createPage() {
    await this.start()
    return this.browser!.newPage()
  }

  async close() {
    await this.browser?.close()
    this.browser = undefined
  }
}
