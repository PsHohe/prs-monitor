import { gh } from '../../../src/github'
import { isGithubImage } from '../shared/image'

const MAX_BYTES = 20 * 1024 * 1024

let token: Promise<string | null> | null = null

// Images attached to private repos' comments only load with my GitHub token, so they are fetched here and handed
// to the webview as data URLs. The token goes to github.com only, not to the storage host it redirects to.
export async function fetchImage(url: string): Promise<{ dataUrl: string } | { failure: string }> {
  if (!isGithubImage(url)) {
    return { failure: 'Not a GitHub image' }
  }
  token ??= gh(['auth', 'token']).then(result => (result.exitCode === 0 ? result.stdout.trim() : null))
  const auth = await token
  if (!auth) {
    token = null
    return { failure: 'gh is not logged in' }
  }
  try {
    const first = await fetch(url, { headers: { Authorization: `token ${auth}` }, redirect: 'manual' })
    const location = first.headers.get('location')
    const response = first.status >= 300 && first.status < 400 && location ? await fetch(new URL(location, url)) : first
    const type = response.headers.get('content-type') ?? ''
    if (!response.ok || !type.startsWith('image/')) {
      return { failure: `GitHub answered ${response.status}` }
    }
    const bytes = await response.arrayBuffer()
    if (bytes.byteLength > MAX_BYTES) {
      return { failure: 'Image too large' }
    }

    return { dataUrl: `data:${type};base64,${Buffer.from(bytes).toString('base64')}` }
  } catch (err) {
    return { failure: err instanceof Error ? err.message : String(err) }
  }
}
