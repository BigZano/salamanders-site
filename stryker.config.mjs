/** Mutation gate for the Legion Archive's security- and fidelity-critical units. */
export default {
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  vitest: { configFile: 'vitest.config.js' },
  mutate: [
    'src/lib/archive/crypto.js',
    'src/lib/archive/links.js',
    'src/lib/archive/markdown.js',
    'src/lib/archive/audit.js',
  'src/lib/archive/prune.js',
    'server/src/archiveKey.js',
    'src/lib/longPress.js',
    'server/src/displayNames.js',
    'server/src/rosterMember.js',
    'server/src/rosterCore.js',
    'server/src/roster.js',
    'server/src/rosterHandler.js',
  ],
  coverageAnalysis: 'perTest',
  thresholds: { high: 100, low: 100, break: 100 },
  reporters: ['clear-text', 'progress'],
  ignoreStatic: true,
}
