import type { ElectrobunConfig } from 'electrobun'

export default {
  app: {
    name: 'Team PRs',
    identifier: 'dev.prs-monitor.desktop',
    version: '0.1.0',
  },
  build: {
    mainProcess: 'bun',
    bun: { entrypoint: 'src/bun/index.ts' },
    views: {
      mainview: { entrypoint: 'src/mainview/index.tsx' },
    },
    copy: {
      'src/mainview/index.html': 'views/mainview/index.html',
      'src/mainview/index.css': 'views/mainview/index.css',
      'assets/tray.png': 'views/tray.png',
    },
    // The system webview keeps the app small; CEF would add a whole Chromium.
    mac: { bundleCEF: false, icons: 'assets/icon.iconset' },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig
