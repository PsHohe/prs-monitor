import { expect, test } from 'bun:test'

import { fileTree, parseDiff, treeOrder } from '../src/shared/diff'

const DIFF = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,4 +10,5 @@ function main() {
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 return a
\\ No newline at end of file
diff --git a/docs/new.md b/docs/new.md
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/docs/new.md
@@ -0,0 +1 @@
+# New
diff --git a/old.txt b/old.txt
deleted file mode 100644
index 4444444..0000000
--- a/old.txt
+++ /dev/null
@@ -1 +0,0 @@
-gone
diff --git a/src/a.ts b/src/lib/b.ts
similarity index 100%
rename from src/a.ts
rename to src/lib/b.ts
diff --git a/logo.png b/logo.png
index 5555555..6666666 100644
Binary files a/logo.png and b/logo.png differ
`

test('reads each file with its status, counts and numbered lines', () => {
  const [app, added, deleted, renamed, binary] = parseDiff(DIFF)
  expect(app).toMatchObject({ path: 'src/app.ts', status: 'modified', additions: 2, deletions: 1 })
  expect(app!.hunks[0]!.lines).toEqual([
    { kind: 'context', old: 10, new: 10, text: 'const a = 1' },
    { kind: 'del', old: 11, new: null, text: 'const b = 2' },
    { kind: 'add', old: null, new: 11, text: 'const b = 3' },
    { kind: 'add', old: null, new: 12, text: 'const c = 4' },
    { kind: 'context', old: 12, new: 13, text: 'return a' },
  ])
  expect(added).toMatchObject({ path: 'docs/new.md', status: 'added', additions: 1 })
  expect(deleted).toMatchObject({ path: 'old.txt', status: 'deleted', deletions: 1 })
  expect(renamed).toMatchObject({ path: 'src/lib/b.ts', oldPath: 'src/a.ts', status: 'renamed', hunks: [] })
  expect(binary).toMatchObject({ path: 'logo.png', isBinary: true })
})

test('the tree puts folders first, joins single-folder chains and orders files as shown', () => {
  const files = parseDiff(DIFF)
  const tree = fileTree(files)
  expect(tree.map(node => node.name)).toEqual(['docs', 'src', 'logo.png', 'old.txt'])
  const src = tree[1]!
  expect(src.kind === 'dir' && src.children.map(node => node.name)).toEqual(['lib', 'app.ts'])
  expect(treeOrder(tree).map(index => files[index]!.path)).toEqual(['docs/new.md', 'src/lib/b.ts', 'src/app.ts', 'logo.png', 'old.txt'])

  const deep = fileTree(parseDiff('diff --git a/a/b/c.ts b/a/b/c.ts\n--- a/a/b/c.ts\n+++ b/a/b/c.ts\n'))
  expect(deep[0]).toMatchObject({ kind: 'dir', name: 'a/b', children: [{ kind: 'file', name: 'c.ts', path: 'a/b/c.ts' }] })
})
