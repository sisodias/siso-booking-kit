import {
  addLocalDays,
  computeAvailableSlots,
  localDateFromUtc,
  localDateTimeToUtc,
  normaliseAvailabilityOverride,
  publicService,
  serviceById,
  validateReservationInput,
} from './booking-core.js'

const ACTIVE_STATUSES = "'pending', 'awaiting_payment', 'confirmed'"
const MAX_BODY_BYTES = 24_000
const PAYMENT_HOLD_MINUTES = 30
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...headers,
    },
  })
}

function pathFor(context) {
  const path = context.params?.path
  if (Array.isArray(path)) return path.join('/').replace(/^\/+|\/+$/g, '')
  return String(path || '').replace(/^\/+|\/+$/g, '')
}

function dbFor(env) {
  return env?.BOOKING_DB || env?.DB || null
}

function isDb(db) {
  return Boolean(db && typeof db.prepare === 'function')
}

async function queryAll(db, sql, ...params) {
  const result = await db.prepare(sql).bind(...params).all()
  return result?.results || []
}

async function queryFirst(db, sql, ...params) {
  return db.prepare(sql).bind(...params).first()
}

async function execute(db, sql, ...params) {
  return db.prepare(sql).bind(...params).run()
}

function changesOf(result) {
  return Number(result?.meta?.changes ?? result?.changes ?? 0)
}

function safeText(value, max = 255) {
  return String(value ?? '').trim().slice(0, max)
}

function idempotencyKey(request, input) {
  const value = safeText(request.headers.get('idempotency-key') || input?.idempotencyKey, 128)
  if (value && /^[A-Za-z0-9._:-]{1,128}$/.test(value)) return value
  return crypto.randomUUID()
}

