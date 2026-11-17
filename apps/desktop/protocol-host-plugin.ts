// A Vite plugin for the main build: emits the protocol host (packages/protocols/src/build.ts, Valet's
// own IMAP client in one CommonJS file) as out/main/protocol-host.cjs, and the SFTP host (ssh2 and
// Valet's own SFTP client) as out/main/sftp-host.cjs. The sandboxed Node reads it
// from there in a development run, and from app.asar.unpacked when packaged
// (electron-builder.config.ts, asarUnpack). See src/main/core/protocol-host.ts.

import type { Plugin } from 'vite'
import { buildProtocolHost, buildSftpHost } from '../../packages/protocols/src/build'
import { PROTOCOL_HOST_FILE, SFTP_HOST_FILE } from './src/main/core/protocol-host'

export function protocolHost(): Plugin {
  return {
    name: 'valet-protocol-host',
    apply: 'build',
    async generateBundle() {
      this.emitFile({ type: 'asset', fileName: PROTOCOL_HOST_FILE, source: await buildProtocolHost() })
      this.emitFile({ type: 'asset', fileName: SFTP_HOST_FILE, source: await buildSftpHost() })
    },
  }
}
