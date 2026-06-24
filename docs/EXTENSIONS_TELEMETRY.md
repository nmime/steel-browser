# Extensions and Trace/Replay Telemetry Foundation

This foundation adds API surfaces for two disabled-by-default capabilities:

- **Extension registry**: validates and describes local unpacked Chrome extensions under the existing `api/extensions` directory. Existing `extensions: ["recorder"]` session loading remains name-based and local; unsafe names containing path traversal are ignored.
- **Trace/replay artifacts**: exports browser logger events to the configured file storage provider as JSONL, HAR-ish JSON, or a ZIP containing both plus a manifest. Binary capture, ffmpeg transcoding, and ClamAV scanning are intentionally not included yet.

## Extension endpoints

Mounted under `/v1`:

- `GET /extensions/capabilities`
- `GET /extensions`
- `GET /extensions/:extensionId`
- `POST /extensions/registry`
- `POST /extensions/validate-manifest`
- `POST /extensions/validate-zip`

Zip validation currently inspects central-directory entry names only and rejects absolute paths, Windows drive paths, backslashes, `.` segments, and `..` traversal. A root `manifest.json` entry is required.

## Trace/replay endpoints

Mounted under `/v1`:

- `GET /telemetry/artifacts/capabilities`
- `GET /telemetry/artifacts`
- `GET /telemetry/artifacts/:artifactId`
- `GET /telemetry/artifacts/:artifactId/content`
- `POST /telemetry/artifacts`

`POST /telemetry/artifacts` returns `503` unless `STEEL_TRACE_ARTIFACTS_ENABLED=true` and browser log storage is available. The request body accepts:

```json
{
  "kind": "trace",
  "format": "jsonl",
  "sessionId": "optional-session-id",
  "label": "optional label",
  "metadata": { "source": "manual" },
  "query": {
    "startTime": "2025-01-01T00:00:00.000Z",
    "endTime": "2025-01-01T00:05:00.000Z",
    "eventTypes": ["Request", "Response", "Navigation"],
    "pageId": "optional-page-id",
    "targetType": "page",
    "limit": 1000
  }
}
```

Formats:

- `jsonl`: newline-delimited sanitized browser logger events.
- `har`: HAR 1.2-style network metadata synthesized from Request/Response events, with non-network events included under `_steel` metadata.
- `zip`: `artifact.json`, `events.jsonl`, and `trace.har.json` in one archive. This uses the existing `archiver` dependency; no ffmpeg dependency is introduced.

Request post bodies, response bodies, and `ResponseBody` payloads are omitted from exports and replaced with length markers to keep artifacts metadata-focused.

## Environment

```env
STEEL_EXTENSIONS_REGISTRY_ENABLED=false
STEEL_EXTENSIONS_DIR=
STEEL_TRACE_ARTIFACTS_ENABLED=false
STEEL_TRACE_ARTIFACTS_PREFIX=telemetry/artifacts
STEEL_TRACE_ARTIFACTS_MAX_BYTES=104857600
STEEL_TRACE_ARTIFACTS_MAX_EVENTS=10000
```

`STEEL_FILE_STORAGE_PROVIDER` / `STEEL_LOCAL_FILE_STORAGE_PATH` control where artifact payloads and metadata are written. `STEEL_TRACE_ARTIFACTS_DIR` is retained only for compatibility with the earlier placeholder configuration and is not used by the storage-provider export path.

No ffmpeg or ClamAV dependency is required by this foundation.
