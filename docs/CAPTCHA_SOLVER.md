# Gated CAPTCHA Solver

Steel Browser can solve CAPTCHAs on a running session via a pluggable provider
layer, with support for **2Captcha**, **CapSolver**, **Anti-Captcha**, and
**CapMonster Cloud**. It detects the widget on the live page, sends the sitekey
(or captured image) to the configured provider, and injects the returned token
(or applies the returned text/coordinates) back into the page.

Coverage spans **token-based** widgets (reCAPTCHA, hCaptcha, Turnstile, GeeTest,
Arkose/FunCaptcha, and more) and, when explicitly enabled, **image/puzzle**
widgets (Normal, Text, Grid, Rotate, Click, Audio). A provider-extension escape
hatch is available for operators who want maximum coverage via a provider's own
browser extension.

## Authorization model (read this first)

The solver is **gated**. Solving only runs when *both* are true:

1. `CAPTCHA_SOLVER_ENABLED=true`, and
2. the target page's **origin** is in `CAPTCHA_SOLVER_ALLOWED_ORIGINS`.

The allowlist uses exact-origin matching (e.g. `https://app.example.com`), the
same normalization as the challenge-assistance allowlist. Anything off the
allowlist returns `403` and performs **no** network or page I/O.

**Only list origins you are authorized to automate.** That means your own
properties, sites where you have explicit permission, QA/staging environments,
authorized penetration-test engagements, or public data you are entitled to
collect under the site's terms. A CAPTCHA is a site operator signalling "human
only"; solving it on a site you haven't been authorized to automate may violate
that site's terms or applicable law, and that responsibility sits with the
operator of the Steel Browser deployment, not with this code.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `CAPTCHA_SOLVER_ENABLED` | `false` | Master opt-in. |
| `CAPTCHA_SOLVER_MODE` | `auto` | `off` \| `detect-only` \| `auto`. `detect-only` permits `/detect` but blocks `/solve` (zero provider calls). |
| `CAPTCHA_SOLVER_PROVIDER` | `2captcha` | One of `2captcha`, `capsolver`, `anti-captcha`, `capmonster`. |
| `CAPTCHA_SOLVER_API_KEY` | — | Your provider API key (`clientKey`). Required when enabled. |
| `CAPTCHA_SOLVER_ALLOWED_ORIGINS` | `""` | Comma-separated exact origins, e.g. `https://app.example.com,https://shop.example.com`. |
| `CAPTCHA_SOLVER_ALLOW_ANY_ORIGIN` | `false` | **Dangerous.** When true, skips the origin allowlist entirely. Every solve is logged. Only for trusted, isolated deployments. |
| `CAPTCHA_SOLVER_TIMEOUT_MS` | `180000` | Hard ceiling for total solve time including polling. |
| `CAPTCHA_SOLVER_POLL_INTERVAL_MS` | `5000` | Delay between `getTaskResult` polls. |
| `CAPTCHA_SOLVER_IMAGE_ENABLED` | `false` | Master switch for the image/puzzle pipeline. Separate gate — page pixels/audio are exfiltrated to the provider. |
| `CAPTCHA_SOLVER_MAX_IMAGE_BYTES` | `5242880` | Per-image upload cap (5 MB). |
| `CAPTCHA_SOLVER_ALLOW_PROVIDER_EXTENSION` | `false` | Escape-hatch switch: loads a provider's browser extension. See [Provider-extension escape hatch](#provider-extension-escape-hatch-advanced). |
| `CAPTCHA_SOLVER_PROVIDER_EXTENSION` | — | Directory name (under `STEEL_EXTENSIONS_DIR`) of the provider extension to load. |

All four providers implement the shared `createTask` → poll `getTaskResult` JSON
API, so only the endpoint and task-type naming differ between them. v1 uses the
proxyless task variants (the provider solves from its own IP pool).

### Per-provider setup

- **2Captcha** — key from <https://2captcha.com>. Endpoint: `api.2captcha.com`.
- **CapSolver** — key from <https://capsolver.com>. Endpoint: `api.capsolver.com`.
- **Anti-Captcha** — key from <https://anti-captcha.com>. Endpoint: `api.anti-captcha.com`.
- **CapMonster Cloud** — key from <https://capmonster.cloud>. Endpoint: `api.capmonster.cloud`.

## Mode

`CAPTCHA_SOLVER_MODE` controls how far solving can go, mirroring the
challenge-assistance module's mode enum:

