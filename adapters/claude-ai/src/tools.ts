// The tool implementations alone, without the manifest: the entry the app bundles into the script
// that runs in the isolated tool process.

import type { ToolImplementation } from '@valet/core'
import { listProjects, listThreads, readMessages, sendMessage } from './projects'

export const tools: Readonly<Record<string, ToolImplementation>> = {
  list_projects: listProjects,
  list_threads: listThreads,
  read_messages: readMessages,
  send_message: sendMessage,
}
