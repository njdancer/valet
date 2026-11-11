// Writes the generated token CSS. Run after changing anything in src/tokens:
//   pnpm --filter @valet/ui tokens
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { themeCss, tokensCss } from '../src/tokens/css'

const styles = resolve(import.meta.dirname, '../src/styles')
writeFileSync(resolve(styles, 'tokens.css'), tokensCss())
writeFileSync(resolve(styles, 'theme.css'), themeCss())