function randomToken() {
  return `${crypto.randomUUID()}-${crypto.randomUUID()}`
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function constantTimeEqual(left, right) {
  const a = String(left || '')
  const b = String(right || '')
  if (!a || a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}

function rowToBooking(row) {
  if (!row) return null
  return {
    id: row.id,
    providerId: row.provider_id,
    serviceId: row.service_id,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    blockedStartsAt: row.blocked_starts_at,
    blockedEndsAt: row.blocked_ends_at,
    customerName: row.customer_name,
    customerEmail: row.customer_email,
    customerPhone: row.customer_phone,
    customerNotes: row.customer_notes,
    status: row.status,
    paymentStatus: row.payment_status,
    paymentAmountCents: Number(row.payment_amount_cents || 0),
    currency: row.currency,
    stripeSessionId: row.stripe_session_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function publicBooking(booking, extras = {}) {
  return {
    bookingId: booking.id,
    serviceId: booking.serviceId,
    startsAt: booking.startsAt,
    endsAt: booking.endsAt,
    status: booking.status,
    paymentStatus: booking.paymentStatus,
    ...extras,
  }
}

function icsEscape(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/\r?\n/g, '\\n')
    .replace(/([;,])/g, '\\$1')
}

function icsTimestamp(value) {
  return new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

export function calendarForBooking({ config, service, booking }) {
  const status = booking.status === 'confirmed' ? 'CONFIRMED' : booking.status === 'cancelled' ? 'CANCELLED' : 'TENTATIVE'
  const summary = `${service.name} — ${config.providerName || config.providerId}`
  const description = `Booking reference: ${booking.id}`
  const location = config.location || ''
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SISO//Booking Module//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${icsEscape(config.providerName || config.providerId)}`,
    'BEGIN:VEVENT',
    `UID:${icsEscape(`${booking.id}@${config.providerId}`)}`,
    `DTSTAMP:${icsTimestamp(booking.createdAt || new Date().toISOString())}`,
    `DTSTART:${icsTimestamp(booking.startsAt)}`,
    `DTEND:${icsTimestamp(booking.endsAt)}`,
    `SUMMARY:${icsEscape(summary)}`,
    `DESCRIPTION:${icsEscape(description)}`,
    ...(location ? [`LOCATION:${icsEscape(location)}`] : []),
    `STATUS:${status}`,
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

function calendarUrlFor(request, bookingId, manageToken) {
  const url = new URL('/api/booking/calendar', request.url)
  url.searchParams.set('bookingId', bookingId)
  url.searchParams.set('manageToken', manageToken)
  return url.toString()
}

function dateRange(localDate, timezone) {
  const nextDate = addLocalDays(localDate, 1)
  const start = localDateTimeToUtc(localDate, '00:00', timezone)
  const end = localDateTimeToUtc(nextDate, '00:00', timezone)
  if (!start || !end) throw new Error('Could not resolve the requested date')
  return { start: start.toISOString(), end: end.toISOString() }
}

async function bookingsBetween(db, providerId, start, end, now) {
  const rows = await queryAll(
    db,
    `SELECT starts_at, ends_at, blocked_starts_at, blocked_ends_at, status, expires_at
       FROM booking_bookings
      WHERE provider_id = ?
        AND starts_at < ?
        AND ends_at > ?
        AND status NOT IN ('cancelled', 'expired')
        AND (expires_at IS NULL OR expires_at > ?)`,
    providerId,
    end,
    start,
    now,
  )
  return rows.map((row) => ({
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    blockedStartsAt: row.blocked_starts_at,
    blockedEndsAt: row.blocked_ends_at,
    status: row.status,
    expiresAt: row.expires_at,
  }))
}

function staticOverrides(config) {
  return Array.isArray(config.availabilityOverrides) ? config.availabilityOverrides : []
}

async function persistedOverrides(db, providerId, from, to) {
  if (!isDb(db)) return []
  try {
    const rows = await queryAll(
      db,
      `SELECT id, local_date, start_time, end_time, unavailable, note
         FROM booking_availability_overrides
        WHERE provider_id = ? AND local_date >= ? AND local_date <= ?
        ORDER BY local_date ASC`,
      providerId,
      from,
      to,
    )
    return rows.map((row) => ({
      id: row.id,
      date: row.local_date,
      start: row.start_time,
      end: row.end_time,
      unavailable: Number(row.unavailable) === 1,
      note: row.note || '',
    }))
  } catch (error) {
    // Existing hosts can deploy the module before applying the optional
    // operator-calendar migration. Keep their static config/fallback alive.
    if (!String(error?.message || '').toLowerCase().includes('no such table')) throw error
    return []
  }
}

async function overridesForRange(db, config, from, to) {
  const stored = await persistedOverrides(db, config.providerId, from, to)
  return [...stored, ...staticOverrides(config)]
}

function configuredForBookings(config, env, db) {
  if (!isDb(db)) return false
  const paymentNeeded = modeFor(config, env) === 'deposit' && config.services.some((service) => Number(service.depositCents) > 0)
  return !paymentNeeded || Boolean(env?.STRIPE_SECRET_KEY)
}

function modeFor(config, env) {
  return ['deposit', 'manual', 'none'].includes(env?.BOOKING_PAYMENT_MODE) ? env.BOOKING_PAYMENT_MODE : config.paymentMode
}

function paymentState(config, env) {
  const mode = modeFor(config, env)
  const paymentNeeded = mode === 'deposit' && config.services.some((service) => Number(service.depositCents) > 0)
  return {
    required: paymentNeeded,
    configured: !paymentNeeded || Boolean(env?.STRIPE_SECRET_KEY),
    provider: paymentNeeded ? 'stripe-checkout' : mode,
    mode,
  }
}

function publicConfig(config, env, db) {
  return {
    module: 'booking',
    configured: configuredForBookings(config, env, db),
    providerId: config.providerId,
    timezone: config.timezone,
    currency: config.currency,
    payment: paymentState(config, env),
    services: config.services.map(publicService),
    weeklyAvailability: config.weeklyAvailability,
    policy: {
      cancellationWindowHours: config.cancellationWindowHours,
      minimumNoticeMinutes: config.minimumNoticeMinutes,
      maxFutureDays: config.maxFutureDays,
    },
  }
}

async function availabilityResponse({ request, config, env }) {
  const db = dbFor(env)
  if (!isDb(db)) return json({ configured: false, error: 'Booking database is not configured' }, 503)
  const url = new URL(request.url)
  const service = serviceById(config.services, url.searchParams.get('serviceId'))
  if (!service) return json({ error: 'Unknown service' }, 400)
  const now = new Date().toISOString()
  const month = safeText(url.searchParams.get('month'), 7)
  const localDate = safeText(url.searchParams.get('date'), 10)

  if (localDate) {
    const range = dateRange(localDate, config.timezone)
    const bookings = await bookingsBetween(db, config.providerId, range.start, range.end, now)
    const overrides = await overridesForRange(db, config, localDate, localDate)
    const slots = computeAvailableSlots({
      localDate,
      timezone: config.timezone,
      weeklyAvailability: config.weeklyAvailability,
      overrides,
      bookings,
      service,
      now,
      minimumNoticeMinutes: config.minimumNoticeMinutes,
      maxFutureDays: config.maxFutureDays,
      slotIntervalMinutes: config.slotIntervalMinutes,
    })
    return json({ configured: configuredForBookings(config, env, db), serviceId: service.id, date: localDate, timezone: config.timezone, slots })
  }

  if (!/^\d{4}-\d{2}$/.test(month)) return json({ error: 'month must be YYYY-MM' }, 400)
  const firstDate = `${month}-01`
  const lastDate = addLocalDays(firstDate, new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).getUTCDate() - 1)
  const range = dateRange(firstDate, config.timezone)
  const endRange = dateRange(addLocalDays(lastDate, 1), config.timezone)
  const bookings = await bookingsBetween(db, config.providerId, range.start, endRange.end, now)
  const overrides = await overridesForRange(db, config, firstDate, lastDate)
  const dates = []
  for (let cursor = firstDate; cursor <= lastDate; cursor = addLocalDays(cursor, 1)) {
    const slots = computeAvailableSlots({
      localDate: cursor,
      timezone: config.timezone,
      weeklyAvailability: config.weeklyAvailability,
      overrides,
      bookings,
      service,
      now,
      minimumNoticeMinutes: config.minimumNoticeMinutes,
      maxFutureDays: config.maxFutureDays,
      slotIntervalMinutes: config.slotIntervalMinutes,
    })
    if (slots.length) dates.push({ date: cursor })
  }
  return json({ configured: configuredForBookings(config, env, db), serviceId: service.id, month, timezone: config.timezone, dates })
}

function reservationInsertSql() {
  return `INSERT INTO booking_bookings (
      id, provider_id, service_id, starts_at, ends_at,
      blocked_starts_at, blocked_ends_at, customer_name, customer_email,
      customer_phone, customer_notes, status, payment_status,
      payment_amount_cents, currency, idempotency_key, manage_token_hash,
      stripe_session_id, expires_at, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE NOT EXISTS (
      SELECT 1 FROM booking_bookings
       WHERE provider_id = ?
         AND status IN (${ACTIVE_STATUSES})
         AND blocked_starts_at < ?
         AND blocked_ends_at > ?
         AND (expires_at IS NULL OR expires_at > ?)
    )`
}

async function createStripeCheckout({ request, env, config, service, booking }) {
  const origin = config.publicOrigin || new URL(request.url).origin
  const params = new URLSearchParams()
  params.set('mode', 'payment')
  params.set('success_url', `${origin}/book?booking=success&bookingId=${encodeURIComponent(booking.id)}`)
  params.set('cancel_url', `${origin}/book?booking=cancelled&bookingId=${encodeURIComponent(booking.id)}`)
  params.set('customer_email', booking.customerEmail)
  params.set('client_reference_id', booking.id)
  params.set('line_items[0][quantity]', '1')
  params.set('line_items[0][price_data][currency]', service.currency || config.currency || 'gbp')
  params.set('line_items[0][price_data][unit_amount]', String(service.depositCents))
  params.set('line_items[0][price_data][product_data][name]', `${service.name} deposit`)
  params.set('line_items[0][price_data][product_data][description]', `${service.name} at ${config.providerName || config.providerId}`)
  params.set('metadata[booking_id]', booking.id)
  params.set('metadata[provider_id]', config.providerId)
  params.set('metadata[service_id]', service.id)

  const response = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: params,
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || !body?.id || !body?.url) {
    throw new Error(body?.error?.message || 'Stripe checkout could not be created')
  }
  return body
}

function emailHtml(config, service, booking, kind = 'confirmation') {
  const title = kind === 'cancellation' ? 'Your appointment has been cancelled' : 'Your MelanoTresses appointment'
  const when = new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: config.timezone,
  }).format(new Date(booking.startsAt))
  const escape = (value) => String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]))
  return `<div style="font-family:Arial,sans-serif;max-width:620px;color:#4d2e10">
    <h2>${escape(title)}</h2>
    <p><strong>${escape(service.name)}</strong><br>${escape(when)}</p>
    <p>For questions, reply to this email or contact MelanoTresses directly.</p>
    <p style="font-size:12px;color:#765f4b">Booking reference: ${escape(booking.id)}</p>
  </div>`
}

