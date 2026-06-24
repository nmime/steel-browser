# Steel Browser role for ansible-k8s-full-setup

This directory contains an in-repository Ansible role skeleton that can be copied into, or referenced from, [`nmime/ansible-k8s-full-setup`](https://github.com/nmime/ansible-k8s-full-setup). It follows the optional application role pattern used by that repository: render Helm values, create any integration secrets, then install the in-repo `charts/steel-browser` chart with `kubernetes.core.helm`.

The role is intentionally disabled by default and does not modify the reference repository.

## Quick integration

From a checkout that has both repositories available:

```yaml
# playbooks/steel-browser.yml in ansible-k8s-full-setup
- name: Install Steel Browser
  hosts: localhost
  gather_facts: false
  roles:
    - role: /path/to/steel-browser/deploy/ansible/roles/steel-browser
      vars:
        steel_browser_enabled: true
        steel_browser_chart_ref: /path/to/steel-browser/charts/steel-browser
        steel_browser_base_domain: "steel.{{ domain }}"
```

Or copy `deploy/ansible/roles/steel-browser` into `ansible-k8s-full-setup/roles/steel-browser` and add it to your app playbook.

## Compatibility assumptions

- The cluster context and Python Kubernetes dependencies are already configured by `ansible-k8s-full-setup`.
- `kubernetes.core` is installed from the reference repository `requirements.yml`.
- Cilium Gateway API exposes `cilium-system/main-gateway` with an `https` section.
- Hetzner CSI provides the `hcloud-volumes` storage class.
- Optional SeaweedFS, Dragonfly, Vault, and KEDA integrations are controlled by role variables and chart values; they remain disabled until explicitly enabled.

## Common variables

```yaml
steel_browser_enabled: true
steel_browser_namespace: steel
steel_browser_release_name: steel
steel_browser_chart_ref: /path/to/steel-browser/charts/steel-browser
steel_browser_base_domain: "steel.{{ domain }}"
steel_browser_storage_class: "{{ storage_class | default('hcloud-volumes') }}"

# Gateway API
steel_browser_gateway_enabled: true
steel_browser_gateway_name: main-gateway
steel_browser_gateway_namespace: cilium-system
steel_browser_gateway_section_name: https

# SeaweedFS/object-storage role integration
steel_browser_object_storage_enabled: true
steel_browser_object_storage_endpoint: "{{ object_storage_endpoint_resolved | default('http://seaweedfs-filer.storage.svc.cluster.local:8333') }}"
steel_browser_object_storage_bucket: steel-browser
steel_browser_object_storage_secret_name: steel-browser-object-storage

# Dragonfly role integration; exposed as REDIS_URL for application builds that consume it.
steel_browser_dragonfly_enabled: true
steel_browser_dragonfly_secret_name: dragonfly-auth
steel_browser_dragonfly_url: "redis://:$(DRAGONFLY_PASSWORD)@dragonfly.dragonfly.svc.cluster.local:6379/0"

# Steel vault/profile store encryption. Prefer an externally managed Secret.
steel_browser_vault_enabled: true
steel_browser_vault_secret_name: steel-browser-vault
steel_browser_vault_secret_key: STEEL_VAULT_MASTER_KEY

# KEDA must already be installed by ansible-k8s-full-setup.
steel_browser_keda_enabled: true
steel_browser_keda_triggers:
  - type: cron
    metadata:
      timezone: UTC
      start: "0 8 * * *"
      end: "0 20 * * *"
      desiredReplicas: "2"
```

Use `steel_browser_values_override` for environment-specific overrides. It is recursively merged over the rendered template immediately before Helm install.

## Validation

Render the chart before applying the role:

```bash
helm lint /path/to/steel-browser/charts/steel-browser
helm template steel /path/to/steel-browser/charts/steel-browser \
  --namespace steel \
  -f /path/to/steel-browser/charts/steel-browser/examples/ansible-k8s-values.yaml
```

After install, use the scheduler service for the health check:

```bash
kubectl -n steel rollout status deploy/steel-steel-browser-scheduler
kubectl -n steel port-forward svc/steel-steel-browser-scheduler 3000:3000
curl -fsS http://127.0.0.1:3000/v1/health
```
