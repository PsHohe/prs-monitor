// Minutes east of UTC, so prompts show local times.
export function localOffset(): number {
  return -new Date().getTimezoneOffset()
}

export async function copy(text: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(['pbcopy'], { stdin: 'pipe' })
    proc.stdin.write(text)
    await proc.stdin.end()

    return (await proc.exited) === 0
  } catch {
    return false
  }
}