async function sendEmail({ env, config, service, booking, kind }) {
  if (!env?.RESEND_API_KEY) return false
  const to = env.BOOKING_TO || config.contactEmail
  const from = env.BOOKING_FROM || config.contactEmail
  if (!to || !from) return false
  const subject = kind === 'cancellation' ? `Cancelled: ${service.name}` : `Booked: ${service.name}`
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: `${config.providerName || config.providerId} <${from}>`,
      to: [booking.customerEmail, to],
      reply_to: to,
      subject,
      html: emailHtml(config, service, booking, kind),
    }),
  })
  return response.ok
}

async function reservationResponse({ request, config, env }) {
  const db = dbFor(env)
  if (!isDb(db)) return json({ configured: false, error: 'Booking database is not configured' }, 503)
  const raw = await request.text()
  if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return json({ error: 'Request is too large' }, 413)
  let input
  try {
    input = JSON.parse(raw)
  } catch {
    return json({ error: 'Invalid JSON request' }, 400)
  }
  if (input?._gotcha) return json({ ok: true })

  let data
  try {
    data = validateReservationInput(input, config.services)
  } catch (error) {
    return json({ error: error.message }, 400)
  }

  const paymentRequired = modeFor(config, env) === 'deposit' && Number(data.service.depositCents) > 0
  if (paymentRequired && !env?.STRIPE_SECRET_KEY) {
    return json({ configured: false, error: 'Payment provider is not configured' }, 503)
  }

  const key = idempotencyKey(request, input)
  const existing = await queryFirst(db, 'SELECT * FROM booking_bookings WHERE provider_id = ? AND idempotency_key = ?', config.providerId, key)
  if (existing) {
    return json(publicBooking(rowToBooking(existing), { replayed: true }))
  }

  const localDate = localDateFromUtc(new Date(data.start), config.timezone)
  const range = dateRange(localDate, config.timezone)
  const currentBookings = await bookingsBetween(db, config.providerId, range.start, range.end, new Date().toISOString())
  const overrides = await overridesForRange(db, config, localDate, localDate)
  const slots = computeAvailableSlots({
    localDate,
    timezone: config.timezone,
    weeklyAvailability: config.weeklyAvailability,
    overrides,
    bookings: currentBookings,
    service: data.service,
    now: new Date(),
    minimumNoticeMinutes: config.minimumNoticeMinutes,
    maxFutureDays: config.maxFutureDays,
    slotIntervalMinutes: config.slotIntervalMinutes,
  })
  if (!slots.some((slot) => slot.start === data.start && slot.end === data.end)) {
    return json({ error: 'That time is no longer available' }, 409)
  }

  const now = new Date().toISOString()
  const bookingId = crypto.randomUUID()
  const manageToken = randomToken()
  const manageTokenHash = await sha256Hex(manageToken)
  const status = paymentRequired ? 'awaiting_payment' : modeFor(config, env) === 'manual' ? 'pending' : 'confirmed'
  const paymentStatus = paymentRequired ? 'pending' : 'unpaid'
  const expiresAt = paymentRequired ? new Date(Date.now() + PAYMENT_HOLD_MINUTES * 60000).toISOString() : null
  const blockedStart = new Date(new Date(data.start).getTime() - Number(data.service.bufferBefore || 0) * 60000).toISOString()
  const blockedEnd = new Date(new Date(data.end).getTime() + Number(data.service.bufferAfter || 0) * 60000).toISOString()

  const insert = await execute(
    db,
    reservationInsertSql(),
    bookingId,
    config.providerId,
    data.service.id,
    data.start,
    data.end,
    blockedStart,
    blockedEnd,
    data.name,
    data.email,
    data.phone || null,
    data.notes || null,
    status,
    paymentStatus,
    paymentRequired ? Number(data.service.depositCents) : 0,
    data.service.currency || config.currency,
    key,
    manageTokenHash,
    null,
    expiresAt,
    now,
    now,
    config.providerId,
    blockedEnd,
    blockedStart,
    now,
  )

  if (changesOf(insert) !== 1) return json({ error: 'That time was just taken — please choose another.' }, 409)

  let booking = {
    id: bookingId,
    providerId: config.providerId,
    serviceId: data.service.id,
    startsAt: data.start,
    endsAt: data.end,
    customerName: data.name,
    customerEmail: data.email,
    customerPhone: data.phone,
    customerNotes: data.notes,
    status,
    paymentStatus,
    paymentAmountCents: paymentRequired ? Number(data.service.depositCents) : 0,
    currency: data.service.currency || config.currency,
  }

  if (paymentRequired) {
    try {
      const session = await createStripeCheckout({ request, env, config, service: data.service, booking })
      await execute(db, 'UPDATE booking_bookings SET stripe_session_id = ?, updated_at = ? WHERE id = ?', session.id, new Date().toISOString(), bookingId)
      return json(publicBooking(booking, { status: 'payment_required', checkoutUrl: session.url }), 201)
    } catch (error) {
      await execute(db, "UPDATE booking_bookings SET status = 'expired', payment_status = 'failed', expires_at = ?, updated_at = ? WHERE id = ?", new Date().toISOString(), new Date().toISOString(), bookingId)
      console.error('Stripe checkout creation failed:', error.message)
      return json({ error: 'Secure payment could not be started. Please try again.' }, 502)
    }
  }

  const emailSent = await sendEmail({ env, config, service: data.service, booking, kind: 'confirmation' }).catch(() => false)
  return json(publicBooking(booking, {
    status: status === 'pending' ? 'requested' : 'confirmed',
    manageToken,
    calendarUrl: calendarUrlFor(request, bookingId, manageToken),
    emailSent,
  }), 201)
}

