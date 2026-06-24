# Files storage foundation

Steel's Files API now routes through a storage provider interface. The only implemented
provider is `local`, which persists objects on the API host filesystem and scopes all
`/v1/sessions/:sessionId/files` operations under a session-specific prefix.

## Environment

```bash
STEEL_FILE_STORAGE_PROVIDER=local
STEEL_LOCAL_FILE_STORAGE_PATH=      # defaults to OS temp files in dev/test, /files otherwise
STEEL_FILE_STORAGE_MAX_BYTES_PER_SESSION=
STEEL_FILE_STORAGE_MAX_BYTES_PER_FILE=
```

`STEEL_REMOTE_STORAGE_ENABLED` remains a feature flag for future remote providers. It
does not switch the Files API away from local storage by itself.

## API behavior

- Upload/list/download/delete calls for `/v1/sessions/:sessionId/files` are isolated to
  that session's storage prefix.
- File paths in API responses are logical paths relative to the session, not absolute
  filesystem paths.
- Archive downloads are built from the current session's local storage prefix.
- `POST /v1/sessions/:sessionId/files/signed-url` is reserved for remote storage
  providers. The local backend returns `501 Not Implemented`.

## Provider contract

Storage providers implement save/get/head/list/delete/deletePrefix and may optionally
implement signed URL creation. Provider keys are normalized and must not be absolute or
traverse outside the configured backend root.
