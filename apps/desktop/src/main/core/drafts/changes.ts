// What a draft started from an installed adapter changes (docs/authoring-tools.md#repairing-an-installed-adapter).
// Valet's checks ask for proof of what changed and only that: a tool whose code and declaration are
// the installed version's runs exactly as the version the person already approved, so it needs no
// new case, and login steps that changed need a login trial that signs in with them instead.
//
// Everything here compares the package as files and the manifest as parsed, so formatting a file
// differently counts as a change: the rule errs toward asking for proof.

import { type AdapterManifest, canonicalJson, type PackageFiles, parseManifest, sha256Hex } from '@valet/core'

/** Files that never run: the agent's cases and their fixtures. */
const TEST_FILE = /^test\//

export interface DraftChanges {
  /** Tools that run exactly as the installed version's do: same code, same declaration, same walls. */
  readonly unchangedTools: readonly string[]
  /** The login steps (manifest auth.steps) differ from the installed version's. */
  readonly loginChanged: boolean
  /**
   * Everything a login depends on besides its steps is the installed version's: where it may go,
   * what it may type and where, how Valet tells it signed in. A login trial runs the draft's steps
   * behind the installed version's walls, so it proves them only while this holds.
   */
  readonly loginWallsSame: boolean
  /** The hash a login trial is bound to: the draft's login steps and the walls they ran behind. */
  readonly loginKey: string
}

export const NO_CHANGES_KNOWN: DraftChanges = {
  unchangedTools: [],
  loginChanged: false,
  loginWallsSame: false,
  loginKey: '',
}

/** What a login depends on besides its steps. */
function loginWalls(m: AdapterManifest): unknown {
  return {
    home: m.home ?? null,
    navigation: m.navigation,
    egress: m.egress,
    secrets: m.secrets,
    session: m.session,
    frameOrigins: m.auth.frameOrigins,
    runtime: m.runtime ?? 'browser',
  }
}

/** The hash a login trial is kept under and looked up by. */
export function loginKey(m: AdapterManifest): string {
  return sha256Hex(canonicalJson({ steps: m.auth.steps, walls: loginWalls(m) }))
}

/** The manifest less what never changes how a tool runs: the version, the description, the login steps. */
function toolWalls(m: AdapterManifest): unknown {
  const { version: _v, description: _d, tools: _t, auth, ...rest } = m
  return { ...rest, auth: { ...auth, steps: null } }
}

function parsed(files: PackageFiles): AdapterManifest | null {
  try {
    return parseManifest(JSON.parse(files['manifest.json'] ?? 'null'))
  } catch {
    return null
  }
}

/**
 * What `files`, a draft's package, changes against `installed`, the package
 * installed now. A draft not started from an installed adapter changes everything.
 */
export function draftChanges(
  files: PackageFiles,
  installed: { readonly files: PackageFiles } | null,
  fromInstalled: boolean,
): DraftChanges {
  // Both sides parsed the same way, from their files, so defaults can't read as a change.
  const manifest = parsed(files)
  if (manifest === null) return NO_CHANGES_KNOWN
  const key = loginKey(manifest)
  if (installed === null || !fromInstalled) return { ...NO_CHANGES_KNOWN, loginKey: key }
  const before = parsed(installed.files)
  if (before === null || before.id !== manifest.id) return { ...NO_CHANGES_KNOWN, loginKey: key }
  const loginChanged = canonicalJson(before.auth.steps) !== canonicalJson(manifest.auth.steps)
  const loginWallsSame = canonicalJson(loginWalls(before)) === canonicalJson(loginWalls(manifest))
  const paths = new Set([...Object.keys(files), ...Object.keys(installed.files)])
  const codeSame = [...paths].every(
    (path) => path === 'manifest.json' || TEST_FILE.test(path) || files[path] === installed.files[path],
  )
  const unchangedTools =
    codeSame && canonicalJson(toolWalls(before)) === canonicalJson(toolWalls(manifest))
      ? manifest.tools
          .filter((tool) => {
            const was = before.tools.find((t) => t.name === tool.name)
            return was !== undefined && canonicalJson(was) === canonicalJson(tool)
          })
          .map((tool) => tool.name)
      : []
  return { unchangedTools, loginChanged, loginWallsSame, loginKey: key }
}
