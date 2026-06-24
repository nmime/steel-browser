# ADR 0001: Self-hosted control plane foundations

## Status

Proposed

## Context

Steel currently runs as a single browser API service. Self-hosted operators need room to add authentication, worker coordination, durable storage, challenge detection metadata, and proxy policy without changing the default open-source single-node path.

The initial foundation must be safe for existing deployments:

- disabled by default and backwards-compatible;
- no multi-session scheduler refactor in this step;
- no third-party CAPTCHA solver or challenge bypass integration;
- clear seams for future implementation and testing.

## Decision

Introduce environment flags and a disabled-by-default no-op control-plane route surface:

- `STEEL_AUTH_ENABLED`
- `STEEL_CONTROL_PLANE_ENABLED`
- `STEEL_CONTROL_PLANE_PATH`
- `STEEL_WORKER_ENABLED`
- `STEEL_REMOTE_STORAGE_ENABLED`
- `STEEL_CHALLENGE_DETECTION_ENABLED`
- `STEEL_PROXY_MANAGEMENT_ENABLED`

When `STEEL_CONTROL_PLANE_ENABLED=false`, no control-plane routes are registered. When enabled, `/status` under `STEEL_CONTROL_PLANE_PATH` reports declared capabilities and marks each as `implemented: false`.

Add a reusable redaction utility for URLs and structured data so future auth/proxy/storage code has a shared safe logging primitive.

## Consequences

- Existing deployments see no route or behavior changes unless they opt in.
- The no-op surface can be used by tests, docs, and future services without pretending production control-plane behavior exists.
- Future work must flip `implemented` only when a capability has real authorization, persistence, validation, and operational tests.
