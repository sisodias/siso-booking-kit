const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

const formatterCache = new Map()

function formatterFor(timezone) {
  if (!formatterCache.has(timezone)) {
    formatterCache.set(
      timezone,
      new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        calendar: 'iso8601',
        numberingSystem: 'latn',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
      }),
    )
  }
  return formatterCache.get(timezone)
}

function partsFromFormatter(date, timezone) {
  const parts = Object.fromEntries(
    formatterFor(timezone)
      .formatToParts(date)
      .filter(({ type }) => type !== 'literal')
      .map(({ type, value }) => [type, Number(value)]),
  )
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  }
}

function dateParts(date) {
  const [year, month, day] = String(date).split('-').map(Number)
  return { year, month, day }
}

function utcDayNumber(date) {
  const { year, month, day } = dateParts(date)
  return Date.UTC(year, month - 1, day) / 86400000
}

function assertDate(value) {
  if (!DATE_RE.test(String(value))) throw new Error('Invalid local date')
  const { year, month, day } = dateParts(value)
  const check = new Date(Date.UTC(year, month - 1, day))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    throw new Error('Invalid local date')
  }
  return value
}

export function parseClock(value) {
  if (!TIME_RE.test(String(value))) throw new Error('Invalid local time')
  const [hour, minute] = String(value).split(':').map(Number)
  return hour * 60 + minute
}

export function clockString(totalMinutes) {
  const minutes = Number(totalMinutes)
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 24 * 60) throw new Error('Invalid clock minutes')
  const hour = Math.floor(minutes / 60)
  const minute = minutes % 60
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
}

export function localWeekday(localDate) {
  const { year, month, day } = dateParts(assertDate(localDate))
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay()
}

export function addLocalDays(localDate, amount) {
  const { year, month, day } = dateParts(assertDate(localDate))
  const date = new Date(Date.UTC(year, month - 1, day + Number(amount)))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

export function localDateFromUtc(date, timezone) {
  const parts = partsFromFormatter(new Date(date), timezone)
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

export function localPartsFromUtc(date, timezone) {
  return partsFromFormatter(new Date(date), timezone)
}

/*
 * Convert a wall-clock time in an IANA timezone to UTC without a dependency on
 * a server-side timezone database. Intl is available in Node and Workers. The
 * small fixed-point loop corrects for the timezone offset and then verifies
 * that the requested wall time exists (DST gaps are rejected).
 */
export function localDateTimeToUtc(localDate, localTime, timezone) {
  assertDate(localDate)
  const totalMinutes = parseClock(localTime)
  const { year, month, day } = dateParts(localDate)
  const desired = Date.UTC(year, month - 1, day, Math.floor(totalMinutes / 60), totalMinutes % 60, 0)
  let guess = desired

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const parts = partsFromFormatter(new Date(guess), timezone)
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    const correction = desired - represented
    if (correction === 0) break
    guess += correction
  }

  const actual = partsFromFormatter(new Date(guess), timezone)
  if (
    actual.year !== year ||
    actual.month !== month ||
    actual.day !== day ||
    actual.hour !== Math.floor(totalMinutes / 60) ||
    actual.minute !== totalMinutes % 60
  ) {
    return null
  }
  return new Date(guess)
}

function compareIso(a, b) {
  return new Date(a).getTime() - new Date(b).getTime()
}

function activeBooking(booking, now) {
  if (!booking || ['cancelled', 'expired', 'rejected', 'no_show', 'rescheduled'].includes(booking.status)) return false
  if (booking.expiresAt && compareIso(booking.expiresAt, now) <= 0) return false
  return true
}

function overlaps(candidate, booking) {
  const start = booking.blockedStartsAt || booking.startsAt
  const end = booking.blockedEndsAt || booking.endsAt
  return compareIso(start, candidate.end) < 0 && compareIso(end, candidate.start) > 0
}

function windowsForDate(localDate, weeklyAvailability, overrides) {
  const override = (overrides || []).find((item) => item.date === localDate)
  if (override?.unavailable) return []
  if (override && (override.start || override.end)) return [{ start: override.start, end: override.end }]
  const weekday = localWeekday(localDate)
  return (weeklyAvailability || [])
    .filter((item) => Number(item.weekday) === weekday && item.start && item.end)
    .map(({ start, end }) => ({ start, end }))
}

export function computeAvailableSlots({
  localDate,
  timezone,
  weeklyAvailability,
  overrides = [],
  bookings = [],
  service,
  now = new Date(),
  minimumNoticeMinutes = 0,
  maxFutureDays = 90,
  slotIntervalMinutes = 30,
}) {
  assertDate(localDate)
  if (!timezone || !service) return []
  const nowDate = new Date(now)
  if (Number.isNaN(nowDate.getTime())) throw new Error('Invalid current time')
  const today = localDateFromUtc(nowDate, timezone)
  const dayDistance = Math.round(utcDayNumber(localDate) - utcDayNumber(today))
  if (dayDistance < 0 || dayDistance > Number(maxFutureDays)) return []

  const duration = Number(service.durationMinutes)
  const interval = Number(slotIntervalMinutes)
  const bufferBefore = Number(service.bufferBefore || 0)
  const bufferAfter = Number(service.bufferAfter || 0)
  if (!Number.isInteger(duration) || duration <= 0 || !Number.isInteger(interval) || interval <= 0) return []

  const active = bookings.filter((booking) => activeBooking(booking, nowDate.toISOString()))
  const slots = []
  for (const window of windowsForDate(localDate, weeklyAvailability, overrides)) {
    let cursor = parseClock(window.start)
    const end = parseClock(window.end)
    if (end <= cursor) continue
    while (cursor + duration <= end) {
      const startClock = clockString(cursor)
      const endClock = clockString(cursor + duration)
      const start = localDateTimeToUtc(localDate, startClock, timezone)
      const finish = localDateTimeToUtc(localDate, endClock, timezone)
      cursor += interval
      if (!start || !finish || finish <= start) continue
      if (start.getTime() - nowDate.getTime() < Number(minimumNoticeMinutes) * 60000) continue
      const candidate = {
        start: new Date(start.getTime() - bufferBefore * 60000).toISOString(),
        end: new Date(finish.getTime() + bufferAfter * 60000).toISOString(),
      }
      if (!active.some((booking) => overlaps(candidate, booking))) {
        slots.push({ start: start.toISOString(), end: finish.toISOString() })
      }
    }
  }
  return slots
}

export function serviceById(services, serviceId) {
  return (services || []).find((service) => service.id === String(serviceId)) || null
}

export function validateReservationInput(input, services) {
  const service = serviceById(services, input?.serviceId)
  if (!service) throw new Error('That service is not available')
  const start = String(input?.start || '')
  const end = String(input?.end || '')
  if (!ISO_RE.test(start) || !ISO_RE.test(end) || new Date(end) <= new Date(start)) throw new Error('Invalid appointment time')
  const name = String(input?.customerName || '').trim()
  const email = String(input?.customerEmail || '').trim().toLowerCase()
  const phone = String(input?.customerPhone || '').trim()
  const notes = String(input?.customerNotes || '').trim()
  if (name.length < 2 || name.length > 120) throw new Error('Please enter your name')
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 254) throw new Error('Please enter a valid email address')
  if (phone.length > 40 || notes.length > 2000) throw new Error('One of the fields is too long')
  return { service, start, end, name, email, phone, notes }
}

export function normaliseAvailabilityOverride(input) {
  const date = String(input?.date || input?.localDate || '').trim()
  assertDate(date)
  const unavailable = input?.unavailable === true
    || input?.unavailable === 1
    || input?.unavailable === '1'
    || input?.unavailable === 'true'
    || input?.kind === 'closed'
  const start = String(input?.start || input?.startTime || '').trim()
  const end = String(input?.end || input?.endTime || '').trim()
  const note = String(input?.note || '').trim().slice(0, 255)

  if (unavailable) return { date, start: null, end: null, unavailable: true, note }
  if (!start || !end || parseClock(end) <= parseClock(start)) {
    throw new Error('Availability hours must include a start before the end')
  }
  return { date, start, end, unavailable: false, note }
}

export function publicService(service) {
  const { id, name, group, description, durationMinutes, priceCents, depositCents, currency } = service
  return { id, name, group, description, durationMinutes, priceCents, depositCents, currency }
}
