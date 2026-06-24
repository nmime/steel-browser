# Safe challenge assistance skeleton

Steel's challenge assistance endpoints are a disabled-by-default skeleton for owned, allowlisted workflows that need to detect a challenge, record a redacted report, or hand the browser to a human operator.

## Safety boundaries

- Disabled unless `CHALLENGE_ASSISTANCE_ENABLED=true`.
- Requests are accepted only when the page URL origin exactly matches `CHALLENGE_ASSISTANCE_ALLOWED_ORIGINS` (scheme, host, and port). Wildcards and paths are intentionally unsupported.
- The implementation does not integrate third-party challenge-solving providers.
- The implementation does not extract, submit, or store challenge tokens.
- Do not send provider cookies, authorization headers, page HTML, screenshots, images, or audio to these endpoints.
- Manual handoff returns instructions only; a human must interact directly with the browser session.

## Endpoints

All endpoints are registered under `/v1/challenge-assistance/*` and return explicit safety guidance in `safeHandling`.

- `POST /v1/challenge-assistance/detect` — accepts a URL and small text indicators, then reports whether challenge-like text was observed.
- `POST /v1/challenge-assistance/report` — records a redacted diagnostic report for an allowlisted origin.
- `POST /v1/challenge-assistance/manual-handoff` — creates a manual handoff instruction payload for a human operator.
- `POST /v1/challenge-assistance/owned-test-callback` — optional HMAC-protected callback for owned test pages.

## Owned-test callback HMAC

If `CHALLENGE_OWNED_TEST_CALLBACK_SECRET` is set, owned test callbacks must include:

- `x-steel-challenge-timestamp`: Unix epoch milliseconds.
- `x-steel-challenge-signature`: `sha256=<hex hmac>` where the HMAC input is `<timestamp>.<json-body>`.

The max clock skew defaults to five minutes and can be adjusted with `CHALLENGE_OWNED_TEST_CALLBACK_MAX_SKEW_MS`.

## Example configuration

```env
CHALLENGE_ASSISTANCE_ENABLED=false
CHALLENGE_ASSISTANCE_ALLOWED_ORIGINS=https://owned-test.example.com,http://localhost:3000
CHALLENGE_OWNED_TEST_CALLBACK_SECRET=
CHALLENGE_OWNED_TEST_CALLBACK_MAX_SKEW_MS=300000
```
