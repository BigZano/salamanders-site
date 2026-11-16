/**
 * Where the reader was in each Librarius post, kept for this tab only (sessionStorage), so that Back puts them there again
 * (see PostPage.vue). One key to a post, every key beginning with the same prefix, so that the last of them can go together.
 */
const PREFIX = 'lb-anchor:'

/** The key the place in a post is kept under. */
export const placeKey = (postId) => `${PREFIX}${postId}`

/**
 * Forgets the place kept for every post: it is the last reader's reading, and goes when they sign out. A browser that will not
 * say what it keeps (storage blocked) has nothing to forget, and this never throws.
 */
export function forgetPlaces() {
  try {
    // From the end, so that taking a key out never moves one still to come.
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i)
      if (key.startsWith(PREFIX)) sessionStorage.removeItem(key)
    }
  } catch {
    // Nothing readable, nothing to forget.
  }
}
