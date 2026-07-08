# M-Pesa STK Push Payment Collector

A small tool for your business: enter a customer's phone number and an amount,
and it sends them an M-Pesa payment prompt (STK Push). The customer enters
their own PIN on their own phone to approve, and the money is deposited into
**your** Till / Pochi la Biashara account.

This uses Safaricom's official **Daraja API** — the same mechanism every
legitimate M-Pesa checkout in Kenya uses (Lipa Na M-Pesa Online).

## How it works

1. You open the page and type in the customer's number and the amount owed.
2. Your server calls Safaricom's `stkpush` endpoint.
3. Safaricom pushes a PIN prompt to the **customer's** phone.
4. The customer enters their own PIN to confirm they're paying for whatever
   they're buying from you.
5. Safaricom sends the result to your `/api/mpesa/callback` endpoint, and the
   page updates to show success/failure.

The money always lands in the account tied to your `BUSINESS_SHORT_CODE` —
never anywhere else — because that's what `PartyB` is set to in the request.

## Setup

### 1. Get Daraja credentials
- Create an account at https://developer.safaricom.co.ke
- Create an app, select **Lipa Na M-Pesa Online**, and grab your
  `Consumer Key` / `Consumer Secret`.
- Get your `Passkey` from the Lipa Na M-Pesa Online section.
- Note your Till number (Buy Goods) or PayBill number — this is your
  `BusinessShortCode`.

> **Important for Pochi la Biashara:** confirm with Safaricom / your Daraja
> portal that your Pochi la Biashara number has an associated shortcode
> usable for API access. If it doesn't, you may need to register/link a Till
> number to use STK Push programmatically, even though customers still see
> your business under your existing Pochi la Biashara identity.

### 2. Configure environment
```bash
cp .env.example .env
# then edit .env with your real Consumer Key, Secret, Passkey, shortcode, etc.
```

`CALLBACK_URL` must be a **public HTTPS URL** — Safaricom cannot reach
`localhost`. For local testing, use a tunnel like `ngrok http 3000` and put
the generated URL in `.env`.

### 3. Install and run
```bash
npm install
npm start
```

Then open `http://localhost:3000` (or your deployed URL).

### 4. Test in sandbox first
Leave `DARAJA_ENV=sandbox` and use Safaricom's test number `254708374149`
with any amount. Only switch to `DARAJA_ENV=production` with real production
credentials once you've confirmed everything works end-to-end.

## Files
- `server.js` — Express backend: initiates STK push, receives Safaricom's
  callback, exposes a status endpoint for the frontend to poll.
- `public/index.html` — the form you (the merchant) use to enter the
  customer's number and amount.
- `.env.example` — template for your credentials (copy to `.env`, never
  commit `.env` to version control).

## Security notes
- Keep `CONSUMER_SECRET` and `PASSKEY` server-side only — never expose them
  in frontend code.
- The in-memory `transactions` store in `server.js` resets on server
  restart. For production, replace it with a real database (e.g. Postgres,
  MongoDB) so you don't lose transaction records.
- Always trust the **callback** result over the initial STK push response —
  the initial response only confirms the prompt was sent, not that payment
  succeeded.
- Safaricom may retry callbacks; make sure your callback handler is
  idempotent if you upgrade from the in-memory store to a database (check
  `CheckoutRequestID` hasn't already been processed).
