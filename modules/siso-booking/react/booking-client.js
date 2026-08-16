async function requestJson(endpoint, path, options = {}) {
  const url = new URL(path, window.location.origin)
  const response = await fetch(`${endpoint.replace(/\/$/, '')}${url.pathname}${url.search}`, {
    ...options,
    headers: { accept: 'application/json', ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) {
    const error = new Error(body?.error || `Booking request failed (${response.status})`)
    error.status = response.status
    error.body = body
    throw error
  }
  return body
}

export function getBookingHealth(endpoint = '/api/booking') {
  return requestJson(endpoint, '/health')
}

export function getBookingAvailability(endpoint, params) {
  const query = new URLSearchParams(params)
  return requestJson(endpoint, `/availability?${query.toString()}`)
}

export function createBooking(endpoint, payload, idempotencyKey) {
  return requestJson(endpoint, '/reservations', {
    method: 'POST',
    headers: { 'idempotency-key': idempotencyKey },
    body: JSON.stringify(payload),
  })
}

