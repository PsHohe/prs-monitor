import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { SavedReview } from '../shared/rpc'

// One file per PR, next to the app's other state; a review untouched for a month is dropped.
const DIR = join(homedir(), '.claude', 'pr-monitor', 'reviews')
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const fileOf = (key: string) => join(DIR, `${encodeURIComponent(key)}.json`)

export async function readReviews(): Promise<Record<string, SavedReview>> {
  const names = await readdir(DIR).catch(() => [] as string[])
  const entries = await Promise.all(
    names
      .filter(name => name.endsWith('.json'))
      .map(async name => {
        const path = join(DIR, name)
        try {
          if (Date.now() - (await stat(path)).mtimeMs > MAX_AGE_MS) {
            await rm(path, { force: true })
            return null
          }
          const review = JSON.parse(await Bun.file(path).text()) as SavedReview

          return [decodeURIComponent(name.slice(0, -'.json'.length)), settled(review)] as const
        } catch {
          return null
        }
      }),
  )

  return Object.fromEntries(entries.filter(entry => !!entry))
}

// A review saved while the model worked stopped with the app; older files miss fields added since.
function settled(review: SavedReview): SavedReview {
  return {
    ...review,
    findings: review.findings.map(finding => ({ ...finding, addressed: finding.addressed ?? null })),
    isBusy: false,
    activity: null,
    draft: review.draft ?? null,
    commitId: review.commitId ?? null,
    suggestions: review.suggestions ?? [],
    posted: review.posted ?? null,
    explains: Object.fromEntries(
      Object.entries(review.explains ?? {}).map(([id, thread]) => [
        id,
        {
          ...thread,
          assessment: thread.assessment ?? null,
          settled: thread.settled ?? null,
          isBusy: false,
          activity: null,
          failure: thread.isBusy ? 'The answer stopped when the app quit' : thread.failure,
        },
      ]),
    ),
    failure: review.isBusy ? (review.turn === 0 ? 'The review stopped when the app quit' : 'The answer stopped when the app quit') : review.failure,
  }
}

export async function writeReview(key: string, review: SavedReview | null): Promise<void> {
  if (!review) {
    await rm(fileOf(key), { force: true })
    return
  }
  await mkdir(DIR, { recursive: true })
  await Bun.write(fileOf(key), JSON.stringify(review))
}
