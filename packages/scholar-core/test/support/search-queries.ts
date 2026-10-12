import type { SearchFilters } from '../../src/search';

/** Queries the search quality test replays; the first one is also the committed sample. */
export const SEARCH_QUERIES: { id: string; query: string; filters: SearchFilters }[] = [
  { id: 'sepsis-years', query: 'sepsis fluid resuscitation', filters: { yearFrom: 2018, yearTo: 2024, maxResults: 10 } },
  { id: 'metformin-meta', query: 'metformin cancer risk', filters: { studyTypes: ['meta-analysis'], maxResults: 8 } },
  {
    id: 'af-rct-oa',
    query: 'atrial fibrillation anticoagulation',
    filters: { studyTypes: ['rct'], openAccessOnly: true, maxResults: 8 },
  },
  { id: 'cs-transformers', query: 'transformer language models attention', filters: { maxResults: 8 } },
  { id: 'dengue-vietnam', query: 'dengue Vietnam', filters: { yearFrom: 2015, maxResults: 8 } },
  { id: 'ivermectin-covid', query: 'ivermectin COVID-19', filters: { maxResults: 10 } },
];