async function verifyStripeSignature(signature, rawBody, secret, toleranceSeconds = 300) {
  if (!signature || !secret) return false
  const values = Object.create(null)
  for (const part of String(signature).split(',')) {
    const [key, value] = part.split('=', 2)
    if (key && value) (values[key] ||= []).push(value)
  }
  const timestamp = Number(values.t?.[0])
  if (!Number.isInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > toleranceSeconds) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signed = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${rawBody}`))
  const expected = Array.from(new Uint8Array(signed), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return values.v1?.some((candidate) => constantTimeEqual(candidate, expected)) || false
}

async function webhookResponse({ request, config, env }) {
  const db = dbFor(env)
  if (!isDb(db)) return json({ configured: false, error: 'Booking database is not configured' }, 503)
  const rawBody = await request.text()
  if (!(await verifyStripeSignature(request.headers.get('stripe-signature'), rawBody, env.STRIPE_WEBHOOK_SECRET))) {
    return json({ error: 'Invalid Stripe signature' }, 400)
  }
  let event
  try {
    event = JSON.parse(rawBody)
  } catch {
    return json({ error: 'Invalid Stripe event' }, 400)
  }
  if (!event?.id || !event?.type) return json({ error: 'Malformed Stripe event' }, 400)
  const seen = await queryFirst(db, 'SELECT event_id FROM booking_webhook_events WHERE event_id = ?', event.id)
  if (seen) return json({ ok: true, duplicate: true })

  const session = event.data?.object || {}
  const bookingId = session.metadata?.booking_id
  if (bookingId && ['checkout.session.completed', 'checkout.session.expired'].includes(event.type)) {
    const row = await queryFirst(db, 'SELECT * FROM booking_bookings WHERE id = ? AND provider_id = ?', bookingId, config.providerId)
    if (row) {
      const booking = rowToBooking(row)
      if (event.type === 'checkout.session.completed' && booking.status === 'awaiting_payment') {
        const service = serviceById(config.services, booking.serviceId)
        if (service) {
          await execute(db, `UPDATE booking_bookings
              SET status = 'confirmed', payment_status = 'paid', expires_at = NULL,
                  stripe_session_id = ?, updated_at = ?
            WHERE id = ? AND status = 'awaiting_payment'`, session.id || booking.stripeSessionId, new Date().toISOString(), booking.id)
          booking.status = 'confirmed'
          booking.paymentStatus = 'paid'
          booking.stripeSessionId = session.id || booking.stripeSessionId
          await sendEmail({ env, config, service, booking, kind: 'confirmation' }).catch(() => false)
        }
      } else if (event.type === 'checkout.session.expired' && booking.status === 'awaiting_payment') {
        await execute(db, "UPDATE booking_bookings SET status = 'expired', payment_status = 'failed', updated_at = ? WHERE id = ? AND status = 'awaiting_payment'", new Date().toISOString(), booking.id)
      }
    }
  }
  await execute(db, 'INSERT OR IGNORE INTO booking_webhook_events (event_id, event_type, received_at) VALUES (?, ?, ?)', event.id, event.type, new Date().toISOString())
  return json({ ok: true })
}

async function cancelResponse({ request, config, env }) {
  const db = dbFor(env)
  if (!isDb(db)) return json({ configured: false, error: 'Booking database is not configured' }, 503)
  let input
  try { input = await request.json() } catch { return json({ error: 'Invalid JSON request' }, 400) }
  const bookingId = safeText(input?.bookingId, 80)
  const token = safeText(input?.manageToken, 160)
  if (!bookingId || !token) return json({ error: 'Booking reference and management token are required' }, 400)
  const row = await queryFirst(db, 'SELECT * FROM booking_bookings WHERE id = ? AND provider_id = ?', bookingId, config.providerId)
  const hash = await sha256Hex(token)
  if (!row || !constantTimeEqual(hash, row.manage_token_hash)) return json({ error: 'Booking not found' }, 404)
  if (!['pending', 'awaiting_payment', 'confirmed'].includes(row.status)) return json({ error: 'That booking is no longer active' }, 409)
  const cutoff = new Date(new Date(row.starts_at).getTime() - Number(config.cancellationWindowHours) * 3600000)
  if (new Date() > cutoff) return json({ error: `Changes must be made at least ${config.cancellationWindowHours} hours before the appointment` }, 409)
  await execute(db, "UPDATE booking_bookings SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('pending', 'awaiting_payment', 'confirmed')", new Date().toISOString(), bookingId)
  const booking = rowToBooking({ ...row, status: 'cancelled' })
  const service = serviceById(config.services, booking.serviceId)
  if (service) await sendEmail({ env, config, service, booking, kind: 'cancellation' }).catch(() => false)
  return json({ ok: true, bookingId, status: 'cancelled' })
}

async function calendarResponse({ request, config, env }) {
  const db = dbFor(env)
  if (!isDb(db)) return json({ configured: false, error: 'Booking database is not configured' }, 503)
  const url = new URL(request.url)
  const bookingId = safeText(url.searchParams.get('bookingId'), 80)
  const manageToken = safeText(url.searchParams.get('manageToken'), 160)
  if (!bookingId || !manageToken) return json({ error: 'Booking reference and management token are required' }, 400)
  const row = await queryFirst(db, 'SELECT * FROM booking_bookings WHERE id = ? AND provider_id = ?', bookingId, config.providerId)
  const hash = await sha256Hex(manageToken)
  if (!row || !constantTimeEqual(hash, row.manage_token_hash)) return json({ error: 'Booking not found' }, 404)
  if (!['pending', 'awaiting_payment', 'confirmed'].includes(row.status)) return json({ error: 'That booking is no longer active' }, 409)
  const booking = rowToBooking(row)
  const service = serviceById(config.services, booking.serviceId)
  if (!service) return json({ error: 'Booking service is no longer available' }, 404)
  const filename = `${service.name}-${booking.id}`.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'appointment'
  return new Response(calendarForBooking({ config, service, booking }), {
    status: 200,
    headers: {
      'content-type': 'text/calendar; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}.ics"`,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    },
  })
}

