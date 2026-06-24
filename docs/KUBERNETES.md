# Kubernetes Deployment Notes

## Proxy secrets

Steel Browser accepts `proxyUrl` on session/action requests. If a request omits
`proxyUrl`, `PROXY_URL` can provide a global fallback. `PROXY_USERNAME` and
`PROXY_PASSWORD` are optional and are applied only when the configured URL does
not already include credentials. Session responses redact proxy credentials.

Create a secret for proxy settings instead of hard-coding credentials in a
Deployment manifest:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: steel-proxy
type: Opaque
stringData:
  PROXY_URL: "http://proxy.example.com:8080"
  PROXY_USERNAME: "proxy-user"
  PROXY_PASSWORD: "proxy-password"
```

Reference the secret from the API container:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: steel-browser-api
spec:
  template:
    spec:
      containers:
        - name: api
          image: steel-browser-api:latest
          envFrom:
            - secretRef:
                name: steel-proxy
          env:
            - name: PROXY_BYPASS
              value: "0.0.0.0,localhost,127.0.0.1,steel-browser-api"
```

If your proxy URL already includes credentials, omit `PROXY_USERNAME` and
`PROXY_PASSWORD` from the secret:

```yaml
stringData:
  PROXY_URL: "http://proxy-user:proxy-password@proxy.example.com:8080"
```

Prefer the split `PROXY_USERNAME`/`PROXY_PASSWORD` form when possible so secret
rotation can update credentials without changing the proxy host configuration.
