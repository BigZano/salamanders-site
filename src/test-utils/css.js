// Helpers for tests that read a stylesheet (or a component's <style> block) as text.

/** The exact opening of the media query that gates every hover rule. */
export const HOVER_MEDIA = '@media (hover: hover) and (pointer: fine) {'

/** `source` with every hover-media block cut out (brace-matched), to see what is left outside it. */
export const withoutHoverMedia = (source) => {
  let out = source
  for (let at = out.indexOf(HOVER_MEDIA); at !== -1; at = out.indexOf(HOVER_MEDIA)) {
    let depth = 0
    let end = at + HOVER_MEDIA.length - 1
    for (let i = end; i < out.length; i++) {
      if (out[i] === '{') depth++
      else if (out[i] === '}' && --depth === 0) {
        end = i
        break
      }
    }
    out = out.slice(0, at) + out.slice(end + 1)
  }
  return out
}
