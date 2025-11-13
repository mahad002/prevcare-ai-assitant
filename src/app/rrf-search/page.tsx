"use client";

import { useCallback, useState, FormEvent, ChangeEvent } from "react";

interface MatchResult {
  rxcui: string;
  name: string;
  score: number;
  tty: string;
}

interface SearchResponse {
  input: string;
  matches: MatchResult[];
  count: number;
  error?: string;
}

const DEFAULT_TERM = "10 ML morphine sulfate 2 MG/ML Injectable Solution";

export default function RrfSearchPage() {
  const [searchTerm, setSearchTerm] = useState(DEFAULT_TERM);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const performSearch = useCallback(async (term: string) => {
    const trimmed = term.trim();
    setLoading(true);
    setError(null);
    setResults(null);

    if (!trimmed) {
      setError("Search term is required");
      setLoading(false);
      return;
    }

    try {
      const response = await fetch(`/api/rxnconso/approximate?search=${encodeURIComponent(trimmed)}&limit=20`);
      if (!response.ok) {
        const errorJson = await response.json().catch(() => ({}));
        throw new Error(errorJson.error || `Request failed with status ${response.status}`);
      }
      const data: SearchResponse = await response.json();
      setResults(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    await performSearch(searchTerm);
  }, [performSearch, searchTerm]);

  const handleInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(event.target.value);
  }, []);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold text-slate-900">RxNorm RRF Approximate Search</h1>
        <p className="text-sm text-slate-600">
          Search RxNorm medication data using an RxNav-style approximate matcher. Data is read directly from
          the RRF files bundled in <code>public/rrf</code>.
        </p>
      </header>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:flex-row md:items-end">
        <div className="flex flex-1 flex-col gap-2">
          <label htmlFor="searchTerm" className="text-sm font-medium text-slate-700">Medication term</label>
          <input
            id="searchTerm"
            name="searchTerm"
            type="text"
            value={searchTerm}
            onChange={handleInputChange}
            className="w-full rounded border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
            placeholder="Enter a medication term"
          />
        </div>
        <button
          type="submit"
          className="inline-flex items-center justify-center rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800 disabled:opacity-50"
          disabled={loading}
        >
          {loading ? "Searching…" : "Search"}
        </button>
      </form>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p className="font-medium">Error:</p>
          <p>{error}</p>
        </div>
      )}

      {loading && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-600">
          <p>Searching…</p>
        </div>
      )}

      {results && !loading && (
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <header className="flex flex-col gap-1">
              <h2 className="text-lg font-semibold text-slate-900">Search Results ({results.count})</h2>
              <p className="text-sm text-slate-600">
                Scores reflect RxNav-style approximate matching. Ingredients, strengths, dose forms, and routes heavily
                influence ranking.
              </p>
            </header>

            {results.error && (
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
                <p className="font-medium">Note:</p>
                <p>{results.error}</p>
              </div>
            )}

            {results.matches.length === 0 ? (
              <p className="text-sm text-slate-500">No matches found.</p>
            ) : (
              <div className="flex flex-col gap-3">
                {results.matches.map((match, index) => (
                  <details key={`${match.rxcui}-${index}`} className="group rounded border border-slate-200 p-3 transition hover:border-slate-300" open={index < 3}>
                    <summary className="cursor-pointer text-sm font-medium text-slate-800">
                      <div className="flex items-center justify-between">
                        <span>{index + 1}. {match.name}</span>
                        <div className="flex items-center gap-3">
                          <span className="text-xs font-normal text-slate-600">Score: {match.score.toFixed(3)}</span>
                          <span className="rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700">{match.tty}</span>
                        </div>
                      </div>
                    </summary>
                    <div className="mt-3 space-y-2 text-xs text-slate-600">
                      <div className="flex flex-wrap gap-3">
                        <span><span className="font-medium text-slate-700">RXCUI:</span> {match.rxcui}</span>
                        <span><span className="font-medium text-slate-700">TTY:</span> {match.tty}</span>
                      </div>
                      <div className="rounded bg-slate-50 p-2">
                        <span className="font-medium text-slate-700">Match Quality:</span> {(match.score * 100).toFixed(1)}%
                        <div className="mt-1 text-slate-500">
                          {match.score >= 0.9 && "Excellent match"}
                          {match.score >= 0.7 && match.score < 0.9 && "Good match"}
                          {match.score >= 0.5 && match.score < 0.7 && "Fair match"}
                          {match.score < 0.5 && "Weak match"}
                        </div>
                      </div>
                    </div>
                  </details>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs text-slate-600">
            <p><span className="font-medium text-slate-700">Search Algorithm:</span> RxNav-style approximate matching</p>
            <p className="mt-1"><span className="font-medium text-slate-700">Input:</span> <span className="font-mono">{results.input}</span></p>
            <p className="mt-1"><span className="font-medium text-slate-700">Data Source:</span> <code>public/rrf/RXNCONSO.RRF</code></p>
          </section>
        </div>
      )}
    </div>
  );
}
