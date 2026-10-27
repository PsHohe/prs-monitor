import { REPORT_PROVIDERS } from '../../../src/lib/lib'
import type { Config, ReportProvider } from '../../../src/lib/lib'

// A repo added from a local clone: owner/name and where the clone is.
export type RepoEntry = { repo: string; root: string }

// The repos added to the selector and the one shown; null shows every repo involving me.
// autoReport writes the AI report on its own when a PR waiting on me is opened.
// providers are the AI providers this app may use; with none, its AI features are off.
// keepInTray keeps the app running in the menu bar once its window is closed; null until asked on the first close.
export type DesktopState = {
  repos: RepoEntry[]
  active: string | null
  autoReport: boolean
  providers: ReportProvider[]
  keepInTray: boolean | null
}

// Tolerates a missing, older or hand-edited file: what does not fit is dropped.
export function parseDesktopState(text: string): DesktopState {
  let value: unknown = null
  try {
    value = JSON.parse(text)
  } catch {}
  const raw = value && typeof value === 'object' ? (value as Partial<Record<keyof DesktopState, unknown>>) : {}
  const repos = (Array.isArray(raw.repos) ? raw.repos : []).filter(
    (one): one is RepoEntry => !!one && typeof one.repo === 'string' && typeof one.root === 'string' && one.repo.includes('/'),
  )
  const active = typeof raw.active === 'string' && repos.some(one => one.repo === raw.active) ? raw.active : null

  // Every provider until the file says otherwise, as before this setting existed.
  const providers = Array.isArray(raw.providers) ? REPORT_PROVIDERS.filter(one => (raw.providers as unknown[]).includes(one)) : REPORT_PROVIDERS

  const keepInTray = typeof raw.keepInTray === 'boolean' ? raw.keepInTray : null

  return { repos, active, autoReport: raw.autoReport === true, providers, keepInTray }
}

// The config's provider when it is on, else the first one that is; null when AI is off.
export function providerFor(config: Config, providers: ReportProvider[]): ReportProvider | null {
  return providers.includes(config.reportProvider) ? config.reportProvider : (providers[0] ?? null)
}

// Adding a repo again moves its clone to the newly picked folder.
export function withRepo(state: DesktopState, entry: RepoEntry): DesktopState {
  const repos = [...state.repos.filter(one => one.repo !== entry.repo), entry].sort((a, b) => a.repo.localeCompare(b.repo))

  return { ...state, repos, active: entry.repo }
}

export function withoutRepo(state: DesktopState, repo: string): DesktopState {
  return { ...state, repos: state.repos.filter(one => one.repo !== repo), active: state.active === repo ? null : state.active }
}
