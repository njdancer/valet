// The tool implementations alone, without the manifest: the entry the app bundles into the script
// that runs in the isolated tool process.

import type { ToolImplementation } from '@valet/core'
import { getArticle, getSummary, searchArticles } from './articles'

export const tools: Readonly<Record<string, ToolImplementation>> = {
  search_articles: searchArticles,
  get_summary: getSummary,
  get_article: getArticle,
}
