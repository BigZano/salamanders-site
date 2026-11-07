/**
 * The lava shader's layer: whether to use it, and (in a later task) how it draws.
 *
 * This file starts with the capability check only. It is plain functions over a
 * `win` argument so it can be tested without a browser.
 */

/**
 * Whether the page was told to force the shader on or off.
 *
 * `?lava=0` forces the ribbons, `?lava=1` forces the shader on when the browser
 * has WebGL2, and anything else leaves the choice to the capability check
 * ('auto'). With no `search` given it reads the current page's query string, so
 * the volcano can call it bare. Outside a browser there is no query string, and
 * the answer is 'auto'.
 */
export function supportsLavaShader({ search, win = typeof window === 'undefined' ? undefined : window } = {}) {
  const query = search ?? win?.location?.search ?? ''
  const flag = new URLSearchParams(query).get('lava')
  if (flag === '0') return 'off'
  if (flag === '1') return 'on'
  return 'auto'
}

/**
 * Whether a WebGL2 context can really be made here.
 *
 * Checking for the constructor is not enough: a browser can expose it and still
 * refuse a context (a blocklisted GPU, or hardware acceleration switched off),
 * so a throwaway canvas is asked for one. The probe context is released at once,
 * because browsers cap how many live contexts a page may hold and the real layer
 * needs its own.
 */
export function hasWebGL2(win) {
  if (!win || !('WebGL2RenderingContext' in win)) return false
  try {
    const gl = win.document.createElement('canvas').getContext('webgl2')
    if (!gl) return false
    gl.getExtension?.('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    // Some browsers throw rather than return null when a context is refused.
    return false
  }
}
