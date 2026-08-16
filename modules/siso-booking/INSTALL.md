# Installing the SISO booking module

This is the host-install contract for a React 18+ Cloudflare Pages site. The
module owns slot math, reservation correctness, payment transitions, and the
operator API. The host owns the service catalogue, brand UI, timezone, contact
details, and the fallback policy.

The maintained fork is [`sisodias/siso-booking-kit`](https://github.com/sisodias/siso-booking-kit),
branch [`siso-module`](https://github.com/sisodias/siso-booking-kit/tree/siso-module). A host can
vendor `modules/siso-booking` from that ref or copy the module into its own repository.

## 1. Add the host adapter

Create a host config and a Pages Function wrapper:

```js
// functions/api/booking/[[path]].js
import { createBookingHandler } from '@siso/booking-module/server'
import { BOOKING_CONFIG } from '../../../src/modules/booking/config.js'

export const onRequest = createBookingHandler(BOOKING_CONFIG)
```

The config must provide a stable `providerId`, an IANA `timezone`, services with
durations/prices, weekly availability, and the host's cancellation/payment
policy. Keep client facts in this adapter rather than the reusable module.

## 2. Bind D1 and apply the schema

Create one isolated database for the host, bind it as `BOOKING_DB`, and apply
`server/schema.sql` before enabling the native flow:

```bash
npx wrangler d1 create <client>-booking
npx wrangler d1 execute <client>-booking --remote --file=modules/siso-booking/server/schema.sql
```

The schema contains bookings, idempotency/webhook receipts, and operator-managed
date overrides. Never expose the D1 binding or a database credential to client
JavaScript.

## 3. Add server-only secrets

Run these commands from a trusted terminal and enter each value only at the
hidden prompt. Do not put them in `VITE_*` variables, GitHub files, or this
repository:

```bash
npx wrangler pages secret put STRIPE_SECRET_KEY --project-name <client-pages-project>
npx wrangler pages secret put STRIPE_WEBHOOK_SECRET --project-name <client-pages-project>
npx wrangler pages secret put BOOKING_ADMIN_TOKEN --project-name <client-pages-project>
npx wrangler pages secret put RESEND_API_KEY --project-name <client-pages-project>
npx wrangler pages secret put BOOKING_FROM --project-name <client-pages-project>
npx wrangler pages secret put BOOKING_TO --project-name <client-pages-project>
```

`RESEND_*` values are optional if the host deliberately keeps manual contact
follow-up. Stripe and the admin token are required for a production host using
deposits and the operator screen.

## 4. Mount the UI adapters

Use `BookingCalendar` for the public flow and `BookingAdmin` behind a host
private route. The admin component sends `BOOKING_ADMIN_TOKEN` as a bearer
header from memory only; it does not persist the token in local storage.

Do not show the admin route in the public navigation. Protect the API with the
server token and, where available, a second Cloudflare Access or host-auth
boundary.

## 5. Readiness and cutover

Verify these endpoints without printing secret values:

```bash
curl -fsS https://<client-domain>/api/booking/health
curl -fsS https://<client-domain>/api/booking/config
```

The public host should switch from its existing provider only when health reports
`configured: true`, `database: true`, and the expected payment mode. Never use
`BOOKING_PAYMENT_MODE=manual` in production; that mode exists only for review
environments. Run a Stripe test payment, a webhook completion, an email check, a
conflict check, a cancellation check, and an operator closed-date check before
removing the existing fallback.

Manual or confirmed reservation responses include a private `calendarUrl`. The
host UI can render it as an `Add to calendar` download; the endpoint returns a
token-protected iCalendar file without exposing customer details. Payment flows
should show the link after the webhook changes the booking to confirmed.

## Host release checklist

- [ ] Client-approved service durations, prices, hours, buffers, notice, and blackout rules.
- [ ] D1 schema applied to the intended host database.
- [ ] Stripe Checkout and webhook secrets configured and tested.
- [ ] Verified Resend sender/inbox configured, if automated mail is required.
- [ ] Strong admin token configured and delivered through a secure channel.
- [ ] Public domain, DNS, and email records checked before cutover.
- [ ] Native reservation, idempotency, conflict, cancellation, payment, and fallback smokes recorded.
- [ ] Production cutover explicitly approved; preview and production projects kept separate.
