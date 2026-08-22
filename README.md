# Pulse

A small, self-hosted HTTP uptime monitor built for the Cloudflare Workers. It includes a public status page, a token-protected admin dashboard, D1 history, one-minute Cron checks, and direct SMTP alerts over TLS.

## What it does

- Monitors up to 20 HTTP or HTTPS endpoints every 1, 5, or 15 minutes.
- Checks an expected status range and, optionally, text in the first 64 KiB of a response.
- Records hourly aggregates, 30-day uptime, incidents, and admin audit activity in D1.
- Sends down and recovery mail through your SMTP provider on port 465 or 587.
- Serves the React status page and Hono API from one Worker and one custom domain.
- Retains metrics and audit logs for 90 days and sent-notification records for 30 days.

The public API exposes only an endpoint's origin, never its path, query string, detailed check error, admin logs, or configuration.

## Reliability model

No single-location uptime monitor can promise zero false positives. Pulse is deliberately conservative:

- Three consecutive failures confirm an outage and open an incident.
- Two consecutive successes confirm recovery.
- A failed recovery check immediately returns the incident to `down`.
- Late checks become `unknown` instead of displaying stale health as current.
- Network, DNS, TLS, HTTP status, timeout, and optional body checks are all handled as check results.
- SMTP delivery is independent of incident recording and retries with backoff, so mail trouble does not erase outage data.
- A D1 lease prevents overlapping Cron runs; checks run four at a time to keep resource use bounded.

Incident start time is the first failed check in the confirming sequence. Availability is observed from Cloudflare's network, not from every visitor location.

## Stack

- Hono API and scheduled Worker
- React 19, Vite, and Tailwind CSS 4
- Cloudflare D1 and Cron Triggers
- Worker-native `cloudflare:sockets` SMTP client; no Node server and no Nodemailer
- Vitest running inside Cloudflare's Workers test runtime

## Local setup

Requirements: Node.js 22 or newer and a Cloudflare account for deployment.

```sh
npm install
cp .dev.vars.example .dev.vars
npm run cf-typegen
npm run db:migrate:local
npm run dev
```

Edit `.dev.vars` with development-only values:

```dotenv
ADMIN_TOKEN="use-a-long-random-value"
SMTP_USERNAME="your-smtp-username"
SMTP_PASSWORD="your-smtp-password"
```

Also update the non-secret SMTP settings in `wrangler.jsonc`:

- `SITE_NAME`
- `SMTP_HOST`
- `SMTP_PORT` (`465` for implicit TLS or `587` for STARTTLS)
- `SMTP_FROM`
- `SMTP_TO`

The SMTP server must support authenticated `AUTH PLAIN` or `AUTH LOGIN`. Cloudflare blocks outbound port 25, so it is intentionally unsupported. Your provider may still charge for mail; Pulse itself does not require Cloudflare Email Sending.

Run all checks with:

```sh
npm run check
```

## Deploy

Authenticate and create the D1 database:

```sh
npx wrangler login
npx wrangler d1 create uptime-monitoring
```

Copy the `database_id` printed by Wrangler into the existing `DB` entry in `wrangler.jsonc`. Then configure the three encrypted Worker secrets:

```sh
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put SMTP_USERNAME
npx wrangler secret put SMTP_PASSWORD
```

Use a generated admin token of at least 32 random bytes. Apply the schema and deploy:

```sh
npm run db:migrate:remote
npm run deploy
```

The Cron trigger is declared in `wrangler.jsonc`, so deployment installs the one-minute schedule. Open `https://uptime-monitoring.<your-subdomain>.workers.dev/#admin` and enter the admin token to add the first monitor.

### Custom domain

In the Cloudflare dashboard, open **Workers & Pages → uptime-monitoring → Settings → Domains & Routes → Add → Custom Domain** and choose a hostname in a zone on the same account, such as `status.example.com`. Cloudflare provisions and renews TLS automatically.

## SMTP choices

Use any authenticated SMTP relay that accepts connections from Cloudflare Workers on 465 or 587. Transactional providers such as Amazon SES, Mailgun, Postmark, Brevo, or SMTP2GO commonly provide SMTP credentials; pricing and free allowances change, so check the provider's current terms. A personal mailbox relay can work, but app-password policies and automated-mail restrictions make a transactional relay more dependable.

Only one recipient is supported by design. Keeping SMTP credentials in Worker secrets and the mail envelope simple reduces code, storage, and deliverability surprises.

## Cost and limits

The default ceiling of 20 monitors is an application safety guard. At one-minute intervals that is at most 28,800 outbound checks per day, plus 1,440 scheduled invocations. Hourly aggregation avoids storing every response as a database row. Before raising the ceiling, compare your actual Workers requests, CPU, subrequests, and D1 row usage with Cloudflare's current free-plan limits.

The status response is browser-cacheable for 30 seconds. Admin requests are never exposed by the public API. Cloudflare structured logs record request metadata and scheduler events; D1 stores the last 100 admin audit entries shown in the dashboard.

## Useful commands

```sh
npm run dev                 # local Worker and UI
npm test                    # Workers-runtime tests
npm run lint                # ESLint
npm run build               # type-check and production bundle
npm run db:migrate:local    # apply local D1 migrations
npm run db:migrate:remote   # apply production D1 migrations
npm run deploy              # build and deploy
```
