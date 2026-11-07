import { forge } from '../lib/forge'

/**
 * The playground's hands on the forge: the shared dev state, a snap that writes the live canvas (or any canvas) to
 * disk through the dev server, and the same for every same-origin iframe in the grid.
 */
export function useForge() {
  /** Write a canvas to .forge/snaps as a PNG; answers the file path the dev server wrote. */
  async function snap(name, canvas = forge?.actions.snapshot?.()) {
    if (!canvas) throw new Error('no canvas to snap')
    const res = await fetch('/__forge/snap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, dataUrl: canvas.toDataURL('image/png') }),
    })
    if (!res.ok) throw new Error(await res.text())
    return (await res.json()).file
  }

  /** The forge inside a same-origin iframe, once its volcano has mounted. */
  function forgeIn(iframe) {
    try {
      return iframe?.contentWindow?.__forge || null
    } catch {
      return null
    }
  }

  return { forge, snap, forgeIn }
}
