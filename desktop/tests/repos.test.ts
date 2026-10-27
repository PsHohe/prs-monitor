import { expect, test } from 'bun:test'

import { DEFAULT_CONFIG } from '../../src/lib/lib'
import { parseDesktopState, providerFor, withoutRepo, withRepo } from '../src/shared/repos'

const API = { repo: 'acme/api', root: '/code/api' }
const WEB = { repo: 'acme/web', root: '/code/web' }

test('a missing or broken file is an empty list on all repos', () => {
  expect(parseDesktopState('')).toEqual({ repos: [], active: null, autoReport: false, providers: ['claude', 'codex'], keepInTray: null })
  expect(parseDesktopState('{"repos": [{"repo": 1}, "x", {"repo": "acme/api", "root": "/code/api"}], "active": 3, "autoReport": "yes"}')).toEqual({
    repos: [API],
    active: null,
    autoReport: false,
    providers: ['claude', 'codex'],
    keepInTray: null,
  })
})

test('keeping the app in the menu bar is unasked until the file says yes or no', () => {
  expect(parseDesktopState('{"keepInTray": "yes"}').keepInTray).toBeNull()
  expect(parseDesktopState('{"keepInTray": false}').keepInTray).toBe(false)
  expect(parseDesktopState('{"keepInTray": true}').keepInTray).toBe(true)
})

test('an active repo that is not in the list falls back to all repos', () => {
  expect(parseDesktopState(JSON.stringify({ repos: [API], active: 'acme/gone' })).active).toBeNull()
  expect(parseDesktopState(JSON.stringify({ repos: [API], active: 'acme/api' })).active).toBe('acme/api')
})

test('adding sorts, activates and replaces a repo added again', () => {
  const once = withRepo({ repos: [WEB], active: null, autoReport: true, providers: [], keepInTray: null }, API)
  expect(once).toEqual({ repos: [API, WEB], active: 'acme/api', autoReport: true, providers: [], keepInTray: null })
  expect(withRepo(once, { repo: 'acme/api', root: '/elsewhere' }).repos).toEqual([{ repo: 'acme/api', root: '/elsewhere' }, WEB])
})

test('removing the active repo goes back to all repos', () => {
  expect(withoutRepo({ repos: [API, WEB], active: 'acme/api', autoReport: false, providers: [], keepInTray: null }, 'acme/api')).toEqual({ repos: [WEB], active: null, autoReport: false, providers: [], keepInTray: null })
  expect(withoutRepo({ repos: [API, WEB], active: 'acme/web', autoReport: false, providers: [], keepInTray: null }, 'acme/api')).toEqual({ repos: [WEB], active: 'acme/web', autoReport: false, providers: [], keepInTray: null })
})

test('saved providers drop unknown ones; none turns AI off', () => {
  expect(parseDesktopState('{"providers": ["codex", "gemini"]}').providers).toEqual(['codex'])
  expect(parseDesktopState('{"providers": []}').providers).toEqual([])
})

test('a provider that is off falls back to one that is on', () => {
  const codex = { ...DEFAULT_CONFIG, reportProvider: 'codex' as const }
  expect(providerFor(codex, ['claude', 'codex'])).toBe('codex')
  expect(providerFor(codex, ['claude'])).toBe('claude')
  expect(providerFor(codex, [])).toBeNull()
})
