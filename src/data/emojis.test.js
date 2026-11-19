/**
 * The standard emoji the Librarius picker offers (copied from the Req_bot dashboard). The repo is public, so this list
 * must be Unicode's own and nothing of any server's: a guild's custom emoji come from /librarius/emoji at run time, never
 * from here.
 */
import { describe, it, expect } from 'vitest'
import emojis from './emojis.json'

const GROUPS = ['Smileys & Emotion', 'People & Body', 'Animals & Nature', 'Food & Drink', 'Activities', 'Travel & Places', 'Objects', 'Symbols', 'Flags']
// One emoji as Unicode writes it: a flag (two regional indicators), a keycap, or a pictograph with its variation selector,
// skin tone and joined pictographs. No letters, no digits on their own, nothing in angle brackets or colons.
const PICTOGRAPH = '\\p{Extended_Pictographic}\\uFE0F?(?:\\p{Emoji_Modifier})?'
const EMOJI = new RegExp(`^(?:\\p{Regional_Indicator}{2}|[#*0-9]\\uFE0F?\\u20E3|${PICTOGRAPH}(?:\\u200D${PICTOGRAPH})*)$`, 'u')

describe('emojis.json', () => {
  it('is the list of 362 standard emoji, each as { emoji, name, group } and nothing more', () => {
    expect(Array.isArray(emojis)).toBe(true)
    expect(emojis).toHaveLength(362)
    for (const e of emojis) expect(Object.keys(e).sort()).toEqual(['emoji', 'group', 'name'])
  })

  it('holds only Unicode emoji: no custom emoji of any server, no ids, no text', () => {
    for (const { emoji } of emojis) {
      expect(emoji, emoji).toMatch(EMOJI)
      expect(emoji).not.toMatch(/[<>:]|\d{2,}|[A-Za-z]/)
    }
  })

  it('names each emoji by its Unicode short name, once, in the Unicode groups', () => {
    for (const { name, group } of emojis) {
      expect(name).toMatch(/^[a-z0-9][a-z0-9 :&'’.,!()-]*$/)
      expect(GROUPS).toContain(group)
    }
    expect(new Set(emojis.map((e) => e.emoji)).size).toBe(emojis.length)
    expect(new Set(emojis.map((e) => e.name)).size).toBe(emojis.length)
    expect([...new Set(emojis.map((e) => e.group))]).toEqual(GROUPS)
  })
})
