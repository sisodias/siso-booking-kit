import { useEffect, useMemo, useState } from 'react'
import { createBooking, getBookingAvailability } from './booking-client.js'

const MONTH_FORMAT = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })

function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`
}

function daysInMonth(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate()
}

function localDateString(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

function formatDate(date, timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: timezone,
  }).format(new Date(`${date}T12:00:00Z`))
}

function formatTime(iso, timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: timezone,
  }).format(new Date(iso))
}

function formatClock(totalMinutes) {
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, '0')}:${String(totalMinutes % 60).padStart(2, '0')}`
}

function slotTime(slot, timezone) {
  return slot.label || formatTime(slot.start, timezone)
}

function demoDates(month) {
  const [year, monthNumber] = month.split('-').map(Number)
  const result = []
  const count = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  for (let day = 1; day <= count; day += 1) {
    const weekday = new Date(Date.UTC(year, monthNumber - 1, day)).getUTCDay()
    if (weekday !== 0 && day % 3 !== 0) result.push(`${month}-${String(day).padStart(2, '0')}`)
  }
  return result
}

function demoSlots(date, durationMinutes = 60) {
  const [year, month, day] = date.split('-').map(Number)
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  const startHour = weekday === 6 ? 13 : 9
  const endHour = weekday === 6 ? 17 : 17
  const slots = []
  for (let minutes = startHour * 60; minutes + durationMinutes <= endHour * 60; minutes += 60) {
    const start = new Date(Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60))
    const end = new Date(start.getTime() + durationMinutes * 60000)
    slots.push({ start: start.toISOString(), end: end.toISOString(), label: formatClock(minutes) })
  }
  return slots
}

function demoMode() {
  return typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('demo')
}

