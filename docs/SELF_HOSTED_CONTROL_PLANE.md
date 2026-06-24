# Self-hosted control plane architecture

This document describes the foundation for a future self-hosted Steel control plane. The current implementation is intentionally no-op and disabled by default.

## Goals

- Keep the default single-node browser API unchanged.
- Add explicit feature flags before wiring auth, workers, storage, challenge metadata, or proxy policy.
- Provide a small route seam for future operators and tests.
- Avoid CAPTCHA solving, bypass flows, or third-party solver integrations.

## Feature flags

All flags default to `false` unless noted.

| Flag | Purpose today | Future responsibility |
| --- | --- | --- |
| `STEEL_AUTH_ENABLED` | Reported by the no-op status service only. | Gate API authentication/authorization once implemented. |
| `STEEL_CONTROL_PLANE_ENABLED` | Registers the no-op control-plane routes when true. | Enable control-plane APIs. |
| `STEEL_CONTROL_PLANE_PATH` | Route prefix, default `/v1/control-plane`. | Allow operators to mount the control plane under a stable path. |
| `STEEL_WORKER_ENABLED` | Reported by the no-op status service only. | Enable worker registration/heartbeats/leases. |
| `STEEL_SESSION_RECOVERY_ENABLED` | Enables scheduler recovery state when a worker heartbeat expires. Default `false`. | Mark sessions as recovering and allow best-effort restoration metadata. |
| `STEEL_SESSION_RECOVERY_AUTO_ALLOCATE` | When recovery is enabled, asks the scheduler to allocate a replacement idle worker and recreate the session from available inputs. Default `false`. | Replacement worker recovery policy. |
| `STEEL_SESSION_RECOVERY_MAX_ATTEMPTS` | Maximum replacement attempts per interrupted session. Default `1`. | Bound retry behavior. |
| `STEEL_SESSION_RECOVERY_SWEEP_INTERVAL_MS` | Scheduler stale-worker sweep interval. Default `5000`. | Periodic health/recovery sweep. |
| `STEEL_REMOTE_STORAGE_ENABLED` | Reported by the no-op status service only. | Enable durable metadata/artifact storage. |
| `STEEL_CHALLENGE_DETECTION_ENABLED` | Reported by the no-op status service only. | Enable challenge detection metadata and operator-visible state, not bypass/solving. |
| `CHALLENGE_ASSISTANCE_MODE` | `off` by default. `owned-test-auto` enables the synthetic owned-test provider only when `CHALLENGE_ASSISTANCE_ALLOWED_ORIGINS` exactly matches the page origin. | Diploma/testing harnesses may post sanitized element inventories marked with `data-steel-owned-challenge="true"`; the API returns safe fill/click actions from owned data attributes and rejects known real challenge widgets/classes/sitekeys. |
| `CHALLENGE_ASSISTANCE_ALLOWED_ORIGINS` | Empty by default. Comma-separated exact origins only; paths, credentials, query strings, hashes, and subdomain wildcards are ignored/rejected. | Required before any challenge assistance route accepts a URL. |
| `STEEL_PROXY_MANAGEMENT_ENABLED` | Reported by the no-op status service only. | Enable proxy inventory and policy. |

## Route surface

With `STEEL_CONTROL_PLANE_ENABLED=true`, the API registers:

- `GET /v1/control-plane/status`

Scheduler mode also exposes recovery metadata on `GET /v1/scheduler/status` and adds an optional `recovery` object to scheduler-proxied session responses.

The response is a no-op capability report. Each capability includes `enabled` and `implemented`. In this foundation, `implemented` is always `false`.

## Boundaries for future work

- Auth must be fail-closed before protecting existing routes.
- Worker scheduling must be introduced behind leases/heartbeats and should not change current local session behavior until explicitly enabled.
- Recovery is best-effort failover only. Steel cannot transparently migrate a live Chrome process, WebSocket, in-memory page state, or OS process across workers/pods. When a worker heartbeat exceeds `WORKER_STALE_AFTER_MS`, the scheduler marks affected mappings `interrupted` (or `recovering` if recovery is enabled). If auto-allocation is enabled, it may create a new browser session on a replacement worker using the original create-session inputs that are safe and available to the scheduler, such as `profileId`/`profileVersion`, `sessionContext`, and `userDataDir`/persisted profile data. Operators and clients must treat the recovered browser as a recreated session, not a migrated one.
- Remote storage must redact credentials and avoid logging raw signed URLs, tokens, proxy credentials, cookies, or API keys.
- Challenge detection may classify and surface state; it must not integrate CAPTCHA solvers or automate bypasses.
- Proxy management should treat proxy URLs as secrets and use the shared redaction utility in logs/errors.


### Owned-test auto challenge provider

`CHALLENGE_ASSISTANCE_MODE=owned-test-auto` is a disabled-by-default demo provider for owned diploma/testing harness pages only. It requires an exact-origin entry in `CHALLENGE_ASSISTANCE_ALLOWED_ORIGINS` and a sanitized element inventory; do not send cookies, authorization headers, page HTML, screenshots, audio, challenge tokens, or third-party provider payloads.

The harness must mark every actionable synthetic element with `data-steel-owned-challenge="true"`. Fields are filled only when a marked element has `data-steel-owned-challenge-field` plus either a matching `fieldValues` entry or `data-steel-owned-challenge-value`. Buttons are clicked only when a marked element has `data-steel-owned-challenge-submit="true"` or `data-steel-owned-challenge-click="true"`. Known real challenge widget classes, selectors, or sitekey-like attributes are rejected instead of solved.
