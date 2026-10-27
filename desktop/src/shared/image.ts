// Images uploaded to GitHub comments: new uploads, and the older per-repo ones.
export function isGithubImage(url: string): boolean {
  return /^https:\/\/github\.com\/(user-attachments\/assets|[\w.-]+\/[\w.-]+\/assets)\/[\w-]+$/.test(url)
}
