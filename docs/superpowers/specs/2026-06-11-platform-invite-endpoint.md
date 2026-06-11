# Platform spec — `POST /v0/invite`

**Date:** 2026-06-11
**Status:** handover — for the `FailproofAI/platform` repo (closed-source api-server, Rust)
**Companion PR:** `FailproofAI/failproofai#435` — UI + Next.js proxy already shipped

## Goal

Let an authenticated dashboard user send invite emails to a list of friends
from `failproof.ai` (with the sender Cc'd on every outbound), reusing the
exact same email-sending infrastructure that backs the OTP flow
(`POST /v0/auth/login/request`).

The dashboard already ships the UI and the Next.js proxy. As soon as this
endpoint exists upstream, the `invite a friend` button on
`/audit#come-back-better` starts dispatching real emails.

## Contract

### Request

```
POST /v0/invite HTTP/1.1
Authorization: Bearer <access_token>
Content-Type: application/json

{
  "to": ["alice@example.com", "bob@example.org"]
}
```

- **Auth:** standard Bearer access token. 401 if missing/invalid.
- **`to`:** array of email strings. Server should:
  - lowercase each
  - drop duplicates
  - drop entries that don't match a basic email regex
  - enforce **MAX_RECIPIENTS = 10 per call** (return `400 too_many_recipients`
    above that — the dashboard pre-validates this but defense-in-depth)
  - drop the sender's own email if it appears (looked up from token claims)

### Response — `200 OK`

```json
{
  "sent":   ["alice@example.com"],
  "failed": ["bob@example.org"]
}
```

- **`sent`:** recipients dispatched to the email provider successfully.
- **`failed`:** recipients the provider rejected synchronously (malformed,
  bounced address known from suppression list, rate-limited, etc.). Async
  bounces don't need to come back through this endpoint.

### Error responses

| Status | Code                  | When |
|--------|-----------------------|------|
| 400    | `validation_error`    | body not JSON, missing `to`, no valid recipients after normalisation |
| 400    | `too_many_recipients` | `to.length > 10` after dedup |
| 401    | `unauthorized`        | missing / expired token |
| 429    | `rate_limited`        | per-user invite-send rate cap exceeded; include `retry_after_secs` |
| 502    | `upstream_unreachable`| email provider down |
| 5xx    | `internal_error`      | otherwise |

Error body shape matches the existing `/v0/auth/*` routes:
`{ code: string, message: string, retry_after_secs?: number }`.

## Email composition

The api-server already has an internal `EmailHelper` (or equivalent) that
sends the OTP email. Add an `InviteTemplate` that uses the same helper.

### Headers

| Header | Value |
|---|---|
| `From`     | `invite@failproof.ai` (or whatever sender the OTP flow uses — pick the one with verified DKIM/SPF) |
| `Reply-To` | sender's email (so replies go to the friend who invited them, not a no-reply inbox) |
| `To`       | each recipient (one email per recipient — *not* a single message with N To's; otherwise replies + bounces collide and recipients see each other's addresses) |
| `Cc`       | **sender's email** (from token claims) — so the recipient sees who invited them and the sender gets a copy in their inbox |
| `Subject`  | `your AI coding agent has a personality. want yours?` |

The Cc requirement is the load-bearing detail — that's how the dashboard
user gets confidence the invite was sent ("check your inbox; you should
see your own copy") and how the recipient verifies the message isn't a
random transactional email ("oh, this is from $sender").

### Body (suggested copy — adjust to whatever brand voice the api-server team prefers)

```
hey,

{sender_email} just ran a failproofai audit on their AI coding agent and
the report told them they're "the optimist" — apparently their agent
retries failed commands with conviction.

(yours probably has a personality too. wanna see what it is?)

audit yours in 30 seconds, no signup required:
https://befailproof.ai/audit

— failproof team
```

- Render the sender's email inline (only place the recipient sees it
  explicitly aside from `Cc`).
- The URL is fixed for now; later we may want a referral-tracked variant
  like `https://befailproof.ai/audit?ref=<sender_user_id>` if/when we wire
  perks fulfillment.

### One message per recipient

Send N separate emails, not one to N addresses. Reasons:

1. **Privacy.** Bob shouldn't see Alice's email.
2. **Per-recipient bounces.** Async bounces from the provider tag the
   specific recipient that failed, not the whole batch.
3. **Reply-To routing.** The sender's `Reply-To` only makes sense per
   recipient — Alice's reply shouldn't land in Bob's thread.

## Behaviour

### Auth

- Extract sender's `user_id` + `email` from the access-token claims (same
  flow as `/v0/auth/me`).
