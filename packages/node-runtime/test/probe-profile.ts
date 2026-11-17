// Temporary diagnostics for the macOS runner: runs Node under the generated profile directly and
// prints what it said. Removed before the PR merges.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { nodeRuntimeProfile } from '../src/profile'
import { forbiddenUnderHome, HOST_SCRIPT } from '../src/spawn'

const temp = realpathSync(mkdtempSync(join(tmpdir(), 'valet-node-')))
const profile = nodeRuntimeProfile({
  nodeBinary: realpathSync(process.execPath),
  hostScript: realpathSync(HOST_SCRIPT),
  tempDir: temp,
  tunnelPorts: [50000],
  forbidden: await forbiddenUnderHome(realpathSync(homedir())),
})
console.log(profile)
const extras: [string, string][] = [
  ['base', ''],
  ['sysctl+root', '(allow sysctl-read (sysctl-name "security.mac.lockdown_mode_state") (sysctl-name "kern.bootargs"))\n(allow file-read-data (literal "/"))'],
  ['+map-exec', '(allow sysctl-read (sysctl-name "security.mac.lockdown_mode_state") (sysctl-name "kern.bootargs"))\n(allow file-read-data (literal "/"))\n(allow file-map-executable)'],
  ['+mach', '(allow sysctl-read (sysctl-name "security.mac.lockdown_mode_state") (sysctl-name "kern.bootargs"))\n(allow file-read-data (literal "/"))\n(allow file-map-executable)\n(allow mach-lookup)'],
  ['+ipc-iokit', '(allow sysctl-read (sysctl-name "security.mac.lockdown_mode_state") (sysctl-name "kern.bootargs"))\n(allow file-read-data (literal "/"))\n(allow file-map-executable)\n(allow mach-lookup)\n(allow iokit-open)\n(allow ipc-posix-shm*)\n(allow ipc-posix-sem)\n(allow system-fsctl)\n(allow user-preference-read)\n(allow sysctl-read)'],
  ['allow-default', '(allow default)'],
]
for (const [label, extra] of extras) {
  writeFileSync(join(temp, 'profile.sb'), `${profile}\n${extra}\n`)
  for (const args of [
    ['-e', 'console.log("plain ok")'],
    ['--permission', `--allow-fs-read=${temp}`, '-e', 'console.log("perm ok", new Date().toString())'],
  ]) {
    const r = spawnSync(
      '/usr/bin/sandbox-exec',
      ['-f', join(temp, 'profile.sb'), realpathSync(process.execPath), ...args],
      { encoding: 'utf8', env: { HOME: temp, TMPDIR: `${temp}/` }, cwd: temp },
    )
    console.log(`[${label}] status`, r.status, r.signal, 'stdout', JSON.stringify(r.stdout), 'stderr', r.stderr.slice(0, 2000))
  }
}
