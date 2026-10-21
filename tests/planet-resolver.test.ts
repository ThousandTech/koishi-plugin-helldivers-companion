import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PlanetResolver } from '../src/planet-resolver'

const directories: string[] = []
const planets = [{ index: 124, name: 'Bore Rock' }]

async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'hd2-planets-'))
  directories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('planet resolver cache', () => {
  it('persists successful planet data and reuses a fresh cache after restart', async () => {
    const directory = await temporaryDirectory()
    await new PlanetResolver(async () => planets, 60_000, directory).resolve('博尔岩')
    const offlineFetch = vi.fn(async () => { throw new Error('offline') })
    const target = await new PlanetResolver(offlineFetch, 60_000, directory).resolve('博尔岩')
    expect(target.key).toBe('bore_rock_(124)')
    expect(offlineFetch).not.toHaveBeenCalled()
    expect(JSON.parse(await readFile(join(directory, 'planets.json'), 'utf8')).planets).toEqual(planets)
  })

  it('uses stale disk data when an online refresh fails', async () => {
    const directory = await temporaryDirectory()
    await new PlanetResolver(async () => planets, 60_000, directory).resolve('博尔岩')
    const warnings: string[] = []
    const target = await new PlanetResolver(async () => { throw new Error('timeout') }, 0, directory, message => warnings.push(message)).resolve('博尔岩')
    expect(target.key).toBe('bore_rock_(124)')
    expect(warnings.join('\n')).toContain('使用缓存')
  })
})
