# Third-party material

The code in this repository is MIT-licensed (see `LICENSE`). It bundles or calls
the following, each under its own terms:

| Material | Where | License |
| --- | --- | --- |
| Official CSL styles (APA, MLA, Chicago, Harvard, Vancouver, IEEE, AMA) from the [Citation Style Language project](https://github.com/citation-style-language/styles) | `packages/scholar-core/src/csl-styles.generated.ts` | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). Embedded unmodified; changes to those styles must stay under CC BY-SA 3.0. |
| Be Vietnam Pro font | `packages/scholar-core/assets/fonts/` | SIL Open Font License 1.1 (`OFL.txt`) |
| Recorded API responses used as test fixtures | `packages/scholar-core/test/fixtures/cassettes*/` | Crossref metadata (open, no restrictions), OpenAlex (CC0), NCBI E-utilities (public domain, U.S. National Library of Medicine), doi.org handle responses |

## Data sources at run time

The server only reads public, openly licensed scholarly metadata:

- **Crossref** REST API: bibliographic metadata and retraction/correction notices
  (including the Retraction Watch data Crossref publishes openly).
- **PubMed / NCBI E-utilities**: U.S. National Library of Medicine, public domain.
- **OpenAlex**: CC0.
- **doi.org**: DOI resolution.

No paywalled content is fetched, scraped or stored. Please follow each provider's
usage policy, and set `SCHOLAR_CONTACT_EMAIL` so requests go to their polite pools.

## Name and logo

"Phở" and the Phở logo identify the hosted service at pho.chat. The MIT license
covers the code, not the name. If you run a modified fork publicly, please give it a
different name and do not suggest it is operated by Phở.
