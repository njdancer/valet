// Hands a manifest's credentials out for one tool call (B's contract,
// docs/adapter-kinds.md#f2-secrets-version-2). The one place a credential's value leaves its
// provider for a non-browser adapter: workstream A's broker asks for a header, the protocol host
// (D, E, G) asks to sign in, and a raw adapter's ctx.secrets (F) asks for an entrusted value.
//
// Before anything is resolved it checks that:
// - the manifest declares the credential, for this use (a header, a protocol sign-in, or entrusted);
// - the target (host or endpoint) is one the declaration names;
// - there is a grant for this adapter hash, of the same kind and custody, whose targets include it.
//
// Then, in this order: the value is registered for output redaction (with its encoded forms), the
// use is audited as `secret-used` with its target, and only then is the value handed over. If
// either of the first two fails, nothing is handed over.

import {
  type AuditEvent,
  type CredentialDeclaration,
  type CredentialGrant,
  type CredentialProtocol,
  credentialTargets,
  type ItemField,
  isCredentialHost,
  SecretValue,
  type UseKind,
  useKind,
  ValetError,
} from '@valet/core'

export interface CredentialGateOptions {
  readonly adapterId: string
  readonly adapterHash: string
  readonly credentials: Readonly<Record<string, CredentialDeclaration>> | undefined
  /**
   * The grant that may serve this credential for this hash, or null. The app decides which grants
   * count (signed, or carried over by an approved update); the gate checks the grant against the
   * manifest whatever it is handed.
   */
  readonly findGrant: (credential: string) => Promise<CredentialGrant | null>
  /** Resolves one field of a granted item (CredentialResolver.resolve). The gate disposes it. */
  readonly resolve: (grant: CredentialGrant, field: ItemField) => Promise<SecretValue>
  readonly audit: { append(event: AuditEvent): Promise<unknown> }
  /**
   * Keeps a copy for output redaction for as long as the session lasts (the run's
   * SecretRedactionSet.register). Must not throw; if it does, nothing is handed over.
   */
  readonly remember: (secret: SecretValue) => void
  readonly callId: string | null
}

/** What a protocol client signs in with. The caller disposes both. */
export interface SignIn {
  readonly username: SecretValue | null
  readonly secret: SecretValue
}

/** An entrusted credential, as a raw adapter is given it. The caller disposes the values. */
export interface Entrusted {
  readonly username: SecretValue | null
  readonly secret: SecretValue
  readonly endpoints: readonly string[]
}

export class CredentialGate {
  readonly #options: CredentialGateOptions

  constructor(options: CredentialGateOptions) {
    this.#options = options
  }

  /**
   * The header to add to one HTTPS request to `host`: its name, and its value with the credential
   * in place. The caller adds it to that one request only, and disposes the value.
   */
  async headerFor(credential: string, host: string): Promise<{ name: string; value: SecretValue }> {
    // The host exactly as declared: no case folding, which Unicode would stretch (the Kelvin sign
    // lower-cases to "k"). The broker hands over the host it will connect to (red team B7).
    if (!isCredentialHost(host)) throw new ValetError('credential', 'origin-mismatch')
    const target = host
    const { declaration, grant } = await this.#check(credential, 'header', target)
    if (!('hosts' in declaration.use) || declaration.use.header === undefined)
      throw new ValetError('credential', 'invalid')
    const { name, format } = declaration.use.header
    const usesBasic = format.includes('{basic}')
    const username = usesBasic ? await this.#field(grant, 'username') : null
    let secret: SecretValue | null = null
    try {
      secret = await this.#field(grant, secretField(declaration))
      const value = buildHeader(format, secret, username)
      try {
        this.#remember(value)
        await this.#hand(declaration, credential, [secret], target)
      } catch (error) {
        value.dispose()
        throw error
      }
      return { name, value }
    } finally {
      secret?.dispose()
      username?.dispose()
    }
  }

