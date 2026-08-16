import { useState } from 'react'

function adminUrl(endpoint, path) {
  return `${endpoint.replace(/\/$/, '')}${path}`
}

async function adminRequest(endpoint, path, token, options = {}) {
  const response = await fetch(adminUrl(endpoint, path), {
    ...options,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      ...(options.body ? { 'content-type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(body?.error || `Admin request failed (${response.status})`)
    error.status = response.status
    throw error
  }
  return body
}

function isoDatePlus(days) {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

function formatDateTime(value, timezone) {
  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(new Date(value))
}

function money(cents, currency = 'GBP') {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency: String(currency || 'GBP').toUpperCase() }).format(Number(cents || 0) / 100)
}

export function BookingAdmin({
  endpoint = '/api/booking',
  timezone = 'UTC',
  providerName = 'Booking administration',
}) {
  const [tokenInput, setTokenInput] = useState('')
  const [token, setToken] = useState('')
  const [bookings, setBookings] = useState([])
  const [overrides, setOverrides] = useState([])
  const [form, setForm] = useState({ date: '', start: '09:00', end: '17:00', unavailable: false, note: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  async function loadData(authToken) {
    setLoading(true)
    setError('')
    try {
      const from = new Date().toISOString()
      const [bookingBody, overrideBody] = await Promise.all([
        adminRequest(endpoint, `/admin/bookings?from=${encodeURIComponent(from)}`, authToken),
        adminRequest(endpoint, `/admin/availability?from=${isoDatePlus(0)}&to=${isoDatePlus(90)}`, authToken),
      ])
      setBookings(bookingBody.bookings || [])
      setOverrides(overrideBody.overrides || [])
      setMessage('Calendar loaded.')
    } catch (cause) {
      if (cause.status === 401) setToken('')
      setError(cause.message || 'Could not load the booking calendar.')
    } finally {
      setLoading(false)
    }
  }

  async function signIn(event) {
    event.preventDefault()
    const nextToken = tokenInput.trim()
    if (!nextToken) {
      setError('Enter the operator token to continue.')
      return
    }
    setToken(nextToken)
    await loadData(nextToken)
  }

  async function saveOverride(event) {
    event.preventDefault()
    setError('')
    setMessage('')
    try {
      await adminRequest(endpoint, '/admin/availability', token, {
        method: 'POST',
        body: JSON.stringify(form),
      })
      setForm({ date: '', start: '09:00', end: '17:00', unavailable: false, note: '' })
      await loadData(token)
      setMessage('Availability override saved.')
    } catch (cause) {
      setError(cause.message || 'Could not save that override.')
    }
  }

  async function removeOverride(id) {
    setError('')
    setMessage('')
    try {
      await adminRequest(endpoint, `/admin/availability/${encodeURIComponent(id)}`, token, { method: 'DELETE' })
      await loadData(token)
      setMessage('Availability override removed.')
    } catch (cause) {
      setError(cause.message || 'Could not remove that override.')
    }
  }

  async function cancelBooking(bookingId) {
    if (!window.confirm('Cancel this appointment?')) return
    setError('')
    setMessage('')
    try {
      await adminRequest(endpoint, '/admin/bookings', token, {
        method: 'POST',
        body: JSON.stringify({ bookingId }),
      })
      await loadData(token)
      setMessage('Appointment cancelled.')
    } catch (cause) {
      setError(cause.message || 'Could not cancel that appointment.')
    }
  }

  if (!token) {
    return (
      <div className="mx-auto max-w-xl rounded-3xl border border-cocoa/10 bg-white p-8 shadow-sm">
        <p className="eyebrow">Private operator area</p>
        <h1 className="mt-3 font-head text-3xl text-cocoa">{providerName}</h1>
        <p className="mt-3 text-sm leading-relaxed text-cocoa/70">
          Enter the server-issued booking admin token. It stays in this browser tab and is never saved to local storage.
        </p>
        <form onSubmit={signIn} className="mt-6 space-y-3">
          <label className="block text-sm text-cocoa">
            Admin token
            <input
              type="password"
              value={tokenInput}
              onChange={(event) => setTokenInput(event.target.value)}
              autoComplete="off"
              className="mt-1 w-full rounded-xl border border-cocoa/15 px-4 py-3"
            />
          </label>
          {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
          <button type="submit" disabled={loading} className="btn-primary w-full disabled:opacity-60">
            {loading ? 'Checking token…' : 'Open booking calendar'}
          </button>
        </form>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="eyebrow">Private operator area</p>
          <h1 className="mt-2 font-head text-3xl text-cocoa">{providerName}</h1>
        </div>
        <button type="button" onClick={() => setToken('')} className="btn-ghost">Sign out</button>
      </div>

      {error && <p role="alert" className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-900">{error}</p>}
      {message && <p role="status" className="rounded-xl bg-sand px-4 py-3 text-sm text-cocoa">{message}</p>}

      <section className="rounded-3xl border border-cocoa/10 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Calendar controls</p>
            <h2 className="mt-2 font-head text-2xl text-cocoa">Block or open a date</h2>
          </div>
          <p className="text-sm text-cocoa/60">Dates use {timezone}.</p>
        </div>
        <form onSubmit={saveOverride} className="mt-5 grid gap-3 md:grid-cols-[1.1fr_0.8fr_0.8fr_1.4fr_auto] md:items-end">
          <label className="block text-sm text-cocoa">Date<input type="date" required value={form.date} onChange={(event) => setForm({ ...form, date: event.target.value })} className="mt-1 w-full rounded-xl border border-cocoa/15 px-3 py-2.5" /></label>
          <label className="block text-sm text-cocoa">Start<input type="time" disabled={form.unavailable} value={form.start} onChange={(event) => setForm({ ...form, start: event.target.value })} className="mt-1 w-full rounded-xl border border-cocoa/15 px-3 py-2.5 disabled:bg-cocoa/5" /></label>
          <label className="block text-sm text-cocoa">End<input type="time" disabled={form.unavailable} value={form.end} onChange={(event) => setForm({ ...form, end: event.target.value })} className="mt-1 w-full rounded-xl border border-cocoa/15 px-3 py-2.5 disabled:bg-cocoa/5" /></label>
          <label className="block text-sm text-cocoa">Note<input value={form.note} onChange={(event) => setForm({ ...form, note: event.target.value })} placeholder="Optional reason" className="mt-1 w-full rounded-xl border border-cocoa/15 px-3 py-2.5" /></label>
          <button type="submit" className="btn-primary">Save</button>
          <label className="flex items-center gap-2 text-sm text-cocoa md:col-span-full"><input type="checkbox" checked={form.unavailable} onChange={(event) => setForm({ ...form, unavailable: event.target.checked })} /> Closed all day</label>
        </form>
        {overrides.length > 0 && <div className="mt-6 overflow-x-auto"><table className="w-full min-w-[40rem] text-left text-sm"><thead className="border-b border-cocoa/10 text-cocoa/60"><tr><th className="px-2 py-3 font-medium">Date</th><th className="px-2 py-3 font-medium">Hours</th><th className="px-2 py-3 font-medium">Note</th><th className="px-2 py-3" /></tr></thead><tbody>{overrides.map((item) => <tr key={item.id} className="border-b border-cocoa/5 last:border-0"><td className="px-2 py-3 text-cocoa">{item.date}</td><td className="px-2 py-3 text-cocoa">{item.unavailable ? 'Closed' : `${item.start}–${item.end}`}</td><td className="px-2 py-3 text-cocoa/70">{item.note || '—'}</td><td className="px-2 py-3 text-right"><button type="button" onClick={() => removeOverride(item.id)} className="text-xs font-semibold uppercase tracking-[0.12em] text-bark">Remove</button></td></tr>)}</tbody></table></div>}
      </section>

      <section className="rounded-3xl border border-cocoa/10 bg-white p-6 shadow-sm">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="eyebrow">Upcoming appointments</p>
            <h2 className="mt-2 font-head text-2xl text-cocoa">Bookings</h2>
          </div>
          <button type="button" onClick={() => loadData(token)} className="btn-ghost">Refresh</button>
        </div>
        {bookings.length === 0 ? <p className="mt-6 text-sm text-cocoa/60">No upcoming appointments.</p> : <div className="mt-6 overflow-x-auto"><table className="w-full min-w-[58rem] text-left text-sm"><thead className="border-b border-cocoa/10 text-cocoa/60"><tr><th className="px-2 py-3 font-medium">When</th><th className="px-2 py-3 font-medium">Customer</th><th className="px-2 py-3 font-medium">Status</th><th className="px-2 py-3 font-medium">Payment</th><th className="px-2 py-3" /></tr></thead><tbody>{bookings.map((booking) => <tr key={booking.id} className="border-b border-cocoa/5 last:border-0"><td className="px-2 py-3 text-cocoa">{formatDateTime(booking.starts_at, timezone)}</td><td className="px-2 py-3"><p className="text-cocoa">{booking.customer_name}</p><p className="text-xs text-cocoa/60">{booking.customer_email}</p></td><td className="px-2 py-3 capitalize text-cocoa">{booking.status}</td><td className="px-2 py-3 text-cocoa">{money(booking.payment_amount_cents, booking.currency)}</td><td className="px-2 py-3 text-right">{['pending', 'awaiting_payment', 'confirmed'].includes(booking.status) && <button type="button" onClick={() => cancelBooking(booking.id)} className="text-xs font-semibold uppercase tracking-[0.12em] text-bark">Cancel</button>}</td></tr>)}</tbody></table></div>}
      </section>
    </div>
  )
}
