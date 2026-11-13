#!/usr/bin/env node
// The agent's command line for the authoring evals (eval/README.md): Valet's MCP tools, through the
// eval's agent door, which is a real MCP client of the app.
//
//   node agent.mjs list                       every tool: name, description, input schema
//   node agent.mjs names                      tool names only
//   node agent.mjs call <tool> '<json args>'  one call; `@file.json` reads the arguments from a file
//
// A file's content for valet_write_draft_file can come from disk: an argument `"content": "@path"`
// is replaced by that file's text.

import { readFileSync } from 'node:fs'

const port = Number(process.env.EVAL_AGENT_PORT ?? 47110)
const [command, name, raw] = process.argv.slice(2)

async function post(path, body) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  return response.json()
}

if (command === 'list' || command === 'names') {
  const tools = await post('/list')
  if (command === 'names') console.log(tools.map((t) => t.name).join('\n'))
  else
    console.log(
      JSON.stringify(
        tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        null,
        1,
      ),
    )
} else if (command === 'call' && name !== undefined) {
  let args = {}
  if (raw !== undefined) args = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw)
  if (typeof args.content === 'string' && args.content.startsWith('@'))
    args.content = readFileSync(args.content.slice(1), 'utf8')
  const result = await post('/call', { name, arguments: args })
  if (result.structured !== null && result.structured !== undefined)
    console.log(JSON.stringify(result.structured, null, 1))
  else console.log(result.text)
  if (result.isError) process.exitCode = 1
} else {
  console.error('usage: node agent.mjs list | names | call <tool> <json args>')
  process.exitCode = 2
}
