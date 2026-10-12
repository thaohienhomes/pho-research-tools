# @pho/scholar-core

Citation verification, formatting, paper search and PRISMA 2020 diagrams.
Pure TypeScript, no AI SDK, no database: the MCP server in `apps/mcp` wraps it.

```ts
import { createFetchHttp, verifyReferences, summarize } from '@pho/scholar-core';

const http = createFetchHttp({ contactEmail: process.env.SCHOLAR_CONTACT_EMAIL });
const results = await verifyReferences(pastedReferenceList, { http, contactEmail: process.env.SCHOLAR_CONTACT_EMAIL });
```

Input: a pasted list in any common style (APA, Vancouver/AMA, MLA, IEEE, Chicago,
Harvard), BibTeX, RIS, CSL-JSON, or bare DOIs.

Each result has one status:

| status | meaning |
| --- | --- |
| `verified` | found, and every cited field agrees with the record |
| `verified_with_corrections` | found, but some fields differ (`mismatches` lists cited vs found) |
| `retracted` | found, and a retraction notice points at it (`retraction.notices`) |
| `ambiguous` | a close but not convincing candidate exists |
| `not_found` | no index has it; books and grey literature often are not indexed, or the sources could not be reached (`notFoundReason`) |
| `likely_fabricated` | the cited DOI does not exist, points at a different paper, or a full search found nothing for an article-like reference |

Sources: Crossref (DOI lookup, `query.bibliographic`, `updated-by` notices incl.
Retraction Watch), PubMed E-utilities, OpenAlex, and the doi.org handle API. Metadata
in a result always comes from one of these records, never from the parser.

## Formatting citations

```ts
import { formatCitations } from '@pho/scholar-core';

const out = formatCitations(results, 'apa', 'text'); // results from verifyReferences
out.content;            // the bibliography, in the style's own order
out.entries[0].inText;  // "(LeCun et al., 2015)"
out.warnings;           // unverified / retracted / corrected entries
```

Styles: `apa` (APA 7), `mla` (MLA 9), `chicago` (Chicago 18 author-date), `harvard`
(Cite Them Right 12), `vancouver` (NLM Citing Medicine), `ieee`, `ama` (AMA 11). Outputs:
`text`, `html`, `bibtex`, `ris`, `csl-json`. Formatting uses citeproc-js (via citation-js)
with the official CSL style files, embedded in `src/csl-styles.generated.ts`
(CC BY-SA 3.0; refresh with `node scripts/sync-csl-styles.mjs`).

A verified reference is formatted from the database record it matched, so the
corrections are applied. Anything unverified is formatted exactly as cited and flagged
(`verified: false`); the formatter never "fixes" a reference from a guessed record.

## Searching papers

```ts
const r = await searchPapers('atrial fibrillation anticoagulation', {
  yearFrom: 2018, yearTo: 2024, openAccessOnly: true, studyTypes: ['rct'], maxResults: 10,
}, { http });
```

Searches OpenAlex and PubMed, merges duplicates, and returns only papers with a DOI or
PMID. Retracted papers and notices (errata, retraction notices) are left out and counted
in `excluded`. Known study types (`rct`, `clinical-trial`, `systematic-review`,
`meta-analysis`, `review`, `guideline`, `cohort`, `case-control`, `case-report`,
`observational`) use PubMed's publication-type filter; each result says whether it
matched by publication type or only by keyword.

## PRISMA 2020 flow diagram

```ts
import { prismaFlowDiagram } from '@pho/scholar-core';
import { svgToPng } from '@pho/scholar-core/png';

const { svg, warnings } = prismaFlowDiagram({ databases: 1200, duplicatesRemoved: 300, /* … */ });
const png = svgToPng(svg); // 2x, Be Vietnam Pro embedded
```

Draws the official template for new reviews, with the "other methods" column when
`otherMethods` counts are given. Every box that follows from the boxes above it is
checked; a disagreement produces a warning naming the expected value, and a box left
out is filled in and marked `derived`. Counts are never silently changed. The PNG
renderer (`@pho/scholar-core/png`) loads a native module and the font files in
`assets/fonts/` (SIL OFL 1.1), so a bundled server must ship that folder.

Sample outputs: `docs/samples/scholar-core/` (regenerate with `pnpm samples`).

## Environment (all optional)

| variable | use |
| --- | --- |
| `SCHOLAR_CONTACT_EMAIL` | sent as `mailto` to Crossref/PubMed/OpenAlex (polite pool, higher limits) |

API keys for PubMed/OpenAlex are passed as `pubmedApiKey` / `openalexApiKey` options.

## Tests

```bash
pnpm --filter @pho/scholar-core test          # unit tests + quality bars on recorded responses
pnpm --filter @pho/scholar-core record        # record missing responses (needs network)
pnpm --filter @pho/scholar-core samples       # rewrite docs/samples/scholar-core
pnpm --filter @pho/scholar-core eval:live     # same tests against the live APIs
```

The quality test runs the 60 references in `test/fixtures/references.json` through the
full pipeline, prints a confusion matrix, and asserts the quality bar: fabricated
detected ≥ 95%, correct references not flagged ≥ 97%, retracted detected 100%.
`test/search.test.ts` runs six searches and resolves every returned DOI through the
doi.org handle API. Responses are recorded under `test/fixtures/cassettes/` and
`test/fixtures/cassettes-search/` (`pnpm record` on a machine with network access), so
the test suite never touches the network.
