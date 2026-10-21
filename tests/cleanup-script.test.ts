import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('Companion toast cleanup', () => {
  it('targets the close button before capture', () => {
    const source = readFileSync(resolve(__dirname, '../src/screenshot.ts'), 'utf8')
    expect(source).toContain('.toastLeft .close')
    expect(source).toContain('.toastRight .close')
    expect(source).toContain('close.click()')
  })

  it('hides the Companion changelog toast card', () => {
    const source = readFileSync(resolve(__dirname, '../src/screenshot.ts'), 'utf8')
    expect(source).toContain('A NEW CHANGELOG has been posted to Companion Dispatch')
    expect(source).toContain("node.closest('.toastLeft, .toastRight')")
    expect(source).toContain(`toast?.closest('[class~="outer"]')`)
  })

  it('identifies the high command card by image and content without including the continue sibling', () => {
    const source = readFileSync(resolve(__dirname, '../src/screenshot.ts'), 'utf8')
    expect(source).toContain("querySelectorAll<HTMLElement>('.content')")
    expect(source).toContain("node.querySelector('img')")
    expect(source).toContain('CONTINUE button is outside this subtree')
  })
})