| Mode | `/detect` | `/solve` | Provider calls |
| --- | --- | --- | --- |
| `off` | blocked | blocked | none |
| `detect-only` | allowed | blocked (`detect_only` 403) | none |
| `auto` | allowed | allowed | on `/solve` only |

`detect-only` is a true dry-run: it lets you inspect pages for CAPTCHA widgets
without ever spending money or contacting a provider.

## Wildcard origin mode

`CAPTCHA_SOLVER_ALLOW_ANY_ORIGIN=true` bypasses the exact-origin allowlist so
the solver runs against any page origin. This is **dangerous** and exists only
for trusted, isolated deployments where listing every origin is impractical.

When active:

- Every authorized solve emits a `[CaptchaSolver] solved under wildcard origin
  mode` log line so the bypass is auditable.
- Responses include `originMode: "wildcard"` so callers can see which gate path
  authorized the solve.
- The master flag (`CAPTCHA_SOLVER_ENABLED`) is still required.

The challenge-assistance module is **not** widened by this flag — only the
captcha solver.

## Image / puzzle captchas

Image/puzzle widgets (Normal, Text, Grid, Rotate, Click, Canvas, Audio) are
solved via a separate pipeline that captures live-page pixels/audio and sends
them to the provider:

1. **Detect** — `findImageCaptchaElements` locates captcha containers
   (`<img>`, `<canvas>`, `<audio>` with known captcha markers).
2. **Capture** — `element.screenshot()` or `page.screenshot({ clip })` produces
   a base64 image, size-capped by `CAPTCHA_SOLVER_MAX_IMAGE_BYTES`. Audio
   widgets fetch and base64-encode the `<audio>` source.
3. **Solve** — the provider returns text (Text/Audio), click coordinates
   (Grid/Click), or a rotation angle (Rotate).
4. **Apply** — text is filled into the answer input; coordinates are clicked
   via CDP `Input.dispatchMouseEvent`; angles drive the rotate control.

This pipeline has its **own gate** (`CAPTCHA_SOLVER_IMAGE_ENABLED`, default
`false`) because it exfiltrates page pixels/audio to a third party. Token
solving and image solving are independently opt-in.

## API

### `POST /v1/captcha/detect`

Detect CAPTCHA widgets on the live session page without solving.

```jsonc
// request
{ "url": "https://app.example.com/login", "sessionId": "<session-id>" }

// 200 response
{
  "status": "detected",
  "solverEnabled": true,
  "widgets": [
    { "type": "recaptcha_v2", "sitekey": "6Lc...", "url": "https://app.example.com/login", "selector": "#login .g-recaptcha" }
  ],
  "redacted": { "url": "https://app.example.com/login" },
  "safeHandling": [ "..." ]
}
```

Returns `403` (`disabled` / `origin_not_allowed`) when the gate is closed, or
`422` (`widget_not_detected`) when no widget is found. When
`CAPTCHA_SOLVER_IMAGE_ENABLED` is on, image/puzzle widgets are also scanned and
appended to `widgets`.

### `POST /v1/captcha/solve`

Solve a CAPTCHA on the live session page and inject the token (or apply
text/coordinates). Pass an explicit `widget`, or omit it to auto-detect the
first widget on the page.

```jsonc
// request
{ "url": "https://app.example.com/login", "sessionId": "<session-id>" }

// 200 response (token widget)
{
  "status": "injected",
  "solverEnabled": true,
  "provider": "2captcha",
  "widget": { "type": "recaptcha_v2", "sitekey": "6Lc...", "url": "https://app.example.com/login" },
  "token": "03AGdBq25...",
  "providerTaskId": "123456",
  "injected": true,
  "mode": "auto",
  "originMode": "allowlist",
  "redacted": { "url": "https://app.example.com/login" },
  "safeHandling": [ "..." ]
}
```

For image/puzzle widgets the response carries `text`, `coordinates`, or `angle`
instead of `token`, and `injected` means the result was applied to the page.

`sessionId` is optional but recommended — it validates the request against the
active session before touching the page. `injected: true` means the token was
written into the page's response field and the widget callback was fired
(best-effort); if the host form needs a submit, drive it via the existing
`/v1/actions` or `/v1/sessions` endpoints.

Returns `403` when the gate is closed or mode is `detect-only`, and `422`
(`solver_error` / `image_capture_failed`) on provider or capture failures. API
keys are never returned in responses.

### Response status values

