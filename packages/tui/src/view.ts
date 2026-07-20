import type { RunUiEntry, RunUiSnapshot, RunUiUsage } from "./contracts"
import { type RalphTuiLocale, tuiText } from "./i18n"
import { type ProgressBarStyle, progressBar } from "./progress"
import { truncateDisplayWidth } from "./text-width"

export interface SnapshotView {
  readonly progressLabel: string
  readonly progressBar: string
  readonly progressPercentage: number
  readonly combinedUsage: string
  readonly executorUsage: string
  readonly judgeUsage: string
  readonly judgeLabel: string
  readonly currentTaskLabel: string
  readonly connectionLabel: string
  readonly runtimeLabel: string
  readonly watchdogLabel: string
  readonly errorLabel: string
}

function durationLabel(milliseconds: number | undefined, locale: RalphTuiLocale): string {
  if (milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return tuiText(locale, "elapsed unavailable", "tempo indisponível")
  }
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000))
  const hours = Math.floor(totalSeconds / 3_600)
  const minutes = Math.floor((totalSeconds % 3_600) / 60)
  const seconds = totalSeconds % 60
  return hours > 0
    ? `${hours}h${String(minutes).padStart(2, "0")}m`
    : `${minutes}m${String(seconds).padStart(2, "0")}s`
}

export function formatEntry(entry: RunUiEntry): string {
  const prefix = [entry.timestamp, entry.level, entry.type].filter(Boolean).join(" · ")
  return prefix.length > 0 ? `${prefix}  ${entry.message}` : entry.message
}

export function formatUsage(usage: RunUiUsage, locale: RalphTuiLocale = "en"): string {
  if (!usage.available) {
    return `${tuiText(locale, "unavailable", "indisponível")} · ${tuiText(locale, "source", "origem")}=${usage.source}${usage.note ? ` · ${usage.note}` : ""}`
  }

  const tokenParts: string[] = []
  if (usage.totalTokens !== undefined) tokenParts.push(`${usage.totalTokens} total`)
  if (usage.inputTokens !== undefined) {
    tokenParts.push(`${usage.inputTokens} ${tuiText(locale, "in", "entrada")}`)
  }
  if (usage.outputTokens !== undefined) {
    tokenParts.push(`${usage.outputTokens} ${tuiText(locale, "out", "saída")}`)
  }
  const tokens =
    tokenParts.length > 0
      ? tokenParts.join(" / ")
      : tuiText(locale, "tokens not reported", "tokens não reportados")
  const cost = usage.cost
    ? `${usage.cost.amount.toFixed(6)} ${usage.cost.currency}${usage.cost.source ? ` (${usage.cost.source})` : ""}`
    : tuiText(locale, "cost not reported", "custo não reportado")
  return `${tuiText(locale, "source", "origem")}=${usage.source} · ${tokens} · ${cost}${usage.note ? ` · ${usage.note}` : ""}`
}

export function formatConnection(snapshot: RunUiSnapshot, locale: RalphTuiLocale = "en"): string {
  const connection = snapshot.connection
  if (!connection) return tuiText(locale, "polling", "consultando")
  const cursor = connection.cursor
    ? `${connection.cursor.streamId}@${connection.cursor.sequence}`
    : "—"
  switch (connection.phase) {
    case "reconnecting":
      return `${tuiText(locale, "reconnecting", "reconectando")} ${connection.reconnectAttempt} · cursor ${cursor}`
    case "disconnected":
      return `${tuiText(locale, "disconnected", "desconectado")} · cursor ${cursor}${connection.reason ? ` · ${truncateDisplayWidth(connection.reason, 80)}` : ""}`
    case "replay":
      return `replay · cursor ${cursor}`
    case "live":
      return `live · cursor ${cursor}`
    default:
      return `${connection.phase} · cursor ${cursor}`
  }
}

export function buildSnapshotView(
  snapshot: RunUiSnapshot,
  barWidth: number,
  style: ProgressBarStyle = "unicode",
  locale: RalphTuiLocale = "en",
): SnapshotView {
  const progress = progressBar({
    completed: snapshot.progress.completed,
    total: snapshot.progress.total,
    width: barWidth,
    style,
  })
  const judgeScore =
    snapshot.judge.score === null || snapshot.judge.score === undefined
      ? tuiText(locale, "not scored", "sem nota")
      : `${snapshot.judge.score}/${snapshot.judge.threshold ?? "?"}`
  const profile = snapshot.judge.profile ?? tuiText(locale, "not configured", "não configurado")
  const runtime = snapshot.runtime
  const watchdog = snapshot.watchdog
  const errors = snapshot.errorsSummary

  return {
    progressLabel: `${snapshot.progress.completed}/${snapshot.progress.total} · ${progress.percentage}%`,
    progressBar: progress.bar,
    progressPercentage: progress.percentage,
    combinedUsage: formatUsage(snapshot.usage.combined, locale),
    executorUsage: formatUsage(snapshot.usage.executor, locale),
    judgeUsage: formatUsage(snapshot.usage.judge, locale),
    judgeLabel: `${snapshot.judge.mode} · ${profile} · ${judgeScore} · ${tuiText(locale, "revisions", "revisões")} ${snapshot.judge.revisionAttempt}/${snapshot.judge.maxRevisionAttempts}`,
    currentTaskLabel: snapshot.currentTask
      ? `${snapshot.currentTask.id} · ${snapshot.currentTask.title} · ${snapshot.currentTask.status}${snapshot.currentTask.attempt === undefined ? "" : ` · ${tuiText(locale, "attempt", "tentativa")} ${snapshot.currentTask.attempt}`}`
      : tuiText(locale, "No task is currently executing", "Nenhuma task está em execução"),
    connectionLabel: formatConnection(snapshot, locale),
    runtimeLabel: runtime
      ? `${runtime.phase} · ${tuiText(locale, "attempt", "tentativa")} ${runtime.attempt} · ${tuiText(locale, "calls", "chamadas")} m${runtime.modelCalls}/t${runtime.toolCalls}/g${runtime.gateRuns} · ${durationLabel(runtime.elapsedMs, locale)}`
      : tuiText(locale, "runtime unavailable", "runtime indisponível"),
    watchdogLabel: watchdog?.enabled
      ? `${watchdog.state}${watchdog.phase ? ` · ${watchdog.phase}` : ""}${watchdog.action ? ` · ${tuiText(locale, "action", "ação")}=${watchdog.action}` : ""} · ${tuiText(locale, "restarts", "reinícios")} ${watchdog.restartUsed}/${watchdog.restartMaximum ?? "?"}`
      : tuiText(locale, "disabled or unavailable", "desativado ou indisponível"),
    errorLabel:
      errors && errors.count > 0
        ? `${errors.count} · ${errors.last?.code ? `${errors.last.code}: ` : ""}${errors.last?.message ?? tuiText(locale, "details unavailable", "detalhes indisponíveis")}`
        : `0 · ${tuiText(locale, "none", "nenhum")}`,
  }
}
