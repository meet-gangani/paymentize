# paymentize

Express + Puppeteer service that drives the Superprofile / Cashfree checkout to mint UPI payment
QRs on demand, keeps each browser session alive in the background regenerating the QR before it
expires, and records every payment in MongoDB. Ships with a live admin panel.

## Setup

```bash
npm install
cp .env.example .env      # then set MONGO_URI
npm run dev               # or npm start
```

`.env` is read by Node itself (`--env-file-if-exists`), so there is no `dotenv` dependency.
See [.env.example](.env.example) for every tunable.

## API

### `POST /generate-payment`

```json
{ "deviceId": "abc-123", "manufacturer": "Samsung", "modelNo": "S21" }
```

Opens a fresh browser under a new uuidv4 `paymentId`, walks the checkout, and returns the first
decoded QR. **The browser stays open** afterwards, regenerating the QR every 4m30s.

```json
{ "paymentId": "…", "qrValue": "upi://pay?pa=…", "expireAt": "2026-08-31T18:55:00.000Z" }
```

Takes ~20s — the response cannot exist before the QR does. Returns `503` once `MAX_SESSIONS`
browsers are already open.

### `GET /get-payment-status?paymentId=<uuid>`

Returns the **current** QR, which will differ from the original if it has since been regenerated.
Also resets that session's idle timer.

```json
{ "paymentId": "…", "qrValue": "upi://pay?pa=…", "expireAt": "…", "status": "pending" }
```

### `PUT /payment-finalize`

```json
{ "paymentId": "…", "status": "success", "message": "confirmed by app" }
```

Closes that session's browser and records the outcome. Idempotent — finalizing an already-final
payment returns the existing record with `alreadyFinal: true` rather than erroring.

## curl examples

Bash / Git Bash. For PowerShell or cmd see the note at the end.

```bash
BASE=http://localhost:8080
```

**1. Create a payment** (takes ~20s — the QR has to be minted first):

```bash
curl -X POST $BASE/generate-payment \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"dev-001","manufacturer":"Samsung","modelNo":"Galaxy S21"}'
```

```json
{
  "paymentId": "28a5dc35-34b8-40d4-bbdb-cf828f2e2015",
  "qrValue": "upi://pay?pa=cf.cosmofeed12@cashfreensdlpb&pn=COSMOFEED&tr=6369638357&am=1.00&cu=INR&mode=00&purpose=00&mc=8241&tn=6369638357",
  "expireAt": "2026-08-31T15:46:30.199Z"
}
```

**2. Poll for the current QR** — returns a *new* `qrValue` and `expireAt` after each 4m30s
regeneration, and resets that session's idle timer:

```bash
PAYMENT_ID=28a5dc35-34b8-40d4-bbdb-cf828f2e2015

curl "$BASE/get-payment-status?paymentId=$PAYMENT_ID"
```

```json
{
  "paymentId": "28a5dc35-34b8-40d4-bbdb-cf828f2e2015",
  "qrValue": "upi://pay?pa=cf.cosmofeed12@cashfreensdlpb&pn=COSMOFEED&tr=6369660309&am=1.00&cu=INR&…",
  "expireAt": "2026-08-31T15:51:04.525Z",
  "status": "pending"
}
```

**3. Finalize** — closes that session's browser:

```bash
curl -X PUT $BASE/payment-finalize \
  -H 'Content-Type: application/json' \
  -d "{\"paymentId\":\"$PAYMENT_ID\",\"status\":\"success\",\"message\":\"confirmed by app\"}"
```

```json
{
  "paymentId": "28a5dc35-34b8-40d4-bbdb-cf828f2e2015",
  "status": "success",
  "message": "confirmed by app",
  "finalizedAt": "2026-08-31T15:47:48.129Z",
  "alreadyFinal": false
}
```

Calling it again returns the same record with `"alreadyFinal": true` — the second call does not
overwrite the first.

**Admin stats** (what the panel polls):

```bash
curl $BASE/admin/stats.json
```

**Health check:**

```bash
curl $BASE/test
```

### One-liner: create then immediately poll

```bash
PAYMENT_ID=$(curl -s -X POST $BASE/generate-payment \
  -H 'Content-Type: application/json' \
  -d '{"deviceId":"dev-001","manufacturer":"Samsung","modelNo":"Galaxy S21"}' \
  | python -c "import json,sys; print(json.load(sys.stdin)['paymentId'])")

curl "$BASE/get-payment-status?paymentId=$PAYMENT_ID"
```

### Error responses

| Call | Status | Body |
|---|---|---|
| `POST` with fields missing | `400` | `{"error":"Missing required field(s): deviceId, manufacturer, modelNo"}` |
| `GET` without `paymentId` | `400` | `{"error":"Missing required query parameter: paymentId"}` |
| `PUT` with a bad status | `400` | `{"error":"status must be one of: success, failed"}` |
| Unknown `paymentId` | `404` | `{"error":"Unknown paymentId: …"}` |
| All browser slots busy | `503` | `{"error":"Session limit reached (20 browsers already open)"}` |

### PowerShell / cmd

PowerShell aliases `curl` to `Invoke-WebRequest`, which takes different arguments. Use `curl.exe`
and double quotes with escaped inner quotes:

```powershell
curl.exe -X POST http://localhost:8080/generate-payment `
  -H "Content-Type: application/json" `
  -d "{\"deviceId\":\"dev-001\",\"manufacturer\":\"Samsung\",\"modelNo\":\"Galaxy S21\"}"
```

## Admin panel

`http://localhost:8080/admin` — EJS page polling `/admin/stats.json` every 2s. Cards for open
browsers (live, from memory), successes, failures and pending; below, the 100 most recent payments.

## How sessions end

A session closes exactly once, for one of four reasons:

1. **Payment settles** — detected from Cashfree's reconciliation poll, not the DOM.
2. **`payment-finalize`** — the client decides.
3. **Idle timeout** — 20 min with no *outside* activity. Only the session that exceeded its own
   window closes; other browsers are untouched.
4. **Shutdown** — `SIGINT`/`SIGTERM` closes every browser before exit.

"Outside activity" means a `get-payment-status` poll or a real Cashfree status transition.
Automatic QR regeneration deliberately does **not** count: it runs every 4m30s, so if it reset the
clock the 20 minute timeout could never elapse.

On boot, any payment left `pending` with `browserOpen: true` is from a previous process whose
browsers died with it; those are swept to `failed` so the admin counts stay honest.

## Notes on the checkout automation

The Puppeteer code in [src/services/checkout.service.js](src/services/checkout.service.js) contains
several non-obvious workarounds, each derived from observing the live site. They are commented in
place; the short version:

- The "Click to see QR" button enters the DOM before its handler binds, so the first click is
  swallowed — it retries until the QR renders.
- A real mouse click misses inside the nested cross-origin Cashfree iframe; an in-page
  `el.click()` is required.
- There is no refresh control while a QR is displayed. Reloading the UPI iframe is what mints a
  fresh transaction.
- Payment status comes from the `…/checkouts/payments/reconciliations/…` XHR, not from any element
  on the page.

Every `generate-payment` creates a real ₹1.00 Cashfree session, and each regeneration mints a new
transaction ref. Nothing is charged unless someone actually pays.
