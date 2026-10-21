import type { ScreenshotTarget } from './types'
import { planetTarget, resolvePlanetTarget } from './targets'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

type Planet = Record<string, unknown>
interface PlanetCacheFile { version: 1; updatedAt: number; planets: Planet[] }

export class PlanetResolver {
  private planets: Planet[] = []
  private cachedAt = 0
  private pending?: Promise<Planet[]>
  private ready: Promise<void>
  private cachePath: string

  constructor(private fetchPlanets: () => Promise<Planet[]>, private ttl: number, cacheDir: string, private warn: (message: string) => void = () => {}) {
    this.cachePath = join(cacheDir, 'planets.json')
    this.ready = this.loadCache()
  }

  private async loadCache() {
    try {
      const payload: unknown = JSON.parse(await readFile(this.cachePath, 'utf8'))
      if (!payload || typeof payload !== 'object') throw new Error('根节点不是对象')
      const cache = payload as Partial<PlanetCacheFile>
      if (cache.version !== 1 || !Number.isFinite(cache.updatedAt) || !Array.isArray(cache.planets) || !cache.planets.length) throw new Error('结构无效')
      const planets = cache.planets.filter((planet): planet is Planet => !!planet && typeof planet === 'object' && !Array.isArray(planet))
      if (!planets.length) throw new Error('星球列表为空')
      this.planets = planets
      this.cachedAt = Number(cache.updatedAt)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warn(`HD2 星球缓存读取失败，将在线刷新：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private async saveCache() {
    const payload: PlanetCacheFile = { version: 1, updatedAt: this.cachedAt, planets: this.planets }
    await mkdir(dirname(this.cachePath), { recursive: true })
    const temporary = `${this.cachePath}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify(payload), 'utf8')
    await rename(temporary, this.cachePath)
  }

  async resolve(input = ''): Promise<ScreenshotTarget> {
    if (!input.trim()) throw new Error('请提供星球名称、编号、slug 或 Companion 链接')
    // Validate links before requesting data; indexed routes remain usable offline.
    if (/[:/#]/.test(input) || /_\(\d{1,6}\)$/i.test(input.trim())) {
      const direct = planetTarget(input)
      if (/_\(\d{1,6}\)$/.test(direct.key)) return direct
    }
    await this.ready
    if (!this.pending && (!this.planets.length || Date.now() - this.cachedAt >= this.ttl)) {
      this.pending = this.fetchPlanets().then(async planets => {
        if (!planets.length) throw new Error('星球 API 返回空列表')
        this.planets = planets
        this.cachedAt = Date.now()
        try { await this.saveCache() } catch (error) { this.warn(`HD2 星球缓存写入失败：${error instanceof Error ? error.message : String(error)}`) }
        return planets
      }).finally(() => { this.pending = undefined })
    }
    if (this.pending) {
      try { await this.pending } catch (error) {
        if (!this.planets.length) {
          try { return resolvePlanetTarget(input, []) } catch {
            throw new Error(`暂时无法获取星球数据：${error instanceof Error ? error.message : String(error)}`)
          }
        }
        this.warn(`HD2 星球列表刷新失败，使用缓存：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return resolvePlanetTarget(input, this.planets)
  }
}
