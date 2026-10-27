import { useEffect, useMemo, useRef, useState } from 'react'

import { fileTree, parseDiff, treeOrder } from '../shared/diff'
import type { DiffFile, TreeNode } from '../shared/diff'

// Files with more changed lines than this start folded, so a big PR does not render everything at once.
const FOLD_LINES = 800

// The PR's changed files as a tree beside the diffs of all of them, stacked in the tree's order, as GitHub shows them.
export function Files({ text }: { text: string }) {
  const files = useMemo(() => parseDiff(text), [text])
  const tree = useMemo(() => fileTree(files), [files])
  const order = useMemo(() => treeOrder(tree), [tree])
  const [foldedDirs, setFoldedDirs] = useState<string[]>([])
  // By path, so a newer diff of the PR keeps them.
  const [foldedFiles, setFoldedFiles] = useState<string[]>(() => files.filter(file => file.additions + file.deletions > FOLD_LINES).map(file => file.path))
  const [current, setCurrent] = useState<string | null>(null)
  const sections = useRef(new Map<string, HTMLElement>())

  // The file at the top of the pane is the one marked in the tree.
  useEffect(() => {
    const showing = new Set<string>()
    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          const path = (entry.target as HTMLElement).dataset.path!
          entry.isIntersecting ? showing.add(path) : showing.delete(path)
        }
        const first = order.map(index => files[index]!.path).find(path => showing.has(path))
        if (first) {
          setCurrent(first)
        }
      },
      { rootMargin: '0px 0px -80% 0px' },
    )
    sections.current.forEach(section => observer.observe(section))

    return () => observer.disconnect()
  }, [files, order])

  if (files.length === 0) {
    return <p className="muted">No changed files.</p>
  }
  const toggleIn = (setter: typeof setFoldedDirs) => (path: string) => setter(before => (before.includes(path) ? before.filter(one => one !== path) : [...before, path]))
  const jump = (path: string) => {
    setFoldedFiles(before => before.filter(one => one !== path))
    sections.current.get(path)?.scrollIntoView({ block: 'start' })
    setCurrent(path)
  }

  return (
    <div className="files">
      <nav className="file-tree" aria-label="Changed files">
        <Nodes nodes={tree} files={files} current={current} folded={foldedDirs} depth={0} onPick={jump} onToggle={toggleIn(setFoldedDirs)} />
      </nav>
      <div className="file-stack">
        {order.map(index => {
          const file = files[index]!

          return (
            <FileDiff
              key={file.path}
              file={file}
              isFolded={foldedFiles.includes(file.path)}
              onToggle={() => toggleIn(setFoldedFiles)(file.path)}
              sectionRef={section => {
                section ? sections.current.set(file.path, section) : sections.current.delete(file.path)
              }}
            />
          )
        })}
      </div>
    </div>
  )
}

type NodesProps = {
  nodes: TreeNode[]
  files: DiffFile[]
  current: string | null
  folded: string[]
  depth: number
  onPick: (path: string) => void
  onToggle: (path: string) => void
}

function Nodes({ nodes, files, current, folded, depth, onPick, onToggle }: NodesProps) {
  return nodes.map(node => {
    const indent = { paddingLeft: 8 + depth * 12 }
    if (node.kind === 'dir') {
      const isFolded = folded.includes(node.path)

      return (
        <div key={node.path}>
          <button className="tree-row dir" style={indent} onClick={() => onToggle(node.path)} title={node.path}>
            <span className="caret">{isFolded ? '▸' : '▾'}</span>
            <span className="name">{node.name}</span>
          </button>
          {!isFolded && <Nodes nodes={node.children} files={files} current={current} folded={folded} depth={depth + 1} onPick={onPick} onToggle={onToggle} />}
        </div>
      )
    }
    const file = files[node.index]!

    return (
      <button key={node.path} className={`tree-row file ${file.path === current ? 'selected' : ''}`} style={indent} onClick={() => onPick(file.path)} title={file.path}>
        <span className={`status ${file.status}`} />
        <span className="name">{node.name}</span>
        <span className="stat">
          {file.additions > 0 && <span className="plus">+{file.additions}</span>}
          {file.deletions > 0 && <span className="minus">−{file.deletions}</span>}
        </span>
      </button>
    )
  })
}

type FileDiffProps = { file: DiffFile; isFolded: boolean; onToggle: () => void; sectionRef: (section: HTMLElement | null) => void }

function FileDiff({ file, isFolded, onToggle, sectionRef }: FileDiffProps) {
  return (
    <section className="file-diff" ref={sectionRef} data-path={file.path}>
      <header onClick={onToggle} title={isFolded ? 'Show the changes' : 'Hide the changes'}>
        <span className="caret">{isFolded ? '▸' : '▾'}</span>
        <span className="path">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
        {file.status !== 'modified' && <span className={`badge ${file.status}`}>{file.status}</span>}
        <span className="spacer" />
        <span className="plus">+{file.additions}</span> <span className="minus">−{file.deletions}</span>
      </header>
      {isFolded ? null : file.isBinary ? (
        <p className="muted note">Binary file, not shown.</p>
      ) : file.hunks.length === 0 ? (
        <p className="muted note">{file.status === 'renamed' ? 'Renamed without changes.' : 'No changes to show.'}</p>
      ) : (
        <div className="diff-lines">
          {file.hunks.map((hunk, at) => (
            <div key={at}>
              <div className="diff-line hunk-header">
                <span className="num" />
                <span className="num" />
                <span className="text">{hunk.header}</span>
              </div>
              {hunk.lines.map((line, lineAt) => (
                <div key={lineAt} className={`diff-line ${line.kind}`}>
                  <span className="num">{line.old ?? ''}</span>
                  <span className="num">{line.new ?? ''}</span>
                  <span className="text">
                    {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                    {line.text}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
