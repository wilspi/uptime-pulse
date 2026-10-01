# Uptime Pulse

A small, self-hosted HTTP uptime monitor built for the Cloudflare Workers (works with Cloudflare's Free Plan). It includes a public status page, a token-protected admin dashboard, D1 history, one-minute Cron checks, and direct SMTP alerts over TLS.

## What it does

- Monitors up to 20 HTTP or HTTPS endpoints every 1, 5, or 15 minutes.
- Checks an expected status range and, optionally, text in the first 64 KiB of a response.
- Records hourly aggregates, 30-day uptime, incidents, and admin audit activity in D1.
- Sends down and recovery mail through your SMTP provider on port 465 or 587.
- Serves the React status page and Hono API from one Worker and one custom domain.
- Retains metrics and audit logs for 90 days and sent-notification records for 30 days.

The public API exposes only an endpoint's origin, never its path, query string, detailed check error, admin logs, or configuration.

## Yet another uptime monitor?

Uptime Pulse is a small, single-probe monitor built on Cloudflare Workers and D1. Each interval produces one check result from Cloudflare’s network; unlike UptimeRobot, Pingdom, or StatusCake, it does not provide configurable monitoring regions or simultaneous multi-location verification. It is intentionally simpler than status-page platforms such as Cachet or Statping-ng, requires no Node.js server to manage, and has no mandatory Uptime Pulse subscription.

The self-hosted editions of Uptime Kuma, Statping-ng, and Healthchecks are excellent, but require you to operate a server, application process, or container. Uptime Pulse instead runs on Cloudflare’s serverless platform and can fit within the Free plan at low usage. Your SMTP relay, domain, or usage beyond Cloudflare’s included limits may still incur costs.

## Reliability model

No single-location uptime monitor can promise zero false positives. Uptime Pulse is deliberately conservative:

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
SITE_NAME="Uptime Pulse"
SMTP_HOST="smtp.example.com"
SMTP_PORT="465"
SMTP_FROM="alerts@example.com"
SMTP_TO="you@example.com"
ADMIN_TOKEN="use-a-long-random-value"
SMTP_USERNAME="your-smtp-username"
SMTP_PASSWORD="your-smtp-password"
```

The SMTP server must support authenticated `AUTH PLAIN` or `AUTH LOGIN`. Cloudflare blocks outbound port 25, so it is intentionally unsupported. Your provider may still charge for mail; Uptime Pulse itself does not require Cloudflare Email Sending.

Run all checks with:

```sh
npm run check
```

## Deploy

Authenticate with Cloudflare:

```sh
npx wrangler login
```

The D1 binding intentionally omits `database_id`; current Wrangler versions automatically provision and retain the binding without requiring an account-specific ID in Git. Upload the ignored `.dev.vars` values as encrypted Worker secrets:

```sh
npx wrangler secret bulk .dev.vars
```

Use a generated admin token of at least 32 random bytes. 

Apply the schema and deploy:

```sh
npm run db:migrate:remote
npm run deploy
```

The Cron trigger is declared in `wrangler.jsonc`, so deployment installs the one-minute schedule. Open `https://uptime-pulse.<your-subdomain>.workers.dev/#admin` and enter the admin token to add the first monitor.

### Custom domain

In the Cloudflare dashboard, open **Workers & Pages → uptime-pulse → Settings → Domains & Routes → Add → Custom Domain** and choose a hostname in a zone on the same account, such as `status.example.com`. Cloudflare provisions and renews TLS automatically.

## SMTP choices

Use any authenticated SMTP relay that accepts connections from Cloudflare Workers on 465 or 587. Transactional providers such as Amazon SES, Mailgun, Postmark, Brevo, or SMTP2GO commonly provide SMTP credentials; pricing and free allowances change, so check the provider's current terms. A personal mailbox relay can work, but app-password policies and automated-mail restrictions make a transactional relay more dependable.

Only one recipient is supported by design. Keeping SMTP credentials in Worker secrets and the mail envelope simple reduces code, storage, and deliverability surprises.

## Cost and limits

The default ceiling of 20 monitors is an application safety guard. At one-minute intervals that is at most 28,800 outbound checks per day, plus 1,440 scheduled invocations. Hourly aggregation avoids storing every response as a database row. Failure diagnostics are stored as runs of consecutive failures with the same cause, so healthy monitors add no extra D1 writes; an outage costs about one write per failed check. Hourly aggregates and failure runs are retained for 90 days. Each scheduled check uses two subrequests (the HTTP check and one D1 batch), keeping a run of 20 monitors under the free plan's 50-subrequest limit; monitors that follow redirects are budgeted extra, and any that do not fit are checked first in the next minute. Before raising the ceiling, compare your actual Workers requests, CPU, subrequests, and D1 row usage with Cloudflare's current free-plan limits.

The status response is browser-cacheable for 30 seconds. Admin requests are never exposed by the public API. Cloudflare structured logs record request metadata and scheduler events; D1 stores the last 100 admin audit entries shown in the dashboard.

## Downtime diagnostics

Click any hourly block to see why it is green (all checks passed), yellow (at least 80% but fewer than 100% passed), red (fewer than 80% passed), or gray (no checks). Blocks are fixed hourly windows, including the current partial hour. Details include check counts, response times (average, fastest, slowest), confirmed downtime in the hour, and a timeline of what failed: each run of consecutive failures with the same cause, how many checks it covered, and when checks passed again. Yellow blocks without a confirmed incident are called out as brief or intermittent failures. Times use the browser's local timezone. Counts describe monitoring checks, not customer traffic.

Sign in through Manage and reopen a block for raw errors, expected status and timeout, selected diagnostic headers, and a response excerpt from the first failure of each run. Admins also see when down and recovery alerts were emailed (or why they failed) and any monitor changes made in that hour. Admin monitor rows offer History, and recent incidents open their full timeline, including when the outage was confirmed. Public endpoints never include response bodies, raw errors, cookies, monitor settings, or private endpoint paths. Response excerpts may contain sensitive service data, so access requires the admin token. Binary bodies and successful response bodies are not saved.

## Sharing and status pages

Under Manage → Sharing you control who sees what:

- **Show monitors on homepage** — when off, the homepage and `/api/status` list no monitors. When on, only monitors with **Show on homepage** ticked are listed. New monitors start hidden.
- **Status pages** — each page has its own link (`/s/<link>`), title, optional description, and a chosen set of monitors with optional display names. Visitors see only that page's monitors and can open details only for them. Pages do not link to the homepage or the admin area.

Links can be custom (`/s/acme`), but short names are easy to guess; **Generate** appends random characters (`/s/acme-x7k2p9qa`). Changing a page's link or turning the page off stops the old link working immediately, although browsers may show cached data for up to a minute. Shared pages send `X-Robots-Tag: noindex` and `Referrer-Policy: no-referrer`.

A link hides a page; it does not authenticate visitors. Anyone who has the link can see that page and only that page.

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

## License

Uptime Pulse is available under the [MIT License](LICENSE).