function adminAuthorised(request, env) {
  const configured = safeText(env?.BOOKING_ADMIN_TOKEN, 255)
  const supplied = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || ''
  return Boolean(configured && constantTimeEqual(configured, supplied))
}

function publicOverride(row) {
  return {
    id: row.id,
    date: row.local_date || row.date,
    start: row.start_time ?? row.start ?? null,
    end: row.end_time ?? row.end ?? null,
    unavailable: Number(row.unavailable) === 1 || row.unavailable === true,
    note: row.note || '',
  }
}

async function adminAvailabilityResponse({ request, config, env, id }) {
  if (!adminAuthorised(request, env)) return json({ error: 'Unauthorised' }, 401, { 'www-authenticate': 'Bearer' })
  const db = dbFor(env)
  if (!isDb(db)) return json({ configured: false, error: 'Booking database is not configured' }, 503)

  if (id) {
    if (request.method !== 'DELETE') return json({ error: 'Method not allowed' }, 405, { allow: 'DELETE' })
    const result = await execute(
      db,
      'DELETE FROM booking_availability_overrides WHERE id = ? AND provider_id = ?',
      safeText(id, 80),
      config.providerId,
    )
    return changesOf(result)
      ? json({ ok: true, id })
      : json({ error: 'Availability override not found' }, 404)
  }

  if (request.method === 'GET') {
    const url = new URL(request.url)
    const today = localDateFromUtc(new Date(), config.timezone)
    const from = safeText(url.searchParams.get('from'), 10) || today
    let to = safeText(url.searchParams.get('to'), 10)
    try {
      addLocalDays(from, 0)
      to ||= addLocalDays(from, 90)
      addLocalDays(to, 0)
      if (to < from) throw new Error('Invalid range')
    } catch {
      return json({ error: 'from and to must be valid local dates' }, 400)
    }
    const rows = await persistedOverrides(db, config.providerId, from, to)
    return json({ overrides: rows })
  }

  if (request.method === 'POST') {
    const raw = await request.text()
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) return json({ error: 'Request is too large' }, 413)
    let input
    try {
      input = JSON.parse(raw)
    } catch {
      return json({ error: 'Invalid JSON request' }, 400)
    }
    let override
    try {
      override = normaliseAvailabilityOverride(input)
    } catch (error) {
      return json({ error: error.message }, 400)
    }
    const existing = await queryFirst(
      db,
      'SELECT id FROM booking_availability_overrides WHERE provider_id = ? AND local_date = ?',
      config.providerId,
      override.date,
    )
    const idValue = existing?.id || crypto.randomUUID()
    const now = new Date().toISOString()
    await execute(
      db,
      `INSERT INTO booking_availability_overrides
        (id, provider_id, local_date, start_time, end_time, unavailable, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(provider_id, local_date) DO UPDATE SET
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        unavailable = excluded.unavailable,
        note = excluded.note,
        updated_at = excluded.updated_at`,
      idValue,
      config.providerId,
      override.date,
      override.start,
      override.end,
      override.unavailable ? 1 : 0,
      override.note || null,
      now,
      now,
    )
    const row = await queryFirst(
      db,
      'SELECT id, local_date, start_time, end_time, unavailable, note FROM booking_availability_overrides WHERE provider_id = ? AND local_date = ?',
      config.providerId,
      override.date,
    )
    return json({ override: publicOverride(row), created: !existing }, existing ? 200 : 201)
  }

  return json({ error: 'Method not allowed' }, 405, { allow: 'GET, POST' })
}