| Status | HTTP | Meaning |
| --- | --- | --- |
| `disabled` | 403 | `CAPTCHA_SOLVER_ENABLED` is false |
| `detect_only` | 403 | Mode is `detect-only`; `/solve` is blocked |
| `origin_not_allowed` | 403 | Origin not in the allowlist |
| `session_unavailable` | 403 | No live session / sessionId mismatch |
| `image_disabled` | 403 | Image widget requested but `CAPTCHA_SOLVER_IMAGE_ENABLED` is false |
| `widget_not_detected` | 422 | Page has no supported widget |
| `solver_error` | 422 | Provider rejected, timed out, or returned empty |
| `image_capture_failed` | 422 | Screenshot/audio capture failed |
| `detected` | 200 | Detect endpoint found ≥1 widget |
| `injected` | 200 | Solve endpoint solved + injected the token/applied the result |

## Supported widget types

### Token-based widgets (sitekey → token → inject)

| Widget | Detect | Solve | 2Captcha | CapSolver | Anti-Captcha | CapMonster |
| --- | --- | --- | --- | --- | --- | --- |
| reCAPTCHA v2 | yes | yes | ✅ | ✅ | ✅ | ✅ |
| reCAPTCHA v3 | yes | yes | ✅ | ✅ | ✅ | ✅ |
| hCaptcha | yes | yes | ✅ | ✅ | ✅ | ✅ |
| Cloudflare Turnstile | yes | yes | ✅ | ✅ | ✅ | ✅ |
| GeeTest v3 | yes | yes | ✅ | ✅ | ✅ | ✅ |
| GeeTest v4 | yes | yes | ✅ | ✅ | ✅ | ✅ |
| Arkose / FunCaptcha | yes | yes | ✅ | ✅ | ✅ | ✅ |
| Yandex SmartCaptcha | yes | yes | ✅ | — | — | — |
| Amazon WAF | yes | yes | ✅ | — | — | — |
| Tencent | yes | yes | ✅ | — | — | — |
| Capy Puzzle | yes | yes | ✅ | — | — | — |
| CyberSiARA | yes | yes | ✅ | — | — | — |
| MTCaptcha | yes | yes | ✅ | — | — | — |
| Friendly Captcha | yes | yes | ✅ | — | — | — |
| Cutcaptcha | yes | yes | ✅ | — | — | — |

A `—` means the provider does not support that type; the solver returns
`unsupported_widget` rather than silently failing. 2Captcha has the broadest
catalog.

### Image / puzzle widgets (capture → text/coords → apply)

| Widget | Detect | Solve | Notes |
| --- | --- | --- | --- |
| Normal / Text (`image_text`) | yes | yes | Screenshot → OCR text |
| Grid (`image_grid`) | yes | yes | Tiles → selected coordinates |
| Click (`image_click`) | yes | yes | Image → click coordinates |
| Rotate (`image_rotate`) | yes | yes | Image → rotation angle |
| Canvas (`image_canvas`) | yes | yes | Screenshot → coordinates (draw/bounding-box) |
| Audio (`image_audio`) | yes | yes | Audio fetch → transcribed text |

Image widgets require `CAPTCHA_SOLVER_IMAGE_ENABLED=true` (separate gate).

## Provider-extension escape hatch (advanced)

For maximum coverage, you can load a provider's own browser extension (e.g. the
2Captcha browser extension) directly into the automated Chrome instance. This
delegates solving to the extension, which handles widget types and edge cases
the native provider layer may not cover.

```bash
CAPTCHA_SOLVER_ALLOW_PROVIDER_EXTENSION=true
CAPTCHA_SOLVER_PROVIDER_EXTENSION=2captcha-extension   # directory under STEEL_EXTENSIONS_DIR
```

**Tradeoffs — read carefully:**

- The extension solves **outside** the origin gate. It operates on whatever page
  Chrome renders, regardless of `CAPTCHA_SOLVER_ALLOWED_ORIGINS`.
- The extension holds **its own API key** in its own storage, independent of
  `CAPTCHA_SOLVER_API_KEY`.
- Per-session control: set `extra.captchaSolverExtension: false` in a session
  create request to opt a specific session out (defaults to on when the global
  flag is set).
- Extensions load reliably under `--headless=new` (Steel's default). If you set
  `CHROME_HEADLESS=false`, they also work in headful mode.

The extension is resolved via the existing extensions subsystem
(`getExtensionPaths` + `validateExtensionDirectory`), so it must be a valid
unpacked extension directory with a parseable `manifest.json`.
