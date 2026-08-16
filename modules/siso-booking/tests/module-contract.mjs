import assert from 'node:assert/strict'
import { computeAvailableSlots, localDateTimeToUtc, normaliseAvailabilityOverride, validateReservationInput } from '../server/booking-core.js'
import { calendarForBooking, createBookingHandler, reservationInsertSql } from '../server/booking-handler.js'

const config = {
  providerId: 'test-studio',
  timezone: 'Europe/London',
  currency: 'gbp',
  paymentMode: 'deposit',
  services: [{ id: 'consultation', name: 'Consultation', durationMinutes: 60, priceCents: 7000, depositCents: 3500, currency: 'gbp' }],
  weeklyAvailability: [{ weekday: 1, start: '09:00', end: '17:00' }],
  maxFutureDays: 365,
  slotIntervalMinutes: 60,
  cancellationWindowHours: 12,
}

const monday = '2026-08-24'
const start = localDateTimeToUtc(monday, '09:00', config.timezone)
const end = localDateTimeToUtc(monday, '10:00', config.timezone)
assert.ok(start && end)

const slots = computeAvailableSlots({
  localDate: monday,
  timezone: config.timezone,
  weeklyAvailability: config.weeklyAvailability,
  service: config.services[0],
  now: new Date('2026-08-20T12:00:00Z'),
  maxFutureDays: config.maxFutureDays,
  slotIntervalMinutes: config.slotIntervalMinutes,
})
assert.equal(slots[0].start, start.toISOString())
assert.equal(slots[0].end, end.toISOString())
assert.equal(slots.length, 8)

const blocked = computeAvailableSlots({
  localDate: monday,
  timezone: config.timezone,
  weeklyAvailability: config.weeklyAvailability,
  service: config.services[0],
  bookings: [{ startsAt: start.toISOString(), endsAt: end.toISOString(), status: 'confirmed' }],
  now: new Date('2026-08-20T12:00:00Z'),
  maxFutureDays: config.maxFutureDays,
  slotIntervalMinutes: config.slotIntervalMinutes,
})
assert.equal(blocked.some((slot) => slot.start === start.toISOString()), false)

const validated = validateReservationInput({
  serviceId: 'consultation',
  start: start.toISOString(),
  end: end.toISOString(),
  customerName: 'Test Guest',
  customerEmail: 'guest@example.test',
}, config.services)
assert.equal(validated.email, 'guest@example.test')
assert.throws(() => validateReservationInput({ ...validated, customerEmail: 'not-an-email' }, config.services))
assert.deepEqual(normaliseAvailabilityOverride({ date: monday, unavailable: true, note: 'Clinic holiday' }), {
  date: monday,
  start: null,
  end: null,
  unavailable: true,
  note: 'Clinic holiday',
})
assert.deepEqual(normaliseAvailabilityOverride({ date: monday, start: '10:00', end: '14:00' }), {
  date: monday,
  start: '10:00',
  end: '14:00',
  unavailable: false,
  note: '',
})
assert.throws(() => normaliseAvailabilityOverride({ date: monday, start: '14:00', end: '10:00' }))

const calendar = calendarForBooking({
  config: { ...config, providerName: 'Test Studio', location: '1 Example Street; Newcastle' },
  service: config.services[0],
  booking: {
    id: 'booking-123',
    status: 'confirmed',
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    createdAt: '2026-08-20T12:00:00.000Z',
  },
})
assert.match(calendar, /BEGIN:VCALENDAR\r\n/)
assert.match(calendar, /DTSTART:20260824T080000Z\r\n/)
assert.match(calendar, /DTEND:20260824T090000Z\r\n/)
assert.match(calendar, /LOCATION:1 Example Street\\; Newcastle\r\n/)
assert.match(calendar, /STATUS:CONFIRMED\r\n/)

const handler = createBookingHandler(config)
const health = await handler({
  request: new Request('https://example.test/api/booking/health'),
  env: {},
  params: { path: ['health'] },
})
assert.equal(health.status, 200)
assert.equal((await health.json()).configured, false)
const adminWithoutToken = await handler({
  request: new Request('https://example.test/api/booking/admin/availability'),
  env: {},
  params: { path: ['admin', 'availability'] },
})
assert.equal(adminWithoutToken.status, 401)
assert.match(reservationInsertSql(), /WHERE NOT EXISTS/)
assert.match(reservationInsertSql(), /blocked_starts_at < \?/)

console.log('siso-booking module contract: PASS')