  /**
   * The declared WebSocket message to send to `host`, with the credential in its one "{value}"
   * field (docs/adapter-kinds.md#credential-messages), and the credential's value itself, for the
   * caller's redaction of what comes back. The caller sends the message once and disposes both.
   */
  async messageFor(credential: string, host: string): Promise<{ message: SecretValue; value: SecretValue }> {
    if (!isCredentialHost(host)) throw new ValetError('credential', 'origin-mismatch')
    const { declaration, grant } = await this.#check(credential, 'header', host)
    if (!('hosts' in declaration.use) || declaration.use.message === undefined)
      throw new ValetError('credential', 'invalid')
    const { json } = declaration.use.message
    const secret = await this.#field(grant, secretField(declaration))
    let message: SecretValue | null = null
    try {
      message = buildMessage(json, secret)
      this.#remember(message)
      await this.#hand(declaration, credential, [secret], host)
      return { message, value: secret }
    } catch (error) {
      message?.dispose()
      secret.dispose()
      throw error
    }
  }

  /** The username (when the item has one) and secret to sign in to `endpoint` over `protocol`. */
  async signIn(credential: string, protocol: CredentialProtocol, endpoint: string): Promise<SignIn> {
    const { declaration, grant } = await this.#check(credential, 'protocol', endpoint)
    if (!('protocol' in declaration.use) || declaration.use.protocol !== protocol) {
      throw new ValetError('credential', 'origin-mismatch')
    }
    return this.#pair(credential, declaration, grant, endpoint)
  }

  /**
   * An entrusted credential's value, for a raw adapter. Its endpoints are the declaration's,
   * narrowed to what the grant allows: the broker holds the adapter's connections to those.
   */
  async entrusted(credential: string): Promise<Entrusted> {
    const { declaration, grant } = await this.#check(credential, 'entrusted', null)
    const endpoints = credentialTargets(declaration).filter((t) => grant.targets.includes(t))
    const pair = await this.#pair(credential, declaration, grant, endpoints.join(' '))
    return { ...pair, endpoints }
  }

  async #pair(
    credential: string,
    declaration: CredentialDeclaration,
    grant: CredentialGrant,
    target: string,
  ): Promise<SignIn> {
    const secret = await this.#field(grant, secretField(declaration))
    let username: SecretValue | null = null
    try {
      // A username is optional: an item may hold only the secret (a token, a Valet-made key).
      username = await this.#optionalUsername(grant, declaration)
      await this.#hand(declaration, credential, [secret], target)
      return { username, secret }
    } catch (error) {
      secret.dispose()
      username?.dispose()
      throw error
    }
  }

  async #check(
    credential: string,
    use: UseKind,
    target: string | null,
  ): Promise<{ declaration: CredentialDeclaration; grant: CredentialGrant }> {
    const { credentials, adapterId, adapterHash } = this.#options
    const declaration =
      credentials !== undefined && Object.hasOwn(credentials, credential)
        ? credentials[credential]
        : undefined
    if (declaration === undefined) throw new ValetError('credential', 'not-granted')
    if (useKind(declaration.use) !== use) throw new ValetError('credential', 'invalid')
    const declared = credentialTargets(declaration)
    if (target !== null && !declared.includes(target)) throw new ValetError('credential', 'origin-mismatch')
    let grant: CredentialGrant | null
    try {
      grant = await this.#options.findGrant(credential)
    } catch {
      throw new ValetError('credential', 'unavailable')
    }
    if (grant === null) throw new ValetError('credential', 'not-granted')
    // The app's own store hands back checked, frozen grants; anything else is checked here too.
    if (!Array.isArray(grant.targets) || !grant.targets.every((t) => typeof t === 'string')) {
      throw new ValetError('credential', 'not-granted')
    }
    // The grant must be for exactly this adapter version, credential, kind and custody, and allow
    // only targets the declaration still names.
    if (
      grant.adapterId !== adapterId ||
      grant.adapterHash !== adapterHash ||
      grant.credential !== credential ||
      grant.kind !== declaration.kind ||
      grant.custody !== declaration.custody ||
      grant.targets.length === 0 ||
      !grant.targets.every((t) => declared.includes(t))
    ) {
      throw new ValetError('credential', 'not-granted')
    }
    if (target !== null && !grant.targets.includes(target))
      throw new ValetError('credential', 'origin-mismatch')
    return { declaration, grant }
  }

  async #field(grant: CredentialGrant, field: ItemField): Promise<SecretValue> {
    const value = await this.#options.resolve(grant, field)
    if (!(value instanceof SecretValue) || value.disposed) throw new ValetError('credential', 'internal')
    return value
  }

  async #optionalUsername(
    grant: CredentialGrant,
    declaration: CredentialDeclaration,
  ): Promise<SecretValue | null> {
    if (!fieldsOf(declaration).includes('username')) return null
    try {
      return await this.#field(grant, 'username')
    } catch (error) {
      if (error instanceof ValetError && error.errorClass === 'field-missing') return null
      throw error
    }
  }

  #remember(value: SecretValue): void {
    try {
      this.#options.remember(value)
    } catch {
      throw new ValetError('credential', 'internal')
    }
  }

  /**
   * Registers each value for redaction, then audits the use. A username is not a secret, and
   * registering one would redact every mail address or path that contains it (red team B5), so
   * only the secret itself, and a header built from it, are registered. Only then may the caller
   * have them.
   */
  async #hand(
    declaration: CredentialDeclaration,
    credential: string,
    values: readonly SecretValue[],
    target: string,
  ): Promise<void> {
    for (const value of values) this.#remember(value)
    const { adapterId, adapterHash, callId, audit } = this.#options
    try {
      await audit.append({
        type: 'secret-used',
        adapterId,
        adapterHash,
        secret: credential,
        field: secretField(declaration),
        origin: target,
        callId,
        custody: declaration.custody,
      })
    } catch {
      throw new ValetError('credential', 'internal')
    }
  }
}

