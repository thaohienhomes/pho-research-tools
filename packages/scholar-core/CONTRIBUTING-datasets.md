# Adding a dataset repository

`load_dataset` opens one dataset from a public repository and returns its licence,
files, column schema, a preview of up to 100 rows, a citation and download
commands. Each repository is one **adapter**: a single file that answers five
questions about that repository. Zenodo, Figshare, Dryad, Hugging Face and OpenML
ship today. Adding another (Dataverse, OSF, Mendeley Data, PANGAEA, Kaggle, a
national data portal…) is one file, one line in the registry, and tests.

## What qualifies

- **An open, documented API** that lists a record's files with their sizes. No
  scraping, no browser automation, no paywalled content.
- **Files you can fetch over HTTPS** from a fixed, short list of hosts (the
  repository itself plus its storage, e.g. an S3 bucket it redirects to).
- **Licence metadata** on the record. A repository without it still works, but
  every dataset will say "Licence unclear", which helps nobody.

## The interface

`src/data/types.ts`:

```ts
interface DatasetAdapter {
  id: DatasetAdapterId;              // 'zenodo', 'figshare', …: add yours to the union
  name: string;                      // shown to users: 'Zenodo'
  homepage: string;
  downloadHosts: readonly string[];  // where file bytes may come from: 'zenodo.org', '*.hf.co'
  parseRef(input: string): string | null;
  search(query, ctx, opts?): Promise<Outcome<DatasetSummary[]>>;
  describe(id, ctx): Promise<Outcome<DatasetDescription>>;
  sample(desc, ctx, opts): Promise<Outcome<DatasetSample>>;
}
```

| Method | Job | Rules |
| --- | --- | --- |
| `parseRef` | Turn a link, DOI or `yours:123` into your record id. | Return `null` for anything that is not clearly yours. Never guess: a DOI from another registrant is not yours. |
| `search` | Free-text search, newest API you have. | If the repository has no search (OpenML), do the best honest lookup and say so in a comment. |
| `describe` | One record: title, creators, licence, files, related papers, notes. | Licence goes through `licenceVerdict()` from `src/licence.ts`, never a verdict you write yourself. Files that need an account get `needsAuth: true`. Anything a user should know (embargo, link-only files, partial listing) goes in `notes`, in one plain sentence each. |
| `sample` | Up to 100 rows. | If the repository serves rows (Hugging Face's dataset viewer), use that and set `origin: 'repository'`. Otherwise call `readTabularHead()` from `src/data/common.ts`: it picks the first CSV/TSV/ARFF/JSON Lines file and reads its first 512 KB. |

`declaredSchema` on the description is optional. Fill it when the repository
publishes column types (OpenML features, Hugging Face features): declared types
beat types guessed from 100 rows, and the result says which one it used.

## The two network doors

Adapters never call `fetch`.

- `ctx.http` for **JSON metadata**. It is cached (a day for dataset hosts) and
  replayed from cassettes in tests. Status `0` means "could not ask", which is a
  different fact from `404`.
- `ctx.bytes` for **file bytes**. It is capped (`maxBytes`), HTTPS only, checks
  `downloadHosts` on the first request **and every redirect**, never forwards
  `Authorization` or `Cookie` to a different host, and asks for a byte range
  when sampling. Not cached.

If a file host redirects somewhere new (presigned S3 URLs are common), add that
host to `downloadHosts` explicitly. Wildcards are fine for a vendor's own
subdomains (`*.hf.co`), never for a shared cloud (`*.s3.amazonaws.com` would
let any bucket through). Figshare's regional S3 endpoint is listed by exact host
because Figshare's own download service redirects there (a known, accepted
trade-off: reads are capped, read-only and never carry credentials).

Tokens (`ctx.hfToken`, `ctx.dryadToken`) are optional and come from the server's
environment. Without one, a gated file is listed with `needsAuth: true` and the
user is told where to download it by hand. Never fail the whole record because
one file needs an account.

## Step by step

1. **Read the live API first.** Fetch one real record and one search, keep the
   JSON, and write the adapter against what came back, not against the docs
   alone. Note the date you checked in the file header.
2. Add your id to `DatasetAdapterId` in `src/data/types.ts`.
3. Write `src/data/sources/<yours>.ts`, modelled on `zenodo.ts` (simplest) or
   `openml.ts` (declared schema).
4. Add it to `DATASET_ADAPTERS` in `src/data/registry.ts`. Order matters only
   for `parseRef`: put specific patterns before broad ones.
5. If your API host should refresh daily, add it to `DAILY` in
   `apps/mcp/src/app.ts`.
6. If `downloadPlan()` in `src/data/load.ts` should emit an idiomatic Python
   loader for your repository (like `openml.datasets.get_dataset`), add it there.
7. Tests in `src/__tests__/data.test.ts`:
   - `parseRef` accepts your link, DOI and short id, and rejects others.
   - `describe` with a fake `http` built from the real JSON you saved (trim it
     to the fields you read): licence, files, papers, notes.
   - `sample` with a fake `bytes`: rows come out, and the request asked only
     your hosts.
   - Anything that needs an account is `needsAuth`, never a hard failure.
8. `pnpm --filter @pho/scholar-core typecheck && pnpm --filter @pho/scholar-core test`
   and `pnpm --filter @pho/mcp test`.

## Things we will ask about in review

- Does a missing field produce a missing value, or an invented one? Only the
  first is acceptable.
- Is every number (size, row count, checksum) from the repository?
- Is text from the record (titles, descriptions, cells) passed through as data?
  It is written by uploaders and must never be treated as instructions.
- Could a hostile record make the server fetch from a host you did not list?
- Does the error message say what the user can do next?
