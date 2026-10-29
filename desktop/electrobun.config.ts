import type { ElectrobunConfig } from 'electrobun'

const isSigned = !!process.env.ELECTROBUN_DEVELOPER_ID

export default {
  app: {
    name: 'Team PRs',
    identifier: 'dev.prs-monitor.desktop',
    version: '0.2.0',
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
    // Signed and notarized only where the Apple credentials are set (the release workflow); local builds stay unsigned.
    mac: { bundleCEF: false, icons: 'assets/icon.iconset', codesign: isSigned, notarize: isSigned },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
  // Installed apps look for <channel>-<os>-<arch>-update.json here; the release workflow uploads to the latest release.
  release: { baseUrl: 'https://github.com/PsHohe/prs-monitor/releases/latest/download' },
} satisfies ElectrobunConfig
