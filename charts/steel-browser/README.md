# Steel Browser Helm Chart

This chart packages Steel Browser for Kubernetes using a conservative self-hosted topology:

- `scheduler`: public API/UI entry point when Gateway API is enabled.
- `controlPlane`: private service with `STEEL_CONTROL_PLANE_ENABLED=true` for the current no-op control-plane status endpoint and future orchestration features.
- `worker`: private service with `STEEL_WORKER_ENABLED=true` for future worker execution separation.

The current Steel image is still a single-process browser API. The chart keeps stable scheduler/control-plane/worker object boundaries now without claiming distributed scheduling that the application has not implemented yet.

## Defaults

- All topology components are enabled with `replicas: 1`.
- Services are `ClusterIP`.
- Gateway API `HTTPRoute` is disabled until `gateway.enabled=true`; when enabled it routes only to the scheduler Service.
- CDP is not exposed by default. `cdp.enabled=true` adds an internal-only Service port and NetworkPolicy allow; it does not create any public route.
- NetworkPolicy is enabled for ingress isolation. Control-plane and worker pods are reachable only by same-release pods unless you add explicit ingress rules.
- HPA and KEDA are present but disabled.
- PVCs and object-storage env wiring are configurable but disabled by default.

## Install

```bash
helm upgrade --install steel ./charts/steel-browser \
  --namespace steel --create-namespace
```

Private smoke test:

```bash
kubectl -n steel port-forward svc/steel-steel-browser-scheduler 3000:3000
curl http://127.0.0.1:3000/v1/health
```

## Public API via Gateway API

For clusters built with `ansible-k8s-full-setup`, the default parent ref targets `cilium-system/main-gateway`:

```yaml
gateway:
  enabled: true
  parentRefs:
    - name: main-gateway
      namespace: cilium-system
      sectionName: https
  hostnames:
    - steel.example.com
```

This renders one `HTTPRoute` to the scheduler API only. It does not expose workers, the control-plane service, or CDP.

## CDP access

Leave `cdp.enabled=false` for normal API use. If you must debug CDP, enable it and use private access only, for example:

```bash
helm upgrade --install steel ./charts/steel-browser -n steel --set cdp.enabled=true
kubectl -n steel port-forward svc/steel-steel-browser-scheduler 9223:9223
```

Do not add a public Gateway/Ingress route for CDP unless you have separate authentication, authorization, and network controls.

## Persistence and object storage

PVCs are opt-in:

```yaml
persistence:
  logs:
    enabled: true
    storageClass: hcloud-volumes
    size: 10Gi
logStorage:
  enabled: true
  path: /data/logs/browser-logs.duckdb
```

The default access mode is `ReadWriteOnce`. Keep replicas at `1` with RWO PVCs, use an RWX storage class, or use per-component values/overrides appropriate for your cluster.

Object storage values set `STEEL_REMOTE_STORAGE_ENABLED=true` and conventional S3 environment variables. At the target SHA, remote storage is surfaced as a control-plane capability flag and is not a complete application storage backend.

## Autoscaling

HPA and KEDA are intentionally disabled by default. Enable HPA only after validating browser session behavior with more than one replica. KEDA renders `ScaledObject` resources only when both `keda.enabled=true` and `keda.triggers` is non-empty.


## ansible-k8s-full-setup examples

This chart includes example values for the platform components commonly installed by `nmime/ansible-k8s-full-setup`:

- `examples/ansible-k8s-values.yaml` — conservative Gateway + Hetzner CSI baseline.
- `examples/gateway-values.yaml` — Cilium `main-gateway` HTTPRoute only.
- `examples/seaweedfs-values.yaml` — SeaweedFS/S3 endpoint, bucket, and Secret key names.
- `examples/dragonfly-values.yaml` — optional Redis-compatible `REDIS_URL` wiring for queue-capable builds.
- `examples/vault-values.yaml` — Steel vault/profile-store master-key Secret wiring.
- `examples/keda-values.yaml` — KEDA trigger shape; validate browser session behavior before scaling above one replica.
- `examples/ansible-k8s-integrated-values.yaml` — combined reference-stack example.

A vendorable Ansible role skeleton is available at `deploy/ansible/roles/steel-browser`.

```bash
helm template steel ./charts/steel-browser -n steel \
  -f charts/steel-browser/examples/ansible-k8s-integrated-values.yaml
```

## Security notes

- The chart does not configure any CAPTCHA-solving or bypass capability.
- The default Chromium container setting uses `DISABLE_CHROME_SANDBOX=true` so the pod can run without elevated Linux capabilities. If your cluster supports Chromium sandboxing safely, override this in `commonEnv` and adjust pod security after testing.
- `networkPolicy.egress.enabled` is off to avoid accidentally blocking DNS/proxy/object-storage access; turn it on with explicit egress rules for restricted environments.
