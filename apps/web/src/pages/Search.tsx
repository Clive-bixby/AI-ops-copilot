import { useState } from 'react';
import { apiCall } from '../lib/api';

interface SearchResult {
  content: string;
  similarity: number;
  documentId: string;
  chunkIndex: number;
  preview: string;
}

export function Search() {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(5);
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setLoading(true);
    try {
      const data = await apiCall('/ai/search', {
        method: 'POST',
        body: JSON.stringify({ query, limit }),
      });
      setResults((data as any).results || []);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 md:p-8 bg-background custom-scrollbar w-full pb-24">
      <div className="max-w-7xl mx-auto space-y-6">
        <h2 className="font-headline-xl text-[28px] md:text-[36px] text-on-surface font-extrabold tracking-tight leading-none">Semantic Search</h2>
        <div className="flex gap-3">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search knowledge base..."
            className="flex-1 bg-surface border border-outline-variant/20 rounded-xl px-4 py-2 text-on-surface"
          />
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))} className="bg-surface border border-outline-variant/20 rounded-xl px-3 text-on-surface">
            {[3, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
          <button onClick={handleSearch} disabled={loading} className="bg-primary text-on-primary px-4 py-2 rounded-xl font-bold disabled:opacity-50">
            {loading ? 'Searching...' : 'Search'}
          </button>
        </div>
        <div className="space-y-3">
          {results.map((r, i) => (
            <div key={i} className="bg-surface-container-low border border-outline-variant/15 rounded-xl p-4">
              <div className="text-xs text-on-surface-variant/60 mb-2">doc {r.documentId} chunk {r.chunkIndex} · similarity {r.similarity?.toFixed(3)}</div>
              <p className="text-sm text-on-surface">{r.preview || r.content}</p>
            </div>
          ))}
          {results.length === 0 && !loading && <div className="text-on-surface-variant/60">No results.</div>}
        </div>
      </div>
    </div>
  );
}
