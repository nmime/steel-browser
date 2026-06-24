{{- define "steel-browser.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "steel-browser.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "steel-browser.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "steel-browser.labels" -}}
helm.sh/chart: {{ include "steel-browser.chart" . }}
{{ include "steel-browser.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: steel-browser
{{- end -}}

{{- define "steel-browser.selectorLabels" -}}
app.kubernetes.io/name: {{ include "steel-browser.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "steel-browser.componentFullname" -}}
{{- printf "%s-%s" (include "steel-browser.fullname" .root) (kebabcase .component) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "steel-browser.componentSelectorLabels" -}}
app.kubernetes.io/name: {{ include "steel-browser.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ kebabcase .component | quote }}
{{- end -}}

{{- define "steel-browser.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "steel-browser.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "steel-browser.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end -}}

{{- define "steel-browser.storageClaimName" -}}
{{- $root := .root -}}
{{- $name := .name -}}
{{- $cfg := index $root.Values.persistence $name -}}
{{- if $cfg.existingClaim -}}
{{- $cfg.existingClaim -}}
{{- else -}}
{{- printf "%s-%s" (include "steel-browser.fullname" $root) $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "steel-browser.bool" -}}
{{- if . -}}true{{- else -}}false{{- end -}}
{{- end -}}
