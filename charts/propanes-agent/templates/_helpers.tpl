{{- define "propanes-agent.username" -}}
{{- required "user.username is required" .Values.user.username | lower | replace "_" "-" | trunc 40 | trimSuffix "-" -}}
{{- end -}}

{{- define "propanes-agent.fullname" -}}
{{- printf "propanes-agent-%s" (include "propanes-agent.username" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "propanes-agent.launcherId" -}}
{{- default (printf "agent-%s" (include "propanes-agent.username" .)) .Values.launcher.id -}}
{{- end -}}

{{- define "propanes-agent.launcherName" -}}
{{- default (include "propanes-agent.launcherId" .) .Values.launcher.name -}}
{{- end -}}

{{- define "propanes-agent.agentAuthSecretName" -}}
{{- default (printf "propanes-agent-auth-%s" (include "propanes-agent.username" .)) .Values.agentAuthSecret.name -}}
{{- end -}}

{{- define "propanes-agent.launcherAuthSecretName" -}}
{{- default (printf "%s-launcher-token" (include "propanes-agent.fullname" .)) .Values.launcherAuthSecret.name -}}
{{- end -}}

{{- define "propanes-agent.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "propanes-agent.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "propanes-agent.labels" -}}
app.kubernetes.io/name: propanes-agent
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/component: launcher
app.kubernetes.io/managed-by: {{ .Release.Service }}
propanes.io/user: {{ include "propanes-agent.username" . | quote }}
{{- if .Values.user.org }}
propanes.io/org: {{ .Values.user.org | quote }}
{{- end }}
{{- end -}}