export function BookingCalendar({
  endpoint = '/api/booking',
  service,
  timezone = 'UTC',
  contact,
  onUnavailable,
}) {
  const demo = demoMode()
  const [month, setMonth] = useState(() => new Date(Date.UTC(new Date().getFullYear(), new Date().getMonth(), 1)))
  const [dates, setDates] = useState(null)
  const [date, setDate] = useState(null)
  const [slots, setSlots] = useState(null)
  const [slot, setSlot] = useState(null)
  const [form, setForm] = useState({ name: '', email: '', phone: '', notes: '' })
  const [state, setState] = useState('idle')
  const [error, setError] = useState('')
  const [checkoutUrl, setCheckoutUrl] = useState('')
  const [calendarUrl, setCalendarUrl] = useState('')

  useEffect(() => {
    if (!service?.bookingId) return
    let live = true
    const monthValue = monthKey(month)
    setDates(null)
    setDate(null)
    setSlots(null)
    setSlot(null)
    const load = demo
      ? Promise.resolve({ dates: demoDates(monthValue) })
      : getBookingAvailability(endpoint, { serviceId: service.bookingId, month: monthValue })
    load
      .then((body) => {
        if (!live) return
        if (body?.configured === false && !demo) throw new Error('unconfigured')
        setDates((body.dates || []).map((item) => typeof item === 'string' ? item : item.date))
      })
      .catch((cause) => {
        if (!live) return
        if (cause.message === 'unconfigured' || cause.status === 503) onUnavailable?.()
        else setDates([])
      })
    return () => { live = false }
  }, [demo, endpoint, month, onUnavailable, service?.bookingId])

  useEffect(() => {
    if (!service?.bookingId || !date) return
    let live = true
    setSlots(null)
    setSlot(null)
    const load = demo
      ? Promise.resolve({ slots: demoSlots(date, service.durationMinutes || 60) })
      : getBookingAvailability(endpoint, { serviceId: service.bookingId, date })
    load
      .then((body) => {
        if (!live) return
        if (body?.configured === false && !demo) throw new Error('unconfigured')
        setSlots(body.slots || [])
      })
      .catch((cause) => {
        if (!live) return
        if (cause.message === 'unconfigured' || cause.status === 503) onUnavailable?.()
        else setSlots([])
      })
    return () => { live = false }
  }, [date, demo, endpoint, onUnavailable, service?.bookingId, service?.durationMinutes])

  const grid = useMemo(() => {
    const first = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1))
    return {
      start: (first.getUTCDay() + 6) % 7,
      count: daysInMonth(month),
    }
  }, [month])

  const whatsappHref = useMemo(() => {
    if (!contact?.whatsapp) return null
    const when = slot ? `${formatDate(localDateString(new Date(slot.start)), timezone)} at ${slotTime(slot, timezone)}` : 'a time that suits'
    const message = `Hi ${contact.name || 'there'}! I'm ${form.name || '...'} and I'd like to book ${service?.name || 'an appointment'} for ${when}.`
    return `https://wa.me/${contact.whatsapp}?text=${encodeURIComponent(message)}`
  }, [contact, form.name, service?.name, slot, timezone])

  async function book(event) {
    event.preventDefault()
    setError('')
    if (!form.name.trim() || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim())) {
      setError('Please enter your name and a valid email address.')
      return
    }
    setState('booking')
    setCalendarUrl('')
    if (demo) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      setState('booked')
      return
    }
    try {
      const body = await createBooking(endpoint, {
        serviceId: service.bookingId,
        start: slot.start,
        end: slot.end,
        customerName: form.name,
        customerEmail: form.email,
        customerPhone: form.phone,
        customerNotes: form.notes,
      }, crypto.randomUUID())
      if (body.status === 'payment_required' && body.checkoutUrl) {
        setCheckoutUrl(body.checkoutUrl)
        setState('payment')
      } else {
        setCalendarUrl(body.calendarUrl || '')
        setState('booked')
      }
    } catch (cause) {
      if (cause.status === 503 || cause.body?.configured === false) onUnavailable?.()
      setState('error')
      setError(cause.message || 'Booking failed — please choose another time.')
    }
  }

  if (!service) {
    return (
      <div className="flex min-h-[24rem] items-center justify-center px-6 text-center text-sm leading-relaxed text-cocoa/70">
        Choose an appointment above and the calendar will appear here.
      </div>
    )
  }

  if (state === 'booked') {
    return (
      <div className="flex min-h-[24rem] flex-col items-center justify-center gap-4 px-6 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-bark text-2xl text-white" aria-hidden="true">✓</span>
        <h3 className="font-head text-2xl text-cocoa">{demo ? 'Demo booking complete' : 'You’re booked in'}</h3>
        <p className="max-w-sm text-sm leading-relaxed text-cocoa/80">
          {service.name} — {formatDate(localDateString(new Date(slot.start)), timezone)}, {slotTime(slot, timezone)}.
          {!demo && ' A confirmation email will follow if email delivery is configured.'}
        </p>
        {calendarUrl && <a href={calendarUrl} download className="btn-ghost">Add to calendar</a>}
        {whatsappHref && <a href={whatsappHref} target="_blank" rel="noreferrer" className="btn-ghost">Message us on WhatsApp</a>}
      </div>
    )
  }

  if (state === 'payment') {
    return (
      <div className="flex min-h-[24rem] flex-col items-center justify-center gap-4 px-6 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-full bg-bark text-2xl text-white" aria-hidden="true">£</span>
        <h3 className="font-head text-2xl text-cocoa">One last step</h3>
        <p className="max-w-sm text-sm leading-relaxed text-cocoa/80">Your time is held for 30 minutes. Secure the deposit to confirm your appointment.</p>
        <a href={checkoutUrl} className="btn-primary">Secure your deposit</a>
      </div>
    )
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_1fr]">
      <div>
        <div className="mb-4 flex items-center justify-between">
          <button type="button" onClick={() => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() - 1, 1)))} aria-label="Previous month" className="flex h-10 w-10 items-center justify-center rounded-full border border-cocoa/15 text-cocoa hover:border-cocoa/40">←</button>
          <p className="font-head text-xl text-cocoa">{MONTH_FORMAT.format(month)}</p>
          <button type="button" onClick={() => setMonth(new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1)))} aria-label="Next month" className="flex h-10 w-10 items-center justify-center rounded-full border border-cocoa/15 text-cocoa hover:border-cocoa/40">→</button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center">
          {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((day, index) => <span key={`${day}-${index}`} className="py-1 font-body text-[10px] font-semibold uppercase tracking-[0.14em] text-cocoa/50">{day}</span>)}
          {Array.from({ length: grid.start }).map((_, index) => <span key={`blank-${index}`} />)}
          {Array.from({ length: grid.count }).map((_, index) => {
            const day = `${monthKey(month)}-${String(index + 1).padStart(2, '0')}`
            const open = dates?.includes(day)
            const active = date === day
            return <button key={day} type="button" disabled={!open} onClick={() => setDate(day)} aria-pressed={active} className={`aspect-square rounded-full font-body text-sm transition-colors ${active ? 'bg-bark font-semibold text-white' : open ? 'bg-bark/[0.07] font-medium text-cocoa hover:bg-bark/15' : 'text-cocoa/25'}`}>{index + 1}</button>
          })}
        </div>
        {dates === null && <p className="mt-4 text-center text-sm text-cocoa/60">Checking availability…</p>}
        {dates?.length === 0 && <p className="mt-4 text-center text-sm text-cocoa/60">No openings this month — try the next one.</p>}
      </div>

      <div>
        {date && <>
          <p className="eyebrow mb-4">{formatDate(date, timezone)}</p>
          {slots === null ? <p className="text-sm text-cocoa/60">Loading times…</p> : slots.length === 0 ? <p className="text-sm text-cocoa/60">No times remain on this date.</p> : <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {slots.map((candidate) => <button key={candidate.start} type="button" onClick={() => setSlot(candidate)} aria-pressed={slot?.start === candidate.start} className={`rounded-xl border px-3 py-3 font-body text-sm transition-colors ${slot?.start === candidate.start ? 'border-bark bg-bark text-white' : 'border-cocoa/15 text-cocoa hover:border-bark'}`}>{slotTime(candidate, timezone)}</button>)}
          </div>}
        </>}

        {slot && <form onSubmit={book} className="mt-8 space-y-3">
          <p className="eyebrow">Your details</p>
          <label className="block text-sm text-cocoa">Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required className="mt-1 w-full rounded-xl border border-cocoa/15 px-4 py-3" /></label>
          <label className="block text-sm text-cocoa">Email<input type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required className="mt-1 w-full rounded-xl border border-cocoa/15 px-4 py-3" /></label>
          <label className="block text-sm text-cocoa">Phone<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} className="mt-1 w-full rounded-xl border border-cocoa/15 px-4 py-3" /></label>
          <label className="block text-sm text-cocoa">Anything we should know?<textarea value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })} rows="3" className="mt-1 w-full rounded-xl border border-cocoa/15 px-4 py-3" /></label>
          {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
          <button type="submit" disabled={state === 'booking'} className="btn-primary w-full disabled:cursor-wait disabled:opacity-60">{state === 'booking' ? 'Holding your time…' : demo ? 'Try the demo booking' : 'Continue'}</button>
        </form>}
      </div>
    </div>
  )
}
