// Protocol clients Valet runs for `protocol` adapters (docs/imap.md), in a sandboxed host process
// whose only network is the egress broker's tunnel to the declared endpoint.

export {
  DEFAULT_OPERATION_TIMEOUT_MS,
  hostError,
  ImapHostSession,
  type ProtocolHostOptions,
  type SignInValues,
  type StartOptions,
} from './host-session'
export { type ImapBackendOptions, imapBackend, UNAVAILABLE_IMAP } from './imap-backend'
export { HostMailReader, type HostMailReaderOptions, type MailAccount } from './mail-reader'
export { type SmtpBackendOptions, smtpBackend, UNAVAILABLE_SMTP } from './smtp-backend'