function fieldsOf(declaration: CredentialDeclaration): readonly ItemField[] {
  return declaration.kind === 'password'
    ? ['username', 'password']
    : declaration.kind === 'token'
      ? ['token']
      : ['username', 'ssh-key']
}

function secretField(declaration: CredentialDeclaration): ItemField {
  return declaration.kind === 'password' ? 'password' : declaration.kind === 'token' ? 'token' : 'ssh-key'
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
const C0 = /[\u0000-\u001f\u007f]/
/** Anything but printable ASCII: a header value carries nothing else (red team B9). */
const CONTROL = /[^\x20-\x7e]/

/**
 * A credential message: the declared JSON object, its "{value}" field holding the credential as a
 * JSON string, written in the manifest's field order. The credential may hold any text but a
 * control character (JSON would escape it, but nothing a sign-in takes has one).
 */
function buildMessage(json: Readonly<Record<string, unknown>>, secret: SecretValue): SecretValue {
  return secret.reveal((value) => {
    if (value.length === 0 || C0.test(value)) throw new ValetError('credential', 'invalid')
    const out: Record<string, unknown> = Object.create(null)
    let filled = 0
    for (const [key, field] of Object.entries(json)) {
      if (field === '{value}') filled++
      out[key] = field === '{value}' ? value : field
    }
    if (filled !== 1) throw new ValetError('credential', 'invalid')
    return SecretValue.fromString(JSON.stringify(out))
  })
}

/** The header value: the format with its one placeholder filled. Built inside reveal(). */
function buildHeader(format: string, secret: SecretValue, username: SecretValue | null): SecretValue {
  if (format.includes('{basic}')) {
    if (username === null) throw new ValetError('credential', 'field-missing')
    return username.reveal((user) =>
      secret.reveal((password) => {
        // RFC 7617: a user-id with a colon can't be told apart from the password.
        if (user.includes(':') || C0.test(user) || C0.test(password))
          throw new ValetError('credential', 'invalid')
        const basic = Buffer.from(`${user}:${password}`, 'utf8')
        try {
          const encoded = basic.toString('base64')
          return SecretValue.fromString(format.replace('{basic}', () => encoded))
        } finally {
          basic.fill(0)
        }
      }),
    )
  }
  return secret.reveal((value) => {
    // A value with a line break or other control character would end the header early.
    if (CONTROL.test(value)) throw new ValetError('credential', 'invalid')
    return SecretValue.fromString(format.replace('{value}', () => value))
  })
}
