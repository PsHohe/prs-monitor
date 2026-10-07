// Compiles prs into a single binary at dist/prs.
const result = await Bun.build({
  entrypoints: ['src/cli.tsx'],
  compile: { outfile: 'dist/prs' },
  minify: true,
  plugins: [
    {
      // Ink loads react-devtools-core only when DEV=true and it is installed; stub it so the binary never looks for it.
      name: 'stub-react-devtools',
      setup(build) {
        build.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'stub' }))
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export default {}', loader: 'js' }))
      },
    },
  ],
})
if (!result.success) {
  for (const log of result.logs) {
    console.error(log)
  }
  process.exit(1)
}
console.log('Built dist/prs')

export {}
