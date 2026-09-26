/**
 * Pre-filled link to High Command's official "Chaplain & Officer Incident
 * Report" Google Form. Escalation (and the "involves a Reclusiarch" bypass)
 * opens this for a human to review and submit; nothing is sent automatically.
 * Entry ids were read from the live form on 2026-09-26. If the form's owner
 * edits a question, its id can change and that field silently stops filling.
 */
export const OFFICIAL_FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSc4rPGAEGTXJVgP5yaZZRmAg9_bW0A9OalB3rcahX4ufMkizA/viewform'

const ENTRY = {
  filer: 'entry.1585179301',
  date: 'entry.1660417014',
  reportedMember: 'entry.1659452298',
  witnesses: 'entry.2116649071',
  medium: 'entry.829462579',
  followUp: 'entry.1492368838',
  description: 'entry.1441063800',
}

export const MEDIUM_LABELS = {
  text: 'Discord Text Channel',
  voice: 'Discord Voice Channel',
  dm: 'Discord Direct Message',
}

/**
 * @param {object} r report-shaped fields (reportedMember, witnesses, medium,
 *   mediumOther, incidentDate, description, reporter?)
 * @param {{filer: string, followUp?: 'Yes'|'No', note?: string}} opts
 */
export function prefillUrl(r, { filer, followUp, note } = {}) {
  const p = new URLSearchParams({ usp: 'pp_url' })
  const set = (k, v) => v && p.set(ENTRY[k], v)
  set('filer', filer)
  set('date', r.incidentDate)
  set('reportedMember', r.reportedMember)
  set('witnesses', r.witnesses)
  if (MEDIUM_LABELS[r.medium]) set('medium', MEDIUM_LABELS[r.medium])
  else if (r.medium === 'other') {
    p.set(ENTRY.medium, '__other_option__')
    if (r.mediumOther) p.set(`${ENTRY.medium}.other_option_response`, r.mediumOther)
  }
  set('followUp', followUp)
  const parts = [r.description]
  if (r.reporter?.username && r.reporter.username !== filer) parts.push(`Reported by: ${r.reporter.username}`)
  if (note) parts.push(`Reclusiarch notes: ${note}`)
  set('description', parts.filter(Boolean).join('\n\n'))
  return `${OFFICIAL_FORM}?${p}`
}
