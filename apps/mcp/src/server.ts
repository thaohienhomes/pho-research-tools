import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context';
import { registerCheckRetractions } from './tools/check-retractions';
import { registerFormatCitations } from './tools/format-citations';
import { registerPrismaFlowDiagram } from './tools/prisma-flow-diagram';
import { registerSearchPapers } from './tools/search-papers';
import { registerVerifyReferences } from './tools/verify-references';

export const SERVER_NAME = 'pho-research-tools';
export const SERVER_VERSION = '0.1.0';

export const SERVER_INSTRUCTIONS = [
  'Phở Research Tools check scholarly references against Crossref, PubMed and OpenAlex.',
  'verify_references checks a reference list, check_retractions looks up retraction and correction notices, search_papers finds real papers with resolvable identifiers, format_citations builds a bibliography, and prisma_flow_diagram draws a PRISMA 2020 diagram.',
  'Results are lookups in public databases, not opinions: likely_fabricated means the DOI is not registered or no matching record was found in these databases.',
].join(' ');

/**
 * One server per request: the transport runs stateless, so there is no session
 * to keep, and the caller (for quotas and analytics) is bound at construction.
 */
export function buildMcpServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, title: 'Phở Research Tools', version: SERVER_VERSION, websiteUrl: 'https://pho.chat' },
    { instructions: SERVER_INSTRUCTIONS, capabilities: { tools: {} } },
  );
  registerVerifyReferences(server, ctx);
  registerFormatCitations(server, ctx);
  registerSearchPapers(server, ctx);
  registerCheckRetractions(server, ctx);
  registerPrismaFlowDiagram(server, ctx);
  return server;
}
