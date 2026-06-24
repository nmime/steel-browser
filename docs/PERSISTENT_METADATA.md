# Persistent metadata store foundation

Steel keeps the default single-node behavior in memory unless a metadata path is configured.
Operators can opt into JSON file-backed metadata without adding a database dependency.

## Configuration

Set a shared directory to enable domain-specific metadata files:

```bash
STEEL_METADATA_STORE_PATH=/var/lib/steel/metadata
```

With that one setting, Steel creates these JSON documents as needed:

| Domain | Default file under `STEEL_METADATA_STORE_PATH` | Override |
| --- | --- | --- |
| Auth users/API keys/audit | `auth.json` | `STEEL_AUTH_STORE_PATH` |
| Session registry and redacted proxy usage | `sessions.json` | `STEEL_SESSIONS_STORE_PATH` |
| Scheduler worker registry | `workers.json` | `STEEL_WORKER_REGISTRY_STORE_PATH` |
| Files metadata index | `files.json` | `STEEL_FILE_METADATA_STORE_PATH` |
| Vault metadata/envelopes | `vault.json` | `STEEL_VAULT_STORE_PATH` |
| Profile records/versions | `profiles.json` | `STEEL_PROFILES_STORE_PATH` |
| Extension registry records | `extensions.json` | `STEEL_EXTENSIONS_STORE_PATH` |
| Trace/replay artifact index | `traces.json` | `STEEL_TRACE_ARTIFACTS_STORE_PATH` |

`STEEL_PROXY_STORE_PATH` is reserved for a future standalone proxy policy store. Current
proxy metadata is stored redacted inside the session registry (`proxies` map) so session
history and byte counters survive process restarts.

## File format and migration

- Files are JSON documents with `version: 1` and domain-specific maps/lists.
- Writes are atomic: Steel writes a temporary file in the same directory and then renames
  it over the target file.
- Store files are created with `0600` permissions where the platform supports POSIX modes.
- Existing auth/profile/vault JSON documents continue to load; they are rewritten in the
  current `version: 1` shape on the next mutation.

## Initialization checklist

1. Create a directory owned by the Steel API process, for example `/var/lib/steel/metadata`.
2. Set `STEEL_METADATA_STORE_PATH` or individual `*_STORE_PATH` overrides.
3. Mount the metadata directory on durable storage if the container is recreated.
4. Keep `STEEL_VAULT_MASTER_KEY` or `STEEL_VAULT_MASTER_KEY_FILE` stable; vault entries
   are encrypted envelopes but require the same master key to decrypt later.
5. Back up metadata JSON files together with local file/profile/extension directories.

Leaving all paths unset preserves the in-memory fallback and does not create files.
