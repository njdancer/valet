// The macOS sandbox (Seatbelt) profile a `raw` adapter's Node process runs under
// (docs/adapter-kinds.md#f3-the-node-runtime-for-raw, docs/node-runtime.md).
//
// Deny by default. What is allowed back, and nothing else:
//
// - executing the Node binary itself (sandbox-exec applies the profile, then execs Node), and no
//   other program, and no fork;
// - reading the Node binary, the host script, the system libraries and frameworks Node loads, time
//   zone data, a few character devices, and the read paths the adapter declared;
// - writing to the process's own fresh temporary folder and the read-write paths it declared;
// - TCP connections to the loopback ports of this process's egress tunnels, and nowhere else: no
//   DNS, no other loopback port (Valet's own included), no Unix sockets, no UDP;
// - signals and process information for itself only.
//
// Everything else stays denied: other programs, Apple Events, the pasteboard, the Keychain and
// security services (no Mach service is allowed at all), launch services, and every never-grantable
// place (FORBIDDEN_PATHS), which is denied again last because Seatbelt applies the last matching
// rule.
//
// Every path here must already be absolute and resolved (realpath): Seatbelt compares resolved
// paths, so `/tmp/x` never matches a rule for `/private/tmp/x`.

/** A Seatbelt string literal. Paths come from the manifest and the home folder, so quote them. */
export function sbplString(value: string): string {
  if (value.includes('\0') || /[\n\r]/.test(value))
    throw new Error('a path in a sandbox profile has a control character')
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** System folders Node and the libraries it links need to read. None holds the person's data. */
export const SYSTEM_READ_PATHS = [
  // The system libraries and frameworks, and the dyld shared cache they are loaded from.
  '/usr/lib',
  '/System/Library/Frameworks',
  '/System/Library/PrivateFrameworks',
  '/System/Library/dyld',
  '/System/Volumes/Preboot/Cryptexes/OS',
  '/System/Cryptexes/OS',
  '/private/var/db/dyld',
  // Time zones, for Date and Intl.
  '/usr/share/zoneinfo',
  '/private/var/db/timezone',
  // ICU's data, should a library ask the system's copy for it.
  '/usr/share/icu',
  // OpenSSL's configuration, which Node reads at start and refuses to start without.
  '/System/Library/OpenSSL',
] as const

/** Single files Node reads at start. */
export const SYSTEM_READ_FILES = [
  '/private/etc/localtime',
  // The OS version, for os.release() and friends.
  '/System/Library/CoreServices/SystemVersion.plist',
  '/dev/null',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/dev/dtracehelper',
] as const

/** sysctl values Node and libuv read: the CPU, memory and OS version. Not the process table. */
export const SYSCTL_NAMES = [
  'hw.activecpu',
  'hw.availcpu',
  'hw.byteorder',
  'hw.cachelinesize',
  'hw.cachelinesize_compat',
  'hw.cpufamily',
  'hw.cpufrequency',
  'hw.cpufrequency_compat',
  'hw.cputype',
  'hw.l1dcachesize',
  'hw.l1dcachesize_compat',
  'hw.l1icachesize',
  'hw.l1icachesize_compat',
  'hw.l2cachesize',
  'hw.l2cachesize_compat',
  'hw.l3cachesize',
  'hw.l3cachesize_compat',
  'hw.logicalcpu',
  'hw.logicalcpu_max',
  'hw.machine',
  'hw.memsize',
  'hw.model',
  'hw.ncpu',
  'hw.pagesize',
  'hw.pagesize_compat',
  'hw.physicalcpu',
  'hw.physicalcpu_max',
  'hw.tbfrequency',
  'hw.tbfrequency_compat',
  'hw.vectorunit',
  'kern.argmax',
  'kern.boottime',
  'kern.hostname',
  'kern.maxfilesperproc',
  'kern.osproductversion',
  'kern.osrelease',
  'kern.ostype',
  'kern.osvariant_status',
  'kern.osversion',
  'kern.secure_kernel',
  'kern.usrstack64',
  'kern.version',
  // libsystem reads these at start, and Node aborts without them.
  'kern.bootargs',
  'kern.iossupportversion',
  'security.mac.lockdown_mode_state',
  'sysctl.proc_cputype',
  'vm.loadavg',
] as const

/** sysctl prefixes: CPU feature flags, which V8 reads to pick its code paths. */
export const SYSCTL_PREFIXES = ['hw.optional.', 'hw.perflevel', 'machdep.cpu.'] as const

export interface ProfileInput {
  /** The Node binary, resolved. The only program that may run. */
  readonly nodeBinary: string
  /** The runtime host script, resolved. */
  readonly hostScript: string
  /** The process's own temporary folder (HOME and TMPDIR), resolved. Readable and writable. */
  readonly tempDir: string
  /** Declared read paths, resolved. A folder covers everything below it. */
  readonly readPaths?: readonly string[]
  /** Declared read-write paths, resolved. */
  readonly readWritePaths?: readonly string[]
  /** The loopback ports of this process's egress tunnels. */
  readonly tunnelPorts: readonly number[]
  /** Every never-grantable place, absolute, in each form it may be reached by. Denied last. */
  readonly forbidden: readonly string[]
}

/** Each folder above `path`, root first, for the metadata reads path resolution needs. */
export function ancestors(path: string): string[] {
  const out: string[] = ['/']
  const parts = path.split('/').filter((p) => p !== '')
  for (let i = 1; i < parts.length; i++) out.push(`/${parts.slice(0, i).join('/')}`)
  return out
}

function checkAbsolute(path: string): string {
  if (!path.startsWith('/') || path.split('/').some((s) => s === '.' || s === '..'))
    throw new Error(`a sandbox profile path must be absolute and resolved: ${path}`)
  return path.length > 1 ? path.replace(/\/+$/, '') : path
}

function checkPort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`not a port: ${port}`)
  return port
}

