---
name: verified-citations
description: Use whenever you write, edit or review anything that cites papers (literature reviews, manuscripts, grant text, essays, answers with references). Finds real sources with the Phở Research Tools MCP server, verifies every reference against Crossref, PubMed and OpenAlex before showing it, formats the bibliography from the database record, and flags anything that is fabricated, wrong or retracted.
license: MIT
---

# Verified citations

Language models invent references that look perfect: real author names, real journals, a
plausible DOI, and no paper behind them. They also misremember years, pages and author
order on papers that do exist. This skill makes every reference you show the user one that
a public database has confirmed.

It relies on the **Phở Research Tools** MCP server. Its tools are `search_papers`,
`verify_references`, `format_citations`, `check_retractions` and `prisma_flow_diagram`.
If those tools are not available, see "Without the tools" at the end.

## The rule

**Never show the user a reference that has not been through `verify_references` in this
conversation.** That includes references you remember, references the user pasted, and
references from a search result you then edited.

## Workflow

### 1. Find sources with `search_papers`, not from memory

When you need evidence for a claim or a topic, search instead of recalling:

- Query in English keywords, for example `nirsevimab RSV infants hospitalisation`.
- Narrow with `study_types` (`rct`, `systematic-review`, `meta-analysis`, `guideline`,
  `cohort`, …), `year_from` / `year_to`, and `open_access_only` when the user needs full text.
- Every result has a DOI or PubMed ID that resolves. Retracted papers are left out.
- Results marked `preprint: true` are not peer reviewed. Say so whenever you cite one.

Read the abstract before citing a paper for a specific claim. A title that sounds right is
not evidence that the paper supports the sentence.

### 2. Verify with `verify_references` before showing anything

Pass the whole reference list in one call (up to 50 references), in any style, BibTeX,
RIS, or DOIs one per line. Each reference comes back with exactly one status:

| Status | What to do |
| --- | --- |
| `verified` | Use it. |
| `verified_with_corrections` | The paper is real but a detail is wrong. Use the `corrected` record and tell the user which field changed. |
| `retracted` | Remove it. Only cite it if the text is about the retraction, and then say it is retracted. |
| `likely_fabricated` | The DOI is not registered or no such paper exists. Remove it and tell the user. Never "fix" it by guessing another paper. |
| `not_found` | Could not be confirmed either way (common for books, theses, reports, very new papers). Keep it only if the user can confirm it, and mark it unverified. |
| `ambiguous` | Several papers fit. Add a DOI or more detail and verify again, or ask the user. |
| `not_checked` | The allowance ran out before this one. Say so; do not present it as checked. |

### 3. Format with `format_citations`

Format only after verifying. Pass `style` (`apa`, `mla`, `chicago`, `harvard`, `vancouver`,
`ieee`, `ama`), or set `output` to `bibtex`, `ris` or `csl-json` for a reference manager.
Verified references are formatted from the database record, so the bibliography carries the
corrected details. If you already verified the list in this conversation, pass
`verify: false` to skip the second lookup.

Use the in-text citations the tool returns so the citations and the bibliography match.

### 4. Report what was not verified

End every answer that contains references with one short line on their state, for example:

> References: 7 verified, 1 corrected (year), 1 removed as fabricated.

If anything was removed or is unverified, name it. The user should never discover a bad
reference after submitting.

## Reviewing someone else's text

When the user asks you to check a manuscript, thesis or reference list:

1. Run `verify_references` on the full list.
2. Report problems first, grouped by status, each with the cited text and what the
   database says (`mismatches` lists field, cited value and found value).
3. Offer the corrected list through `format_citations` in their style, or as BibTeX / RIS.

For a list of DOIs where only retractions matter, `check_retractions` is faster.

## Systematic reviews

For a PRISMA 2020 flow diagram, call `prisma_flow_diagram` with the record counts. It
returns the diagram and a warning for every box whose numbers do not add up. Show those
warnings; never adjust the user's counts silently.

## Without the tools

If the Phở Research Tools server is not connected, do not fall back to references from
memory. Tell the user that references cannot be verified in this session, and point them to:

- Connect the server: `https://mcp.pho.chat/mcp` (no account needed), or
- Paste the list into the free checker at https://pho.chat/tools/citation-checker/

Then mark every reference you write as unverified.
