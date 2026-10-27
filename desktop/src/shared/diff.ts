// A PR's unified diff, as gh pr diff prints it, in the shapes the Files tab shows.

export type DiffLine = { kind: 'add' | 'del' | 'context'; old: number | null; new: number | null; text: string }

export type DiffHunk = { header: string; lines: DiffLine[] }

export type DiffFile = {
  path: string
  // The path before a rename; null otherwise.
  oldPath: string | null
  status: 'added' | 'deleted' | 'renamed' | 'modified'
  additions: number
  deletions: number
  isBinary: boolean
  hunks: DiffHunk[]
}

// A folder, or a file by its index in the diff. Folders with a single folder inside are joined, as GitHub does.
export type TreeNode = { kind: 'dir'; name: string; path: string; children: TreeNode[] } | { kind: 'file'; name: string; path: string; index: number }

const unquote = (path: string) => (path.startsWith('"') ? (JSON.parse(path) as string) : path)

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | null = null
  let hunk: DiffHunk | null = null
  let old = 0
  let now = 0

  for (const line of text.split('\n')) {
    if (line.startsWith('diff --git ')) {
      // The paths for sure come from the --- and +++ lines or the rename lines; this guess covers files with neither.
      const match = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
      file = { path: match?.[2] ?? '', oldPath: null, status: 'modified', additions: 0, deletions: 0, isBinary: false, hunks: [] }
      files.push(file)
      hunk = null
      continue
    }
    if (!file) {
      continue
    }
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
    if (header) {
      hunk = { header: line, lines: [] }
      file.hunks.push(hunk)
      old = Number(header[1])
      now = Number(header[2])
    } else if (hunk) {
      if (line.startsWith('+')) {
        hunk.lines.push({ kind: 'add', old: null, new: now++, text: line.slice(1) })
        file.additions++
      } else if (line.startsWith('-')) {
        hunk.lines.push({ kind: 'del', old: old++, new: null, text: line.slice(1) })
        file.deletions++
      } else if (line.startsWith(' ')) {
        hunk.lines.push({ kind: 'context', old: old++, new: now++, text: line.slice(1) })
      }
      // "\ No newline at end of file" and the empty last line are left out.
    } else if (line.startsWith('new file mode')) {
      file.status = 'added'
    } else if (line.startsWith('deleted file mode')) {
      file.status = 'deleted'
    } else if (line.startsWith('rename from ')) {
      file.status = 'renamed'
      file.oldPath = unquote(line.slice('rename from '.length))
    } else if (line.startsWith('rename to ')) {
      file.path = unquote(line.slice('rename to '.length))
    } else if (line.startsWith('+++ ') && line !== '+++ /dev/null') {
      file.path = unquote(line.slice(4)).replace(/^b\//, '')
    } else if (line.startsWith('--- ') && line !== '--- /dev/null' && file.status === 'deleted') {
      file.path = unquote(line.slice(4)).replace(/^a\//, '')
    } else if (line.startsWith('Binary files ')) {
      file.isBinary = true
    }
  }

  return files
}

export function fileTree(files: DiffFile[]): TreeNode[] {
  type Dir = { dirs: Map<string, Dir>; files: { name: string; index: number }[] }
  const root: Dir = { dirs: new Map(), files: [] }
  files.forEach((file, index) => {
    const parts = file.path.split('/')
    let dir = root
    for (const part of parts.slice(0, -1)) {
      if (!dir.dirs.has(part)) {
        dir.dirs.set(part, { dirs: new Map(), files: [] })
      }
      dir = dir.dirs.get(part)!
    }
    dir.files.push({ name: parts.at(-1)!, index })
  })

  const nodesOf = (dir: Dir, prefix: string): TreeNode[] => [
    ...[...dir.dirs.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, sub]): TreeNode => {
        let joined = name
        let inner = sub
        while (inner.files.length === 0 && inner.dirs.size === 1) {
          const [next, deeper] = [...inner.dirs.entries()][0]!
          joined = `${joined}/${next}`
          inner = deeper
        }
        const path = prefix + joined

        return { kind: 'dir', name: joined, path, children: nodesOf(inner, `${path}/`) }
      }),
    ...dir.files.sort((a, b) => a.name.localeCompare(b.name)).map((one): TreeNode => ({ kind: 'file', name: one.name, path: prefix + one.name, index: one.index })),
  ]

  return nodesOf(root, '')
}

// The files in the order the tree shows them, for stepping through them.
export function treeOrder(nodes: TreeNode[]): number[] {
  return nodes.flatMap(node => (node.kind === 'file' ? [node.index] : treeOrder(node.children)))
}
