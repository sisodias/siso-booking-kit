# SISO booking module

This is the reusable SISO booking boundary selected from the MIT-licensed
[`zainalshanan/thebookingkit`](https://github.com/zainalshanan/thebookingkit)
project and maintained in the SISO fork
[`sisodias/siso-booking-kit`](https://github.com/sisodias/siso-booking-kit).
The distributable SISO module is on the [`siso-module` branch](https://github.com/sisodias/siso-booking-kit/tree/siso-module)
at the recorded ref in `upstream-manifest.json`.
The module keeps the host's service catalogue, availability rules, payment
policy, logo, and contact details outside the shared code.

## What it provides

- Pure JavaScript, timezone-aware slot computation using `Intl`.
- A React 18 calendar/form adapter with a small JSON API contract.
- Cloudflare Pages-compatible handlers for config, availability, reservations,
  cancellations, Stripe Checkout webhooks, and a bearer-protected operator
  screen/API for bookings and date-specific availability overrides.
- A D1 schema whose final reservation write is one atomic overlap-guarded
  `INSERT ... SELECT ... WHERE NOT EXISTS` statement.
- Optional Stripe Checkout deposits and Resend confirmation/cancellation mail.
- Private `.ics` calendar exports for confirmed or pending appointments, protected by the booking management token.
- A D1-backed operator calendar: close a date, replace its hours, or cancel an
  upcoming booking without exposing database credentials to the browser.
- Honest readiness health: a host with missing D1 or required payment secrets
  reports `configured: false`, allowing an existing booking provider to remain
  the fallback.

## Host contract

```js
import { createBookingHandler } from './modules/siso-booking/server/booking-handler.js'

export const onRequest = createBookingHandler({
  providerId: 'example-studio',
  providerName: 'Example Studio',
  timezone: 'Europe/London',
  currency: 'gbp',
  paymentMode: 'deposit',
  services: [
    { id: 'consultation', name: 'Consultation', durationMinutes: 60, priceCents: 7000, depositCents: 3500, currency: 'gbp' },
  ],
  weeklyAvailability: [{ weekday: 1, start: '09:00', end: '17:00' }],
})
```

Cloudflare bindings:

```text
BOOKING_DB          D1 binding
STRIPE_SECRET_KEY   required when paymentMode is deposit
STRIPE_WEBHOOK_SECRET required for /api/booking/webhook
RESEND_API_KEY      optional confirmation mail
BOOKING_TO          optional operator inbox
BOOKING_FROM        optional verified sender
BOOKING_ADMIN_TOKEN required for /api/booking/admin
```

Apply `server/schema.sql` to the host's D1 database before the health endpoint
can become ready. Never put any of these values in `VITE_*` variables.

The optional operator screen is exported as `./react/BookingAdmin` and can be
mounted at a host-private route. It sends the admin token only as an in-memory
bearer header; it does not persist the token in local storage.

For a fresh SISO client installation, follow [`INSTALL.md`](./INSTALL.md).

## MelanoTresses host

MelanoTresses mounts the module through `src/modules/booking/` and
`functions/api/booking/[[path]].js`. The own flow is selected only when its
readiness probe passes. Until the client supplies the payment/database setup,
the page continues into the Acuity flow rather than accepting an unprotected
or unpaid booking. `?demo` exercises the module UI without creating a record.
