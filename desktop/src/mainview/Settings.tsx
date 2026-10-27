import { useEffect, useRef, useState } from 'react'

import { EFFORTS, REPORT_PROVIDERS } from '../../../src/lib/lib'
import type { ReportProvider } from '../../../src/lib/lib'
import type { Settings } from '../shared/rpc'
import { bun } from './bridge'

// The CLI's own list; a model typed into the file by hand is kept as a choice.
const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku', 'fable']
const PROVIDER_NAMES: Record<ReportProvider, string> = { claude: 'Claude', codex: 'Codex' }

type Props = {
  providers: ReportProvider[]
  isAutoReport: boolean
  onProviders: (providers: ReportProvider[]) => Promise<void>
  onAutoReport: (isOn: boolean) => void
  isKeepInTray: boolean
  onKeepInTray: (isOn: boolean) => void
  onClose: () => void
}

// Changes save as they are made; esc or Done closes.
export function SettingsSheet({ providers, isAutoReport, onProviders, onAutoReport, isKeepInTray, onKeepInTray, onClose }: Props) {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const done = useRef<HTMLButtonElement>(null)
  const isAiOn = providers.length > 0

  const reload = () => bun.settings({}).then(setSettings, (err: unknown) => setFailure(err instanceof Error ? err.message : String(err)))
  useEffect(() => {
    done.current?.focus()
    void reload()
  }, [])

  const save = async (values: Record<string, string>) => {
    setIsSaving(true)
    const result = await bun.saveSettings({ values }).catch((err: unknown) => ({ failure: err instanceof Error ? err.message : String(err) }))
    if ('failure' in result) {
      setFailure(`Could not save: ${result.failure}`)
    } else {
      setSettings(result)
      setFailure(null)
    }
    setIsSaving(false)
  }

  // Which provider is used can change with this, so the rest is asked again.
  const turn = async (provider: ReportProvider, isOn: boolean) => {
    setIsSaving(true)
    await onProviders(isOn ? [...providers, provider] : providers.filter(one => one !== provider))
    await reload()
    setIsSaving(false)
  }

  const isCodex = settings?.provider === 'codex'
  const model = settings ? (isCodex ? settings.codexModel : settings.claudeModel) : ''
  const offered = settings ? (isCodex ? ['', ...settings.codexModels] : CLAUDE_MODELS) : []
  const models = offered.includes(model) ? offered : [...offered, model]
  const reviewModels = settings && !CLAUDE_MODELS.includes(settings.reviewModel) ? [...CLAUDE_MODELS, settings.reviewModel] : CLAUDE_MODELS
  const isInstalled = (provider: ReportProvider) => !settings || (provider === 'codex' ? settings.hasCodex : settings.hasClaude)

  return (
    <div
      className="overlay"
      onClick={onClose}
      onKeyDown={event => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          onClose()
        }
      }}
    >
      <div className="dialog settings" role="dialog" aria-label="Settings" onClick={event => event.stopPropagation()}>
        <h2>Settings</h2>

        <h3>AI</h3>
        <div className="field">
          <span className="name">Providers</span>
          <div className="checks">
            {REPORT_PROVIDERS.map(provider => (
              <label key={provider}>
                <input type="checkbox" checked={providers.includes(provider)} disabled={isSaving} onChange={event => turn(provider, event.target.checked)} />
                {PROVIDER_NAMES[provider]}
                {!isInstalled(provider) && <span className="hint inline">not installed</span>}
              </label>
            ))}
          </div>
        </div>
        <p className="hint">
          {isAiOn ? 'Only these are used, in this app only.' : 'AI features are off: no reports are written. Turn on a provider to use them.'}
        </p>

        {isAiOn &&
          (settings ? (
            <>
              <div className="field">
                <span className="name">Use</span>
                <div className="segmented" role="radiogroup" aria-label="Provider">
                  {REPORT_PROVIDERS.map(provider => (
                    <button
                      key={provider}
                      className={provider === settings.provider ? 'active' : ''}
                      role="radio"
                      aria-checked={provider === settings.provider}
                      disabled={isSaving || !providers.includes(provider)}
                      title={providers.includes(provider) ? undefined : `${PROVIDER_NAMES[provider]} is turned off`}
                      onClick={() => provider !== settings.savedProvider && save({ report_provider: provider })}
                    >
                      {PROVIDER_NAMES[provider]}
                    </button>
                  ))}
                </div>
              </div>
              <p className="hint">
                {isCodex
                  ? 'Runs the codex CLI with its own login (codex login).'
                  : 'Runs the claude CLI with its own login. No tools, settings or MCP servers of yours are used.'}
              </p>
              {!isInstalled(settings.provider) && (
                <p className="hint warning">
                  The {isCodex ? 'codex' : 'claude'} CLI is not on your PATH, so reports will fail until it is installed.
                </p>
              )}
              {settings.provider !== settings.savedProvider && (
                <p className="hint warning">
                  {PROVIDER_NAMES[settings.savedProvider]} is turned off here, so this app uses {PROVIDER_NAMES[settings.provider]}; the prs CLI
                  still uses {PROVIDER_NAMES[settings.savedProvider]}.
                </p>
              )}

              <label className="field">
                <span className="name">Report model</span>
                <select value={model} disabled={isSaving} onChange={event => save({ [isCodex ? 'codex_model' : 'report_model']: event.target.value })}>
                  {models.map(one => (
                    <option key={one} value={one}>
                      {one || 'Codex default'}
                    </option>
                  ))}
                </select>
              </label>

              {settings.overrides.length > 0 && (
                <p className="hint warning">
                  Their own .claude/pr-monitor files win in{' '}
                  {settings.overrides.map(({ repo, model: theirs }, index) => (
                    <span key={repo}>
                      {index > 0 && ', '}
                      {repo} ({theirs})
                    </span>
                  ))}
                  .
                </p>
              )}

              <label className="field">
                <span className="name">Review model</span>
                <select value={settings.reviewModel} disabled={isSaving} onChange={event => save({ review_model: event.target.value })}>
                  {reviewModels.map(one => (
                    <option key={one} value={one}>
                      {one}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="name">Review effort</span>
                <select value={settings.reviewEffort} disabled={isSaving} onChange={event => save({ review_effort: event.target.value })}>
                  {EFFORTS.map(one => (
                    <option key={one} value={one}>
                      {one}
                    </option>
                  ))}
                </select>
              </label>
              <p className="hint">
                The AI review reads the PR and its code, so it gets its own Claude model; with Codex it uses the Codex model above, at this
                effort (max is xhigh there). More effort thinks longer: slower, costlier and more thorough.
              </p>
              <p className="hint">These are saved to {settings.path}, which the prs CLI uses too.</p>
            </>
          ) : (
            !failure && <p className="hint">Loading…</p>
          ))}

        <label className={`field check ${isAiOn ? '' : 'disabled'}`}>
          <input type="checkbox" checked={isAiOn && isAutoReport} disabled={!isAiOn} onChange={event => onAutoReport(event.target.checked)} />
          <span>
            Write the report when I open a PR waiting on me
            <span className="hint">Each new activity on such a PR costs another report. This app only.</span>
          </span>
        </label>

        <h3>App</h3>
        <label className="field check">
          <input type="checkbox" checked={isKeepInTray} onChange={event => onKeepInTray(event.target.checked)} />
          <span>
            Keep running in the menu bar when I close the window
            <span className="hint">It keeps checking your PRs and notifying you. Quit from its menu bar icon or with ⌘Q.</span>
          </span>
        </label>

        {failure && <p className="error">{failure}</p>}

        <div className="actions">
          <button ref={done} className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
