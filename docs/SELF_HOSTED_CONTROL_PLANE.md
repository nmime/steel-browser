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
| `STEEL_REMOTE_STORAGE_ENABLED` | Reported by the no-op status service only. | Enable durable metadata/artifact storage. |
| `STEEL_CHALLENGE_DETECTION_ENABLED` | Reported by the no-op status service only. | Enable challenge detection metadata and operator-visible state, not bypass/solving. |
| `STEEL_PROXY_MANAGEMENT_ENABLED` | Reported by the no-op status service only. | Enable proxy inventory and policy. |

## Route surface

With `STEEL_CONTROL_PLANE_ENABLED=true`, the API registers:

- `GET /v1/control-plane/status`

The response is a no-op capability report. Each capability includes `enabled` and `implemented`. In this foundation, `implemented` is always `false`.

## Boundaries for future work

- Auth must be fail-closed before protecting existing routes.
- Worker scheduling must be introduced behind leases/heartbeats and should not change current local session behavior until explicitly enabled.
- Remote storage must redact credentials and avoid logging raw signed URLs, tokens, proxy credentials, cookies, or API keys.
- Challenge detection may classify and surface state; it must not integrate CAPTCHA solvers or automate bypasses.
- Proxy management should treat proxy URLs as secrets and use the shared redaction utility in logs/errors.
