import { describe, it, expect } from 'vitest'
import source from './DeathwatchArea.vue?raw'

describe('the area sheet', () => {
  // dvh changes as a phone's address bar slides away, which would move the footer under a short page while scrolling.
  it('is at least a screen tall in svh, which stays steady while the address bar moves', () => {
    const style = source.slice(source.indexOf('<style'))
    const sheet = style.slice(style.indexOf('.dw-area-sheet {'), style.indexOf('}', style.indexOf('.dw-area-sheet {')))
    expect(sheet).toMatch(/min-height:\s*calc\(100svh - [\d.]+rem\)/)
  })
})
