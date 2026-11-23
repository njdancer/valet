// What a built-in tool may hand an agent besides its JSON output: a picture the client shows the
// model as an image, or a file (an MCP embedded resource) that a client such as Claude Code saves
// to disk for the agent to open. Never in a tool's output, so the bytes stay out of the audit log,
// the structured result and Valet's own memory of calls. Only Valet's built-in tools set these; an
// adapter's run never does.

export const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type PictureType = (typeof PICTURE_TYPES)[number]

export type ToolContent =
  | {
      readonly kind: 'image'
      readonly mimeType: PictureType
      readonly data: Buffer
    }
  | {
      readonly kind: 'file'
      /** e.g. valet-mail://message/40487/attachment/2/receipt.pdf */
      readonly uri: string
      readonly mimeType: string
      readonly data: Buffer
    }

/** At most this much, before base64, goes back with one result. */
export const MAX_TOOL_CONTENT_BYTES = 8 * 1024 * 1024
