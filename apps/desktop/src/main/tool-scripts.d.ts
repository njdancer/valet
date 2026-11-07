// The built-in adapters' tool scripts, by adapter id (tool-scripts.ts at the package root).
declare module 'virtual:valet-tool-scripts' {
  const scripts: Readonly<Record<string, string>>
  export default scripts
}