- Sender email is used for `Cc` + `Reply-To` + body template.
- If the token has no email claim (shouldn't happen, but defense), 401.

### Validation order

1. Token valid + has `email` claim → else 401.
2. Body is JSON object → else 400 `validation_error`.
3. `to` is an array → else 400 `validation_error`.
4. Normalise (lowercase, dedup, regex, strip sender) → reject 400
   `validation_error` with `message: "no valid recipients"` if the
   resulting list is empty.
5. Reject 400 `too_many_recipients` if normalised list > 10.

### Rate limiting

Apply the same per-user invite-send cap that protects the OTP route:

- **Soft cap:** N invites/user/hour. Below the cap, accept and send.
- **Hard cap:** M invites/user/day. At/above, 429 with `retry_after_secs`.

Recommend `N=30/hr, M=100/day` to start — that's high enough that real
"share with friends" never hits it, low enough that a compromised account
can't spam-blast.

### Dispatch

For each normalised recipient:

1. Render the invite template.
2. Hand to the existing email helper that backs the OTP route.
3. On synchronous success → push to `sent[]`.
4. On synchronous rejection (rate-limit, bounce, malformed) → push to
   `failed[]` and continue with the rest.

Return when all recipients have been attempted. Aggregate timeout: 30s.

### Idempotency / dedupe

Not needed for v1. If the same `(sender, recipient)` pair is hit
repeatedly, the rate-limiter will eventually 429. Track it in telemetry
but don't refuse at the route layer.

## Telemetry

Emit one event per invite call:

```
event:      invite_send_attempted
properties: { user_id, recipient_count, sent_count, failed_count, duration_ms }
```

And one per recipient:

```
event:      invite_dispatched
properties: { user_id, to_domain, status: "sent" | "failed", failure_reason? }
```

`to_domain` (not the full email) gives us reach metrics without dumping
PII into the telemetry sink.

## Non-goals (explicitly out of scope for v1)

- **Invite tracking** — no DB rows for "alice invited bob on $date". The
  Cc handles "did the invite actually go" verification; entitlement /
  perks fulfillment is a follow-up spec.
- **Referral codes** — no `?ref=<user_id>` on the audit URL yet. Add when
  perks land.
- **Bounce handling** — async bounces processed via the provider's webhook
  go to the same place OTP bounces go. No special-case for invites.
- **Unsubscribe header** — list-unsubscribe is required for cold marketing
  email but invites are personal (one user → known friends). Add later if
  deliverability monitoring shows it's needed.

## Reference — what's already shipping in the dashboard

| File | Role |
|---|---|
| `app/api/audit/invite/route.ts` | Next.js proxy. POSTs to `/v0/invite` with the user's access token. Validates `to` (regex, dedup, ≤10, strip self) before forwarding. Maps upstream errors to user-friendly HTTP codes. |
| `lib/auth/api-server-client.ts#sendInvites` | Typed HTTP client wrapper. Returns `{ sent: string[], failed: string[] }`. |
| `app/audit/_components/invite-dialog.tsx` | Modal UI — textarea for comma/space/newline-separated emails, live valid/invalid counter, ≤10 client-side guard, submit button. |
| `app/audit/_components/come-back-better-section.tsx` | Wires the `invite a friend` button → opens InviteDialog (if authed) or AuthDialog → InviteDialog (if anon). Progress tracker removed; perks copy now says invites are sent from failproof.ai + Cc'd. |

## Acceptance checklist

For the upstream PR to be considered done:

- [ ] `POST /v0/invite` accepts the request shape above
- [ ] Sends one email per recipient with the sender Cc'd and Reply-To set
- [ ] Returns the documented `{sent, failed}` shape
- [ ] Validates and limits per the contract above
- [ ] Rate-limited per sender + per day
- [ ] Telemetry events emitted
- [ ] Manual smoke: send to two recipients, verify both receive the email
      and the sender sees the Cc copy in their inbox
- [ ] Manual smoke: send to a known-invalid address, verify it lands in
      `failed[]` without blocking the valid recipient
