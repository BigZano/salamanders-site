/**
 * The `behavior` for a scroll the page starts itself. CSS can't switch off a
 * smooth scroll that script asks for by name, so the page asks here: visitors
 * who prefer reduced motion get an immediate jump, everyone else a glide.
 */
export function scrollBehavior() {
  return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}
