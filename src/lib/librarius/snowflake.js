/**
 * Discord snowflakes as the Librarius pages use them: an id is a string, and its top 42 bits are the milliseconds since
 * the Discord epoch (2015-01-01T00:00:00.000Z), the low 22 bits being the worker, the process and a sequence number.
 * Ids are kept as strings everywhere and are worked on as BigInts here: one is wider than a Number can hold exactly.
 *
 * snowflakeAt(date) → the id a message sent at that instant would have with its low 22 bits clear, as a string. It is
 * the cursor for "the messages around this date". It is no more than 17 digits for the first month after the epoch,
 * and the Librarius routes take only ids of 17 digits or more.
 * timeOf(id) → the Date an id was made at.
 */
const EPOCH_MS = 1420070400000n
const TIME_SHIFT = 22n
// The time takes 42 bits, so the last instant an id can name is this many milliseconds after the epoch.
const MAX_OFFSET_MS = (1n << 42n) - 1n
// The widest id: 64 bits, 20 digits.
const MAX_ID = (1n << 64n) - 1n
const DIGITS = /^\d{1,20}$/

/** → the id with the time bits of `date` and the rest clear. A TypeError for what is no valid Date, a RangeError for a time the id cannot hold. */
export function snowflakeAt(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) throw new TypeError('snowflakeAt takes a valid Date.')
  const offset = BigInt(date.getTime()) - EPOCH_MS
  if (offset < 0n || offset > MAX_OFFSET_MS) throw new RangeError('That date is outside the years a snowflake can name.')
  return String(offset << TIME_SHIFT)
}

/** → the Date `id` was made at. A TypeError for what is no id (a string of 1 to 20 digits), a RangeError for one past 64 bits. */
export function timeOf(id) {
  if (typeof id !== 'string' || !DIGITS.test(id)) throw new TypeError('timeOf takes an id: a string of digits.')
  const value = BigInt(id)
  if (value > MAX_ID) throw new RangeError('That id is wider than 64 bits.')
  return new Date(Number((value >> TIME_SHIFT) + EPOCH_MS))
}
