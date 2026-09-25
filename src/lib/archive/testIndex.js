/** Synthetic, content-free archive index for unit tests. Mirrors the real export's shape only. */
export const IDS = {
  GUILD: '1322056087792521269',
  A_TOC: '100000000000000001', A_TOC_M2: '100000000000000011', A_T2: '100000000000000002', A_T2_M: '100000000000000021',
  R_TOC: '200000000000000001', R_TOC_M: '200000000000000011',
  EXT_CHANNEL: '500000000000000001', DEAD_MSG: '100000000000000099',
  EMOJI: '300000000000000001', TAG_EMOJI: '300000000000000002', GIF_EMOJI: '300000000000000003',
  ROLE: '400000000000000001', USER: '600000000000000001', TAG: '700000000000000001',
  ATT_URL: 'https://cdn.discordapp.com/attachments/100000000000000001/800000000000000001/f.png?ex=1&is=2&hm=3&',
}
const G = IDS.GUILD
export const LINKS = {
  toRanks: `https://discordapp.com/channels/${G}/${IDS.R_TOC}/${IDS.R_TOC_M}`,
  toT2: `https://discord.com/channels/${G}/${IDS.A_T2}`,
  dead: `https://discord.com/channels/${G}/${IDS.A_T2}/${IDS.DEAD_MSG}`,
  backToAccolades: `https://discord.com/channels/${G}/${IDS.A_TOC}/${IDS.A_TOC_M2}`,
}
IDS.LINK_TO_RANKS = LINKS.toRanks

const thread = (id, name, applied_tags, messages) => ({ thread: { id, name, applied_tags }, messages })
const msg = (id, position, content, extra = {}) => ({ id, type: 0, position, content, attachments: [], ...extra })

export function makeIndex() {
  const aThreads = {
    [IDS.A_TOC]: thread(IDS.A_TOC, 'Fixture ToC', [IDS.TAG], [
      msg(IDS.A_TOC, 0, 'Click here', { attachments: [{ url: IDS.ATT_URL, filename: 'f.png' }] }),
      { id: '100000000000000005', type: 4, position: 0, content: 'renamed' },
      msg(IDS.A_TOC_M2, 1, `# Fixture ToC <:fx:${IDS.EMOJI}>\n> * [**Two**](${LINKS.toT2})\n> * [Ranks](${LINKS.toRanks})\n<@&${IDS.ROLE}> <@${IDS.USER}> <#${IDS.EXT_CHANNEL}>`),
    ]),
    [IDS.A_T2]: thread(IDS.A_T2, 'Fixture Two', [], [
      msg(IDS.A_T2, 0, `[Old](${LINKS.dead}) and https://example.com/wiki`),
      msg(IDS.A_T2_M, 1, '||spoiler|| ok'),
    ]),
  }
  const rThreads = {
    [IDS.R_TOC]: thread(IDS.R_TOC, 'Fixture Ranks', [], [msg(IDS.R_TOC, 0, 'Ranks'), msg(IDS.R_TOC_M, 1, `## Rank\n[Back](${LINKS.backToAccolades})`)]),
  }
  const cdn = (id, ext) => `https://cdn.discordapp.com/emojis/${id}.${ext}`
  const files = (threads, extra) => ({
    'forum.json': JSON.stringify({ available_tags: [{ id: IDS.TAG, name: 'Fixture Tag', emoji_id: IDS.TAG_EMOJI }] }),
    'index.json': JSON.stringify(Object.values(threads).map((t) => ({ id: t.thread.id, name: t.thread.name }))),
    'links.json': '[]',
    'resolve.json': JSON.stringify({
      emojis: { [IDS.EMOJI]: { name: 'fx', animated: false, file: 'emoji-fixture.png' } },
      roles: { [IDS.ROLE]: { name: 'Fixture Role', color: '#991115' } },
      users: { [IDS.USER]: { display_name: 'Fixture User' } },
      channels: { [IDS.EXT_CHANNEL]: { name: 'fixture-reports' } },
    }),
    'assets.json': JSON.stringify({
      [cdn(IDS.EMOJI, 'png')]: { file: 'emoji-fixture.png' },
      [cdn(IDS.TAG_EMOJI, 'png')]: { file: 'emoji-tag.png' },
      [cdn(IDS.GIF_EMOJI, 'gif')]: { file: 'emoji-anim.gif' },
      [cdn(IDS.GIF_EMOJI, 'png')]: { file: 'emoji-anim.png' },
      [IDS.ATT_URL]: { file: 'att-fixture.png' },
    }),
    ...Object.fromEntries(Object.entries(threads).map(([id, t]) => [`threads/${id}.json`, JSON.stringify(t)])),
    ...extra,
  })
  return {
    format: 1,
    kid: '0123456789abcdef',
    sealedAt: '2026-09-24T00:00:00.000Z',
    collections: {
      accolades: { tocThreadId: IDS.A_TOC, files: files(aThreads) },
      ranks: { tocThreadId: IDS.R_TOC, files: files(rThreads) },
    },
    fixes: {
      [`${IDS.A_T2}/${IDS.DEAD_MSG}`]: { to: `${IDS.A_T2}/${IDS.A_T2_M}`, why: 'replacement' },
      [IDS.EXT_CHANNEL]: { text: true, why: 'outside archive' },
    },
  }
}