/** The profile, as SBPL text for `sandbox-exec -p`. */
export function nodeRuntimeProfile(input: ProfileInput): string {
  const node = checkAbsolute(input.nodeBinary)
  const host = checkAbsolute(input.hostScript)
  const temp = checkAbsolute(input.tempDir)
  const reads = (input.readPaths ?? []).map(checkAbsolute)
  const writes = (input.readWritePaths ?? []).map(checkAbsolute)
  const ports = [...new Set(input.tunnelPorts.map(checkPort))].sort((a, b) => a - b)
  const subpaths = (paths: readonly string[]) => paths.map((p) => `(subpath ${sbplString(p)})`).join(' ')
  const literals = (paths: readonly string[]) => paths.map((p) => `(literal ${sbplString(p)})`).join(' ')

  // Path resolution stats every folder on the way to a file it may read: metadata only, and only
  // of those folders, so the rest of the disk can't even be listed.
  const metadata = new Set<string>()
  for (const p of [node, host, temp, ...reads, ...writes, ...SYSTEM_READ_PATHS, ...SYSTEM_READ_FILES]) {
    for (const a of ancestors(p)) metadata.add(a)
  }
  // The symbolic links the system paths are reached through (/tmp, /var, /etc).
  for (const link of ['/tmp', '/var', '/etc']) metadata.add(link)

  const lines = [
    '(version 1)',
    '(deny default)',
    // Only Node itself: sandbox-exec applies this profile and then execs it.
    `(allow process-exec (literal ${sbplString(node)}))`,
    '(allow process-info* (target self))',
    '(allow signal (target self))',
    '(allow sysctl-read',
    `  ${SYSCTL_NAMES.map((n) => `(sysctl-name ${sbplString(n)})`).join('\n  ')}`,
    `  ${SYSCTL_PREFIXES.map((n) => `(sysctl-name-prefix ${sbplString(n)})`).join(' ')})`,
    `(allow file-read-metadata ${literals([...metadata].sort())})`,
    `(allow file-read* ${literals([node, host, ...SYSTEM_READ_FILES])})`,
    `(allow file-read* ${subpaths(SYSTEM_READ_PATHS)})`,
    `(allow file-read* file-write* (subpath ${sbplString(temp)}))`,
    `(allow file-write-data ${literals(['/dev/null', '/dev/zero', '/dev/dtracehelper'])})`,
    // The root folder's listing, which the runtime reads at start: names only, nothing under them.
    '(allow file-read-data (literal "/"))',
    '(allow file-ioctl (literal "/dev/dtracehelper"))',
  ]
  if (reads.length > 0) lines.push(`(allow file-read* ${subpaths(reads)})`)
  if (writes.length > 0) lines.push(`(allow file-read* file-write* ${subpaths(writes)})`)
  if (ports.length > 0) {
    // TCP over IPv4 to the tunnels' own ports, and nothing else: `ip` would also let UDP and IPv6
    // reach whatever other socket holds the same number (red team I, XK-4).
    lines.push('(allow system-socket (socket-domain AF_INET))')
    lines.push(
      `(allow network-outbound ${ports.map((p) => `(remote tcp4 ${sbplString(`localhost:${p}`)})`).join(' ')})`,
    )
  }
  // Last, so nothing above can reopen them.
  if (input.forbidden.length > 0) {
    lines.push(`(deny file-read* file-write* ${subpaths(input.forbidden.map(checkAbsolute))})`)
  }
  return `${lines.join('\n')}\n`
}
