# Kubernetes and Helm deployment

Steel Browser ships a Helm chart at `charts/steel-browser` for self-hosted Kubernetes deployments.

## Topology

The chart renders three logical components with safe network boundaries:

| Component | Default replicas | Service | Public exposure |
| --- | ---: | --- | --- |
| scheduler/API | 1 | ClusterIP | Optional Gateway API HTTPRoute |
| control-plane | 1 | ClusterIP | Private only |
| worker | 1 | ClusterIP | Private only |

At this repository SHA, the application image is still a single Steel Browser API process. The chart sets role/capability environment variables (`STEEL_COMPONENT_ROLE`, `STEEL_CONTROL_PLANE_ENABLED`, `STEEL_WORKER_ENABLED`) and Kubernetes boundaries for future scheduler/worker behavior; it does not add a CAPTCHA solver or bypass layer.

## ansible-k8s-full-setup integration

`ansible-k8s-full-setup` already provisions Cilium Gateway API, cert-manager, Hetzner CSI (`hcloud-volumes`), optional SeaweedFS S3-compatible object storage, Dragonfly, Vault-oriented secret workflows, and KEDA. This repository now includes a vendorable role skeleton under `deploy/ansible/roles/steel-browser` plus chart example values under `charts/steel-browser/examples/`. A role can install this chart with the same pattern used by optional app roles:

```yaml
# defaults/main.yml
steel_browser_enabled: false
steel_browser_namespace: steel
steel_browser_release_name: steel
steel_browser_chart_ref: /path/to/steel-browser/charts/steel-browser
steel_browser_base_domain: "steel.{{ domain }}"
steel_browser_values_override: {}
```

```yaml
# tasks/main.yml
- name: Render Steel Browser values
  set_fact:
    steel_browser_effective_values: >-
      {{ (lookup('template', 'steel-browser-values.yaml.j2') | from_yaml)
         | combine(steel_browser_values_override | default({}), recursive=True) }}

- name: Install Steel Browser
  kubernetes.core.helm:
    name: "{{ steel_browser_release_name }}"
    chart_ref: "{{ steel_browser_chart_ref }}"
    release_namespace: "{{ steel_browser_namespace }}"
    create_namespace: true
    release_state: present
    wait: true
    timeout: 10m0s
    values: "{{ steel_browser_effective_values }}"
```

```jinja2
# templates/steel-browser-values.yaml.j2
image:
  repository: ghcr.io/steel-dev/steel-browser
  tag: {{ steel_browser_image_tag | default('latest') | to_json }}

gateway:
  enabled: true
  parentRefs:
    - name: main-gateway
      namespace: cilium-system
      sectionName: https
  hostnames:
    - {{ steel_browser_base_domain | to_json }}

persistence:
  logs:
    enabled: true
    storageClass: {{ storage_class | default('hcloud-volumes') | to_json }}
    size: {{ steel_browser_logs_size | default('10Gi') | to_json }}
  exports:
    enabled: true
    storageClass: {{ storage_class | default('hcloud-volumes') | to_json }}
    size: {{ steel_browser_exports_size | default('10Gi') | to_json }}
logStorage:
  enabled: true
  path: /data/logs/browser-logs.duckdb

objectStorage:
  enabled: {{ steel_browser_object_storage_enabled | default(false) | bool | to_json }}
  endpoint: {{ object_storage_endpoint | default('http://seaweedfs-filer.storage.svc.cluster.local:8333') | to_json }}
  bucket: {{ steel_browser_object_storage_bucket | default('steel-browser') | to_json }}
  region: {{ steel_browser_object_storage_region | default('us-east-1') | to_json }}
  forcePathStyle: true
  existingSecret: {{ steel_browser_object_storage_secret | default('') | to_json }}

cdp:
  enabled: false
```

For a ready-to-copy implementation, use `deploy/ansible/roles/steel-browser`; it adds optional Secret creation and variables for SeaweedFS, Dragonfly, Vault/profile store encryption, KEDA, and Gateway API. Use `steel_browser_values_override` for tier-specific resources, node selectors, affinity, or autoscaling. Keep `cdp.enabled=false` unless debugging through private port-forward/VPN access.

Example value files:

- `charts/steel-browser/examples/gateway-values.yaml` — Cilium `main-gateway` HTTPRoute.
- `charts/steel-browser/examples/seaweedfs-values.yaml` — SeaweedFS/S3 endpoint and Secret key names.
- `charts/steel-browser/examples/dragonfly-values.yaml` — Redis-compatible `REDIS_URL` wiring.
- `charts/steel-browser/examples/vault-values.yaml` — Steel vault/profile master-key Secret wiring.
- `charts/steel-browser/examples/keda-values.yaml` — KEDA ScaledObject trigger example.
- `charts/steel-browser/examples/ansible-k8s-integrated-values.yaml` — combined reference stack values.

## Validation

Render locally before installing:

```bash
helm lint charts/steel-browser
helm template steel charts/steel-browser -n steel -f charts/steel-browser/examples/ansible-k8s-values.yaml
```

Post-install smoke check:

```bash
kubectl -n steel rollout status deploy/steel-steel-browser-scheduler
kubectl -n steel port-forward svc/steel-steel-browser-scheduler 3000:3000
curl -fsS http://127.0.0.1:3000/v1/health
```
