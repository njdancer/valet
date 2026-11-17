// The Node runtime for `raw` adapters (docs/node-runtime.md): a separately signed Node binary run
// under a deny-by-default Seatbelt profile per adapter, its network only through the egress
// broker's tunnels, and npm dependencies bundled at check time.

export * from './deps/index'
export { ancestors, nodeRuntimeProfile, type ProfileInput, sbplString } from './profile'
export {
  DEFAULT_HEAP_MB,
  DEFAULT_MAX_LIFETIME_MS,
  forbiddenUnderHome,
  HOST_SCRIPT,
  type NodeRuntimeOptions,
  nodeArguments,
  type NodeChannel,
  nodeRuntimeProcess,
  SANDBOX_EXEC,
  type SandboxedNodeOptions,
  sandboxedNode,
} from './spawn'
export {
  type Endpoint,
  type OpenTunnels,
  type ParsedEndpoint,
  parseEndpoint,
  type TunnelSet,
} from './tunnels'
