// How a `raw` adapter's bundle finds its npm dependencies (docs/node-runtime.md#bundling): Node's
// resolution rules, run over files held in memory and a lockfile, never over a disk. A bare import
// goes to the version the importer's own lockfile entry names; inside a package, `exports`,
// `imports`, `main` and the usual extension and index probing apply; Node's built-ins stay outside
// the bundle, as `require` calls. Nothing can resolve outside the packages the lockfile lists.
//
// It is plain JavaScript in a string because it runs in the compile worker, which is evaluated from
// a string too (compile.ts). The tests evaluate the same string (npmResolver below).

export const NPM_RESOLVER_SOURCE = String.raw`
function createNpmResolver(lock, packages, builtins) {
  const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k)
  const builtin = new Set(builtins)
  const isBuiltin = (s) => builtin.has(s) || (s.startsWith('node:') && builtin.has(s.slice(5)))
  const fail = (text) => ({ error: text.length > 200 ? text.slice(0, 197) + '...' : text })

  /** A posix path inside a package, or null if it climbs out of it. */
  const norm = (path) => {
    const out = []
    for (const part of path.split('/')) {
      if (part === '' || part === '.') continue
      if (part === '..') { if (out.length === 0) return null; out.pop(); continue }
      out.push(part)
    }
    return out.join('/')
  }
  const dirname = (path) => { const i = path.lastIndexOf('/'); return i === -1 ? '' : path.slice(0, i) }
  const exists = (key, path) => own(packages[key], path)
  const json = (key, path) => { try { return JSON.parse(packages[key][path]) } catch { return null } }

  const probe = (key, path, depth = 0) => {
    if (path === null || depth > 3) return null
    const bases = path === '' ? [] : [path, path + '.js', path + '.json', path + '.cjs', path + '.mjs']
    for (const candidate of bases) if (exists(key, candidate)) return candidate
    const prefix = path === '' ? '' : path + '/'
    const inner = json(key, prefix + 'package.json')
    if (inner && typeof inner.main === 'string' && path !== '') {
      const found = probe(key, norm(prefix + inner.main), depth + 1)
      if (found !== null) return found
    }
    for (const index of ['index.js', 'index.json', 'index.cjs', 'index.mjs']) if (exists(key, prefix + index)) return prefix + index
    return null
  }

  const target = (t, conditions) => {
    if (typeof t === 'string') return t
    if (Array.isArray(t)) {
      for (const item of t) { const r = target(item, conditions); if (r !== undefined && r !== null) return r }
      return undefined
    }
    if (t === null) return null
    if (typeof t === 'object') {
      for (const k of Object.keys(t)) {
        if (k === 'default' || conditions.includes(k)) { const r = target(t[k], conditions); if (r !== undefined) return r }
      }
    }
    return undefined
  }

  /** A subpath through an exports or imports map, or undefined if the map doesn't offer it. */
  const throughMap = (map, sub, conditions) => {
    if (own(map, sub) && !sub.includes('*')) return target(map[sub], conditions)
    let best = null
    for (const k of Object.keys(map)) {
      const star = k.indexOf('*')
      if (star === -1 || k.indexOf('*', star + 1) !== -1) continue
      const prefix = k.slice(0, star)
      const suffix = k.slice(star + 1)
      if (sub.length >= prefix.length + suffix.length && sub.startsWith(prefix) && sub.endsWith(suffix)) {
        if (best === null || prefix.length > best.prefix.length) best = { k, prefix, match: sub.slice(prefix.length, sub.length - suffix.length) }
      }
    }
    if (best === null) return undefined
    const t = target(map[best.k], conditions)
    return typeof t === 'string' ? t.split('*').join(best.match) : t
  }

  const conditionsFor = (kind) => (kind === 'require-call' || kind === 'require-resolve' ? ['node', 'require'] : ['node', 'import', 'module'])

  /** The file a package's subpath ('.' or './x') names, or null. */
  const entryOf = (key, sub, kind) => {
    const pj = json(key, 'package.json') || {}
    if (pj.exports !== undefined && pj.exports !== null) {
      let map = pj.exports
      if (typeof map === 'string' || Array.isArray(map) || !Object.keys(map).some((k) => k.startsWith('.'))) map = { '.': map }
      const t = throughMap(map, sub, conditionsFor(kind))
      if (typeof t !== 'string' || !t.startsWith('./')) return null
      const path = norm(t.slice(2))
      return path !== null && exists(key, path) ? path : probe(key, path)
    }
    if (sub === '.') {
      const main = typeof pj.main === 'string' ? norm(pj.main) : null
      return (main === null ? null : probe(key, main)) || probe(key, 'index')
    }
    return probe(key, norm(sub.slice(2)))
  }

  const split = (spec) => {
    const parts = spec.split('/')
    const count = spec.startsWith('@') ? 2 : 1
    if (parts.length < count || parts.slice(0, count).some((p) => p === '')) return null
    const rest = parts.slice(count).join('/')
    return { name: parts.slice(0, count).join('/'), sub: rest === '' ? '.' : './' + rest }
  }

  const depsOf = (from) => {
    if (from === null) {
      const out = {}
      for (const name of Object.keys(lock.dependencies)) out[name] = lock.dependencies[name].resolved
      return out
    }
    return own(lock.packages, from.key) ? lock.packages[from.key].dependencies || {} : {}
  }

  const nameOf = (key) => key.slice(0, key.lastIndexOf('@'))

  /**
   * What an import resolves to: { key, path } inside a package, { external } for Node's built-ins,
   * or { error }. from is null for the adapter's own code, else { key, path } of the importer.
   */
  const resolve = (spec, from, kind) => {
    if (typeof spec !== 'string' || spec === '' || spec.includes('\0') || spec.includes('\\')) return fail('may not import that')
    if (isBuiltin(spec)) return { external: spec }
    if (spec.startsWith('/')) return fail('may not import an absolute path: ' + spec)
    if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
      if (from === null) return fail('may not import ' + spec)
      const path = probe(from.key, norm((dirname(from.path) === '' ? '' : dirname(from.path) + '/') + spec))
      return path === null ? fail(nameOf(from.key) + ' has no ' + spec) : { key: from.key, path }
    }
    if (spec.startsWith('#')) {
      if (from === null) return fail('may not import ' + spec)
      const pj = json(from.key, 'package.json') || {}
      const t = pj.imports && typeof pj.imports === 'object' ? throughMap(pj.imports, spec, conditionsFor(kind)) : undefined
      // Node allows a relative file or a bare package here, never another # name (no loops).
      if (typeof t !== 'string' || t.startsWith('#')) return fail(nameOf(from.key) + ' has no ' + spec)
      if (t.startsWith('./')) {
        const path = norm(t.slice(2))
        const found = path !== null && exists(from.key, path) ? path : probe(from.key, path)
        return found === null ? fail(nameOf(from.key) + ' has no ' + spec) : { key: from.key, path: found }
      }
      return resolve(t, from, kind)
    }
    const parsed = split(spec)
    if (parsed === null) return fail('may not import ' + spec)
    const deps = depsOf(from)
    let key = own(deps, parsed.name) ? deps[parsed.name] : undefined
    // A package may import itself by name.
    if (key === undefined && from !== null && nameOf(from.key) === parsed.name) key = from.key
    if (key === undefined || !own(packages, key)) {
      return fail((from === null ? 'the adapter' : nameOf(from.key)) + ' imports ' + parsed.name + ', which isn’t one of its dependencies; add it with valet_add_dependency')
    }
    const path = entryOf(key, parsed.sub, kind)
    return path === null ? fail(parsed.name + ' doesn’t export ' + parsed.sub) : { key, path }
  }

  return { resolve }
}
`

export interface NpmResolution {
  readonly key?: string
  readonly path?: string
  readonly external?: string
  readonly error?: string
}

export interface NpmResolver {
  resolve(
    spec: string,
    from: { readonly key: string; readonly path: string } | null,
    kind: string,
  ): NpmResolution
}

/** The same resolver, in this thread: for tests. */
export function npmResolver(
  lock: unknown,
  packages: Readonly<Record<string, Readonly<Record<string, string>>>>,
  builtins: readonly string[],
): NpmResolver {
  const make = new Function(`${NPM_RESOLVER_SOURCE}; return createNpmResolver`)() as (
    l: unknown,
    p: unknown,
    b: readonly string[],
  ) => NpmResolver
  return make(lock, packages, builtins)
}
