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
writeFileSync(join(temp, 'profile.sb'), profile)
console.log(profile)
for (const args of [
  ['-e', 'console.log("plain ok")'],
  ['--permission', `--allow-fs-read=${temp}`, '-e', 'console.log("perm ok", new Date().toString())'],
]) {
  const r = spawnSync(
    '/usr/bin/sandbox-exec',
    ['-f', join(temp, 'profile.sb'), realpathSync(process.execPath), ...args],
    {
      encoding: 'utf8',
      env: { HOME: temp, TMPDIR: `${temp}/` },
      cwd: temp,
    },
  )
  console.log('status', r.status, r.signal, '\nstdout', r.stdout, '\nstderr', r.stderr.slice(0, 3000))
}