async function adminResponse({ request, config, env }) {
  if (!adminAuthorised(request, env)) return json({ error: 'Unauthorised' }, 401, { 'www-authenticate': 'Bearer' })
  const db = dbFor(env)
  if (!isDb(db)) return json({ configured: false, error: 'Booking database is not configured' }, 503)
  if (request.method === 'GET') {
    const url = new URL(request.url)
    const from = safeText(url.searchParams.get('from'), 24) || new Date().toISOString()
    const rows = await queryAll(db, `SELECT id, service_id, starts_at, ends_at, customer_name, customer_email,
        customer_phone, customer_notes, status, payment_status, payment_amount_cents, currency,
        stripe_session_id, created_at, updated_at
      FROM booking_bookings WHERE provider_id = ? AND starts_at >= ? ORDER BY starts_at ASC LIMIT 200`, config.providerId, from)
    return json({ bookings: rows })
  }
  if (request.method === 'POST') {
    let input
    try { input = await request.json() } catch { return json({ error: 'Invalid JSON request' }, 400) }
    const id = safeText(input?.bookingId, 80)
    if (!id) return json({ error: 'bookingId is required' }, 400)
    const result = await execute(db, "UPDATE booking_bookings SET status = 'cancelled', updated_at = ? WHERE id = ? AND provider_id = ? AND status IN ('pending', 'awaiting_payment', 'confirmed')", new Date().toISOString(), id, config.providerId)
    return changesOf(result) ? json({ ok: true, bookingId: id, status: 'cancelled' }) : json({ error: 'Booking not found or already inactive' }, 404)
  }
  return json({ error: 'Method not allowed' }, 405, { allow: 'GET, POST' })
}

export function createBookingHandler(inputConfig = {}) {
  const config = {
    providerId: 'default-provider',
    providerName: 'SISO client',
    timezone: 'UTC',
    currency: 'gbp',
    paymentMode: 'deposit',
    weeklyAvailability: [],
    availabilityOverrides: [],
    services: [],
    minimumNoticeMinutes: 0,
    maxFutureDays: 90,
    slotIntervalMinutes: 30,
    cancellationWindowHours: 12,
    ...inputConfig,
  }

  return async (context) => {
    const { request, env = {} } = context
    const path = pathFor(context)
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { allow: 'GET, POST, OPTIONS' } })
    if (path === 'health' && request.method === 'GET') {
      const db = dbFor(env)
      return json({
        status: 'ok',
        module: 'booking',
        configured: configuredForBookings(config, env, db),
        database: isDb(db),
        payment: paymentState(config, env),
        email: Boolean(env.RESEND_API_KEY),
      })
    }
    if (path === 'config' && request.method === 'GET') return json(publicConfig(config, env, dbFor(env)))
    if (path === 'availability' && request.method === 'GET') {
      try { return await availabilityResponse({ request, config, env }) } catch (error) {
        console.error('Booking availability failed:', error.message)
        return json({ error: 'Availability is temporarily unavailable' }, 503)
      }
    }
    if (path === 'reservations' && request.method === 'POST') {
      try { return await reservationResponse({ request, config, env }) } catch (error) {
        console.error('Booking reservation failed:', error.message)
        return json({ error: 'Booking is temporarily unavailable' }, 503)
      }
    }
    if (path === 'calendar' && request.method === 'GET') {
      try { return await calendarResponse({ request, config, env }) } catch (error) {
        console.error('Booking calendar export failed:', error.message)
        return json({ error: 'Calendar export is temporarily unavailable' }, 503)
      }
    }
    if (path === 'cancel' && request.method === 'POST') {
      try { return await cancelResponse({ request, config, env }) } catch (error) {
        console.error('Booking cancellation failed:', error.message)
        return json({ error: 'Cancellation is temporarily unavailable' }, 503)
      }
    }
    if (path === 'webhook' && request.method === 'POST') {
      try { return await webhookResponse({ request, config, env }) } catch (error) {
        console.error('Booking webhook failed:', error.message)
        return json({ error: 'Webhook processing failed' }, 500)
      }
    }
    if (path === 'admin/availability' || path.startsWith('admin/availability/')) {
      const id = path.split('/')[2] || null
      try { return await adminAvailabilityResponse({ request, config, env, id }) } catch (error) {
        console.error('Booking availability admin failed:', error.message)
        return json({ error: 'Availability administration is temporarily unavailable' }, 503)
      }
    }
    if (path === 'admin' || path === 'admin/bookings') return adminResponse({ request, config, env })
    return json({ error: 'Booking endpoint not found' }, 404)
  }
}

export { reservationInsertSql, verifyStripeSignature }
