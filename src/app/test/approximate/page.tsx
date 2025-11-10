"use client";

import type { ChangeEvent, FormEvent } from "react";
import { useCallback, useEffect, useState } from "react";
import { callOpenAIRaw } from "../../../lib/api";
import { medicationTextNormalizationPrompt } from "../../../lib/prompts";
import {
  findBestStringMatch,
  type BestMatchResult,
  findBestStringMatchWithLLM,
  type LlmMatchResult,
} from "../../../lib/stringMatching";

type ApproximateCandidate = Record<string, unknown>;

type ApproximateSearchResult = {
  term: string;
  candidates: ApproximateCandidate[];
  raw: unknown;
  error?: string;
};

type NormalizationResult = {
  normalized: string;
  normalizedForSearch: string;
  note?: string | null;
  raw: unknown;
  error?: string;
};

type CandidateInfo = {
  name: string;
  rxcui?: string | null;
};

type OpenFdaApiResult = {
  product_ndc?: string;
  package_ndc?: string;
  brand_name?: string;
  generic_name?: string;
  dosage_form?: string;
  route?: string | string[];
  labeler_name?: string;
  manufacturer_name?: string | string[];
  marketing_category?: string;
  spl_set_id?: string;
  openfda?: {
    brand_name?: string[];
    generic_name?: string[];
    dosage_form?: string[];
    route?: string[];
    manufacturer_name?: string[];
    spl_set_id?: string[] | string;
  };
  [key: string]: unknown;
};

type DailyMedRow = Record<string, string | number | null | undefined>;

type RxCuiLineageEntry = {
  ndc11: string;
  ndc10Display: string;
  ndc10Base: string;
  ndcCandidates: string[];
  openFda?: {
    usedQuery: string;
    productNdc?: string;
    brandName?: string;
    genericName?: string;
    dosageForm?: string;
    route?: string;
    manufacturerName?: string;
    marketingCategory?: string;
    splSetId?: string | null;
  };
  dailyMed?: {
    usedNdc: string;
    lookupUrl: string;
    setId: string | null;
    setIdFilterUrl: string | null;
    title: string | null;
    publishedDate: string | null;
    splVersion: number | null;
    ndcsUrl: string | null;
  };
  errors: string[];
};

function convertNdc11ToDisplay(ndc: string): {
  display10: string;
  base10: string;
  candidates10: string[];
} {
  const digitsOnly = ndc.replace(/[^\d]/g, "");
  if (digitsOnly.length === 11) {
    const labelerRaw = digitsOnly.slice(0, 5);
    const productRaw = digitsOnly.slice(5, 9);
    const packageRaw = digitsOnly.slice(9);

    let labeler = labelerRaw;
    let product = productRaw;
    let pkg = packageRaw;

    if (labeler.startsWith("0")) {
      labeler = labeler.slice(1);
    } else if (product.startsWith("0")) {
      product = product.slice(1);
    } else if (pkg.startsWith("0")) {
      pkg = pkg.slice(1);
    }

    const display = `${labeler}-${product}-${pkg}`;
    const base = `${labeler}-${product}`;
    const candidates10 = Array.from(new Set([display, base]));

    return {
      display10: display,
      base10: base,
      candidates10,
    };
  }

  if (digitsOnly.length === 10) {
    const labeler = digitsOnly.slice(0, 4);
    const product = digitsOnly.slice(4, 8);
    const pkg = digitsOnly.slice(8);
    const display = `${labeler}-${product}-${pkg}`;
    const base = `${labeler}-${product}`;
    return {
      display10: display,
      base10: base,
      candidates10: Array.from(new Set([display, base])),
    };
  }

  const fallbackDisplay = ndc.includes("-") ? ndc : ndc;
  const base = fallbackDisplay.includes("-")
    ? fallbackDisplay.split("-").slice(0, 2).join("-")
    : fallbackDisplay;
  return {
    display10: fallbackDisplay,
    base10: base,
    candidates10: Array.from(new Set([fallbackDisplay, base])),
  };
}

const MAX_ENTRIES = 100;
const DEFAULT_TERM = "metformin hydrochloride 500 mg oral tablet";

const CANONICAL_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bACTUATIONS?\b/gi, "ACTUAT"],
  [/\bGRAMS?\b/gi, "GM"],
  [/\bMILLIGRAMS?\b/gi, "MG"],
  [/\bMICROGRAMS?\b/gi, "MCG"],
  [/\bINHALATION\b/gi, "INHAL"],
  [/\bSPRAYS?\b/gi, "AEROSOL"],
  [/\bPOWDER FOR ORAL SUSPENSION\b/gi, "POWDER FOR SUSPENSION"],
  [/\bORAL POWDER FOR SUSPENSION\b/gi, "POWDER FOR SUSPENSION"],
  [/\bCAPSULES?\b/gi, "CAP"],
  [/\bTABLETS?\b/gi, "TAB"],
  [/\bSUSPENSION\b/gi, "SUSP"],
  [/\bSOLUTION\b/gi, "SOL"],
  [/\bLIQUID\b/gi, "SOL"],
];

function canonicalizeNormalizedTerm(term: string): string {
  let canonical = term.toUpperCase();
  for (const [pattern, replacement] of CANONICAL_REPLACEMENTS) {
    canonical = canonical.replace(pattern, replacement);
  }
  return canonical.replace(/\s+/g, " ").replace(/[,]+/g, "").trim();
}

async function fetchApproximateCandidates(term: string): Promise<ApproximateSearchResult> {
  const cleanTerm = term.trim();
  if (!cleanTerm) {
    return { term: cleanTerm, candidates: [], raw: null, error: "Search term was empty." };
  }

  const url = `https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=${encodeURIComponent(
    cleanTerm
  )}&maxEntries=${MAX_ENTRIES}`;

  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) {
      return {
        term: cleanTerm,
        candidates: [],
        raw: null,
        error: `Request failed with status ${res.status}`,
      };
    }
    const json = await res.json();
    const candidates: ApproximateCandidate[] =
      json?.approximateGroup?.candidate && Array.isArray(json.approximateGroup.candidate)
        ? json.approximateGroup.candidate
        : [];
    return {
      term: cleanTerm,
      candidates,
      raw: json,
    };
  } catch (err) {
    return {
      term: cleanTerm,
      candidates: [],
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function normalizeTermWithLLM(term: string): Promise<NormalizationResult> {
  const trimmed = term.trim();
  if (!trimmed) {
    return { normalized: "", normalizedForSearch: "", raw: null, error: "Input was empty." };
  }

  try {
    const prompt = medicationTextNormalizationPrompt(trimmed);
    const { parsed, http } = await callOpenAIRaw("gpt-4o", prompt);

    if (!http.ok) {
      return {
        normalized: trimmed,
        normalizedForSearch: canonicalizeNormalizedTerm(trimmed),
        raw: parsed,
        error: `OpenAI error ${http.status}`,
      };
    }

    const normalizedFromLLM = (parsed?.normalized as string | undefined)?.trim();
    const note = typeof parsed?.note === "string" ? parsed.note : null;

    const normalized = normalizedFromLLM && normalizedFromLLM.length > 0 ? normalizedFromLLM : trimmed;
    const normalizedForSearch = canonicalizeNormalizedTerm(normalized);

    return {
      normalized,
      normalizedForSearch,
      note,
      raw: parsed,
    };
  } catch (err) {
    return {
      normalized: trimmed,
      normalizedForSearch: canonicalizeNormalizedTerm(trimmed),
      note: null,
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

type ResultCardProps = {
  title: string;
  subtitle: string;
  result: ApproximateSearchResult | null;
  loading: boolean;
  explicitTerm?: string | null;
  showHeader?: boolean;
};

function ResultCard({
  title,
  subtitle,
  result,
  loading,
  explicitTerm,
  showHeader = true,
}: ResultCardProps) {
  const termToShow = explicitTerm ?? result?.term ?? "";

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      {showHeader ? (
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
          <p className="text-sm text-slate-600">{subtitle}</p>
          {termToShow ? (
            <p className="text-xs text-slate-500">
              Query term: <span className="font-mono">{termToShow}</span>
            </p>
          ) : null}
        </header>
      ) : null}

      {!showHeader && termToShow ? (
        <p className="text-xs text-slate-500">
          Query term: <span className="font-mono">{termToShow}</span>
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-slate-500">Searching…</p>
      ) : result?.error ? (
        <p className="text-sm text-red-600">Error: {result.error}</p>
      ) : result ? (
        <>
          <div className="rounded border border-slate-100 bg-slate-50 p-3 text-xs text-slate-600">
            Found {result.candidates.length} candidate{result.candidates.length === 1 ? "" : "s"}.
          </div>

          <div className="flex flex-col gap-2">
            {result.candidates.length === 0 ? (
              <p className="text-sm text-slate-500">No candidates returned for this term.</p>
            ) : (
              (() => {
                const named = result.candidates.filter(
                  (candidate) => typeof candidate.name === "string" && candidate.name.trim()
                );
                const unnamed = result.candidates.filter(
                  (candidate) => !named.includes(candidate)
                );
                const ordered = [...named, ...unnamed];

                return ordered.map((candidate, index) => {
                  const ordinal = index + 1;
                  const hasName = typeof candidate.name === "string" && candidate.name.trim();
                  const displayName = hasName ? String(candidate.name).trim() : "(no name provided)";
                  const score = candidate.score ?? "?";
                  return (
                    <details
                      key={`${candidate.rxcui ?? candidate.name ?? ordinal}-${ordinal}`}
                      className="group rounded border border-slate-200 p-3 transition hover:border-slate-300"
                      open={index < 3}
                    >
                      <summary className="cursor-pointer text-sm font-medium text-slate-800">
                        Candidate {ordinal}: {displayName} (score {String(score)})
                      </summary>
                      <pre className="mt-2 overflow-x-auto rounded bg-slate-900/90 p-3 text-xs text-slate-100">
                        {JSON.stringify(candidate, null, 2)}
                      </pre>
                    </details>
                  );
                });
              })()
            )}
          </div>

          <details className="rounded border border-slate-200 p-3">
            <summary className="cursor-pointer text-sm font-medium text-slate-800">
              Full JSON payload
            </summary>
            <pre className="mt-2 overflow-x-auto rounded bg-slate-900/90 p-3 text-xs text-slate-100">
              {JSON.stringify(result.raw, null, 2)}
            </pre>
          </details>
        </>
      ) : (
        <p className="text-sm text-slate-500">Enter a search term to see results.</p>
      )}
    </section>
  );
}

export default function ApproximateSearchComparisonPage() {
  const [searchTerm, setSearchTerm] = useState<string>(DEFAULT_TERM);
  const [directResult, setDirectResult] = useState<ApproximateSearchResult | null>(null);
  const [normalizedResult, setNormalizedResult] = useState<ApproximateSearchResult | null>(null);
  const [normalization, setNormalization] = useState<NormalizationResult | null>(null);
  const [candidateInfos, setCandidateInfos] = useState<CandidateInfo[]>([]);
  const [bestMatch, setBestMatch] = useState<BestMatchResult | null>(null);
  const [llmMatch, setLlmMatch] = useState<LlmMatchResult | null>(null);
  const [finalMatch, setFinalMatch] = useState<
    | {
        name: string;
        source: "hybrid" | "llm";
        reason?: string | null;
        similarity?: number | null;
        rxcui?: string | null;
      }
    | null
  >(null);
  const [matching, setMatching] = useState(false);
  const [matchingError, setMatchingError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gatherCandidateInfo = useCallback(
    (...results: Array<ApproximateSearchResult | null>) => {
      const namesSet = new Set<string>();
      const metadataMap = new Map<string, CandidateInfo>();
      for (const result of results) {
        if (!result?.candidates) continue;
        for (const candidate of result.candidates) {
          const name = candidate.name as string | undefined;
          if (!name || !name.trim()) continue;
          const trimmed = name.trim();
          if (!metadataMap.has(trimmed)) {
            metadataMap.set(trimmed, {
              name: trimmed,
              rxcui:
                typeof candidate.rxcui === "string"
                  ? candidate.rxcui
                  : typeof candidate.rxcui === "number"
                  ? String(candidate.rxcui)
                  : undefined,
            });
          }
          namesSet.add(trimmed);
        }
      }
      return {
        names: Array.from(namesSet),
        metadata: Array.from(metadataMap.values()),
      };
    },
    []
  );

  const findCandidateInfo = useCallback(
    (name: string | null | undefined): CandidateInfo | null => {
      if (!name) return null;
      const target = name.trim().toLowerCase();
      return (
        candidateInfos.find((info) => info.name.trim().toLowerCase() === target) ?? null
      );
    },
    [candidateInfos]
  );

  const performSearch = useCallback(
    async (term: string) => {
      const trimmed = term.trim();
      setLoading(true);
      setError(null);

      if (!trimmed) {
        const emptyResult: ApproximateSearchResult = {
          term: "",
          candidates: [],
          raw: null,
          error: "Input was empty.",
        };
        setDirectResult(emptyResult);
        setNormalization({
          normalized: "",
          normalizedForSearch: "",
          raw: null,
          error: "Input was empty.",
        });
        setNormalizedResult(emptyResult);
        setError("Input was empty.");
        setLoading(false);
        return;
      }

      try {
        const [direct, normalizationResult] = await Promise.all([
          fetchApproximateCandidates(trimmed),
          normalizeTermWithLLM(trimmed),
        ]);

        let normalizedSearch: ApproximateSearchResult;
        if (normalizationResult.normalizedForSearch) {
          normalizedSearch = await fetchApproximateCandidates(
            normalizationResult.normalizedForSearch
          );
        } else {
          normalizedSearch = {
            term: "",
            candidates: [],
            raw: null,
            error: normalizationResult.error ?? "Normalization did not provide a search term.",
          };
        }

        setDirectResult(direct);
        setNormalizedResult(normalizedSearch);
        setNormalization(normalizationResult);

        const { names: candidateNames, metadata } = gatherCandidateInfo(direct, normalizedSearch);
        setCandidateInfos(metadata);
        const metadataMap = new Map(
          metadata.map((info) => [info.name.trim().toLowerCase(), info])
        );
        if (candidateNames.length > 0) {
          setMatching(true);
          try {
            const best = await findBestStringMatch(trimmed, candidateNames);
            setBestMatch(best);
            setMatchingError(null);

            const defaultFinalName = best.candidate ?? candidateNames[0];
            const defaultInfo = metadataMap.get(defaultFinalName.trim().toLowerCase());
            setFinalMatch({
              name: defaultFinalName,
              source: "hybrid",
              reason: best.reason,
              similarity: best.similarityScore,
              rxcui: defaultInfo?.rxcui ?? null,
            });

            const rankedEvaluated = [...best.evaluated].sort(
              (a, b) => b.adjustedScore - a.adjustedScore
            );
            const llmPayload = rankedEvaluated.slice(0, 5).map((entry) => ({
              name: entry.candidate,
              adjustedScore: entry.adjustedScore,
              similarity: entry.similarityScore,
              semanticScore: entry.semanticScore,
              lexicalScore: entry.lexicalScore,
            }));

            const llmResult = await findBestStringMatchWithLLM(trimmed, llmPayload);
            setLlmMatch(llmResult);

            if (llmResult?.bestMatch && llmResult.ranked.length > 0) {
              const topRanked = llmResult.ranked[0];
              if (topRanked.similarity >= 0.9) {
                const info = metadataMap.get(llmResult.bestMatch.trim().toLowerCase());
                setFinalMatch({
                  name: llmResult.bestMatch,
                  source: "llm",
                  reason: llmResult.reason,
                  similarity: topRanked.similarity,
                  rxcui: info?.rxcui ?? null,
                });
              }
            }
          } catch (matchErr) {
            setBestMatch(null);
            setMatchingError(
              matchErr instanceof Error ? matchErr.message : String(matchErr)
            );
            setFinalMatch(null);
            setLlmMatch(null);
          } finally {
            setMatching(false);
          }
        } else {
          setBestMatch(null);
          setMatchingError("No candidate strings available for comparison.");
          setFinalMatch(null);
          setLlmMatch(null);
        }

        const errors = [
          direct.error,
          normalizationResult.error,
          normalizedSearch.error,
        ].filter(Boolean);
        setError(errors.length ? errors.join(" | ") : null);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [gatherCandidateInfo]
  );

  useEffect(() => {
    void performSearch(DEFAULT_TERM);
  }, [performSearch]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      await performSearch(searchTerm);
    },
    [performSearch, searchTerm]
  );

  const handleInputChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(event.target.value);
  }, []);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold text-slate-900">
          Approximate Term Comparison
        </h1>
        <p className="text-sm text-slate-600">
          Compare RxNorm approximateTerm results using the raw input versus an LLM-normalized version
          of the same text. Candidates are shown with their complete JSON payloads so you can inspect
          every field returned.
        </p>
      </header>

      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:flex-row md:items-end"
      >
        <div className="flex flex-1 flex-col gap-2">
          <label htmlFor="searchTerm" className="text-sm font-medium text-slate-700">
            Medication term
          </label>
          <input
            id="searchTerm"
            name="searchTerm"
            type="text"
            value={searchTerm}
            onChange={handleInputChange}
            className="w-full rounded border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
            placeholder="Enter a medication term (e.g., 'metformin 500 mg tablet')"
          />
        </div>

        <button
          type="submit"
          className="inline-flex items-center justify-center rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800"
          disabled={loading}
        >
          {loading ? "Searching…" : "Compare"}
        </button>
      </form>

      {finalMatch ? (
        <section className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900 shadow-sm">
          <div className="flex flex-col gap-1">
            <span className="text-xs font-medium uppercase tracking-wide text-emerald-700">
              Final match ({finalMatch.source === "llm" ? "LLM re-rank" : "Hybrid score"})
            </span>
            <span className="font-mono text-base text-emerald-900">{finalMatch.name}</span>
            {finalMatch.rxcui ? (
              <span className="text-xs text-emerald-700">RxCUI: {finalMatch.rxcui}</span>
            ) : null}
            {typeof finalMatch.similarity === "number" ? (
              <span className="text-xs text-emerald-700">
                Similarity: {finalMatch.similarity.toFixed(3)}
              </span>
            ) : null}
            {finalMatch.reason ? (
              <span className="text-xs text-emerald-700">{finalMatch.reason}</span>
            ) : null}
          </div>
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <details className="rounded-lg border border-slate-200 bg-white shadow-sm" open>
          <summary className="cursor-pointer border-b border-slate-200 px-4 py-3 text-sm font-medium text-slate-900 transition hover:bg-slate-50">
            Direct approximateTerm search
          </summary>
          <div className="p-4">
            <ResultCard
              title="Direct approximateTerm search"
              subtitle="Uses your input text as-is."
              result={directResult}
              loading={loading}
              showHeader={false}
            />
          </div>
        </details>

        <details className="rounded-lg border border-slate-200 bg-white shadow-sm" open>
          <summary className="cursor-pointer border-b border-slate-200 px-4 py-3 text-sm font-medium text-slate-900 transition hover:bg-slate-50">
            Normalized approximateTerm search
          </summary>
          <div className="p-4">
            <ResultCard
              title="Normalized approximateTerm search"
              subtitle={
                normalization?.normalized
                  ? `LLM-normalized term: ${normalization.normalized}`
                  : "Awaiting normalization…"
              }
              result={normalizedResult}
              loading={loading}
              explicitTerm={normalization?.normalizedForSearch ?? null}
              showHeader={false}
            />
          </div>
        </details>
      </div>

      <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-slate-900">Hybrid best-match picker</h2>
          <p className="text-sm text-slate-600">
            Combines OpenAI embeddings (`text-embedding-3-large`) with lexical token overlap to pick
            the closest candidate.
          </p>
        </header>

        {matching ? (
          <p className="text-sm text-slate-500">Scoring candidates…</p>
        ) : matchingError ? (
          <p className="text-sm text-red-600">{matchingError}</p>
        ) : bestMatch?.candidate ? (
          (() => {
            const bestInfo = findCandidateInfo(bestMatch.candidate);
            return (
              <>
                <div className="rounded border border-slate-100 bg-slate-50 p-3 text-sm text-slate-700">
                  <div>
                    <span className="font-medium text-slate-900">Best match:</span>{" "}
                    <span className="font-mono">{bestMatch.candidate}</span>
                  </div>
                  {bestInfo?.rxcui ? (
                    <div className="text-xs text-slate-500">RxCUI: {bestInfo.rxcui}</div>
                  ) : null}
                  <div>
                    <span className="font-medium text-slate-900">Combined similarity:</span>{" "}
                    {bestMatch.similarityScore.toFixed(3)}
                  </div>
                  <div className="text-xs text-slate-500">
                    Semantic {bestMatch.semanticScore.toFixed(3)} • Lexical {bestMatch.lexicalScore.toFixed(3)}
                  </div>
                  <div className="mt-2 text-xs text-slate-600">{bestMatch.reason}</div>
                </div>

                <details className="rounded border border-slate-200 p-3">
                  <summary className="cursor-pointer text-sm font-medium text-slate-800">
                    Candidate scores
                  </summary>
                  <ul className="mt-2 space-y-2 text-xs text-slate-600">
                    {bestMatch.evaluated.map((entry) => {
                      const info = findCandidateInfo(entry.candidate);
                      return (
                        <li key={entry.candidate} className="rounded border border-slate-100 p-2">
                          <div className="font-mono text-slate-800">{entry.candidate}</div>
                          {info?.rxcui ? (
                            <div className="text-[11px] text-slate-500">RxCUI: {info.rxcui}</div>
                          ) : null}
                          <div>
                            semantic {entry.semanticScore.toFixed(3)} • lexical {entry.lexicalScore.toFixed(3)}
                          </div>
                          <div>
                            blended {entry.similarityScore.toFixed(3)} • adjusted {entry.adjustedScore.toFixed(3)}
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </details>
                {llmMatch ? (
                  <div className="rounded border border-indigo-100 bg-indigo-50 p-3 text-sm text-indigo-800">
                    <div className="font-medium text-indigo-900">
                      GPT-4o-mini verification: {llmMatch.bestMatch ?? "(no selection)"}
                    </div>
                    {llmMatch.reason ? (
                      <div className="text-xs text-indigo-700">{llmMatch.reason}</div>
                    ) : null}
                    {llmMatch.bestMatch ? (
                      (() => {
                        const info = findCandidateInfo(llmMatch.bestMatch);
                        return info?.rxcui ? (
                          <div className="text-[11px] text-indigo-700">RxCUI: {info.rxcui}</div>
                        ) : null;
                      })()
                    ) : null}
                    {llmMatch.ranked.length ? (
                      <details className="mt-2 rounded border border-indigo-200 p-2">
                        <summary className="cursor-pointer text-xs font-medium text-indigo-800">
                          Ranked suggestions
                        </summary>
                        <ul className="mt-2 space-y-1 text-[11px] text-indigo-700">
                          {llmMatch.ranked.map((entry) => {
                            const info = findCandidateInfo(entry.name);
                            return (
                              <li key={`${entry.name}-${entry.similarity.toFixed(3)}`}>
                                <span className="font-mono text-indigo-900">{entry.name}</span>
                                {info?.rxcui ? ` (RxCUI: ${info.rxcui})` : ""} – similarity
                                {" "}
                                {entry.similarity.toFixed(3)}
                              </li>
                            );
                          })}
                        </ul>
                      </details>
                    ) : null}
                  </div>
                ) : null}
              </>
            );
          })()
        ) : (
          <p className="text-sm text-slate-500">
            No best match available yet. Run a search to populate candidates.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <header className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-slate-900">Normalization details</h2>
          <p className="text-sm text-slate-600">
            The normalization step asks GPT-4o to reformat the input into a canonical RxNorm-style
            phrase before running the second approximate term query.
          </p>
        </header>

        {loading && !normalization ? (
          <p className="text-sm text-slate-500">Normalizing…</p>
        ) : normalization ? (
          <>
            <div className="rounded border border-slate-100 bg-slate-50 p-3 text-sm text-slate-700">
              <div>
                <span className="font-medium text-slate-900">Normalized term:</span>{" "}
                <span className="font-mono">{normalization.normalized || "(empty)"}</span>
              </div>
              <div>
                <span className="font-medium text-slate-900">Search term used:</span>{" "}
                <span className="font-mono">
                  {normalization.normalizedForSearch || "(none)"}
                </span>
              </div>
              {normalization.note ? (
                <div className="mt-2 text-xs text-slate-600">{normalization.note}</div>
              ) : null}
              {normalization.error ? (
                <div className="mt-2 text-xs text-red-600">
                  Normalization error: {normalization.error}
                </div>
              ) : null}
            </div>

            <details className="rounded border border-slate-200 p-3">
              <summary className="cursor-pointer text-sm font-medium text-slate-800">
                LLM JSON payload
              </summary>
              <pre className="mt-2 overflow-x-auto rounded bg-slate-900/90 p-3 text-xs text-slate-100">
                {JSON.stringify(normalization.raw, null, 2)}
              </pre>
            </details>
          </>
        ) : (
          <p className="text-sm text-slate-500">
            Submit a query to view normalization output from the LLM.
          </p>
        )}
      </section>

      {llmMatch?.bestMatch ? (
        <section className="flex flex-col gap-3 rounded-lg border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-800">
          <header className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-indigo-900">LLM re-ranking</h2>
            <span className="text-xs uppercase tracking-wide text-indigo-600">GPT-4o-mini</span>
          </header>
          <div className="rounded border border-indigo-100 bg-white/60 p-3 text-sm text-indigo-900">
            <div className="font-mono text-indigo-900">{llmMatch.bestMatch}</div>
            {(() => {
              const info = findCandidateInfo(llmMatch.bestMatch);
              return info?.rxcui ? (
                <div className="text-[11px] text-indigo-700">RxCUI: {info.rxcui}</div>
              ) : null;
            })()}
            {llmMatch.reason ? (
              <div className="mt-1 text-xs text-indigo-700">{llmMatch.reason}</div>
            ) : null}
          </div>
          {llmMatch.ranked.length ? (
            <details className="rounded border border-indigo-200 bg-indigo-100/60 p-3">
              <summary className="cursor-pointer text-sm font-medium text-indigo-900">
                Ranked candidates
              </summary>
              <ul className="mt-2 space-y-2 text-xs text-indigo-800">
                {llmMatch.ranked.map((entry) => {
                  const info = findCandidateInfo(entry.name);
                  return (
                    <li key={`${entry.name}-${entry.similarity.toFixed(3)}`} className="rounded border border-indigo-200 bg-white/80 p-2">
                      <div className="font-mono text-indigo-900">{entry.name}</div>
                      {info?.rxcui ? (
                        <div className="text-[11px] text-indigo-700">RxCUI: {info.rxcui}</div>
                      ) : null}
                      <div className="text-[11px] text-indigo-700">Similarity {entry.similarity.toFixed(3)}</div>
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}

      {finalMatch?.rxcui ? (
        <RxCuiLineage rxcui={finalMatch.rxcui} selectionName={finalMatch.name} />
      ) : null}

      {error ? (
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-700">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function RxCuiLineage({ rxcui, selectionName }: { rxcui: string; selectionName: string }) {
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [entries, setEntries] = useState<RxCuiLineageEntry[]>([]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setLoading(true);
      setError(null);
      setEntries([]);
      try {
        const rxnavUrl = `https://rxnav.nlm.nih.gov/REST/rxcui/${encodeURIComponent(rxcui)}/ndcs.json`;
        const rxnavRes = await fetch(rxnavUrl);
        if (!rxnavRes.ok) {
          throw new Error(`RxNorm lookup failed (${rxnavRes.status})`);
        }
        const rxnavJson = await rxnavRes.json();
        const ndcList: string[] = rxnavJson?.ndcGroup?.ndcList?.ndc ?? [];

        if (!ndcList.length) {
          if (!cancelled) {
            setError("No NDCs found for this RxCUI.");
          }
          return;
        }

        const lineageEntries: RxCuiLineageEntry[] = [];

        for (const ndc11 of ndcList) {
          const { display10, base10, candidates10 } = convertNdc11ToDisplay(ndc11);
          const entry: RxCuiLineageEntry = {
            ndc11,
            ndc10Display: display10,
            ndc10Base: base10,
            ndcCandidates: candidates10,
            errors: [],
          };

          let openFdaResult: { used: string; data: OpenFdaApiResult } | null = null;
          for (const candidate of candidates10) {
            const openFdaUrl = `https://api.fda.gov/drug/ndc.json?search=product_ndc=${encodeURIComponent(candidate)}`;
            try {
              const res = await fetch(openFdaUrl);
              if (!res.ok) {
                continue;
              }
              const json: { results?: OpenFdaApiResult[] } = await res.json();
              if (Array.isArray(json?.results) && json.results.length > 0) {
                openFdaResult = { used: candidate, data: json.results[0] };
                break;
              }
            } catch {
              // swallow and try next candidate
            }
          }

          if (openFdaResult) {
            const data = openFdaResult.data;
            const brandFromOpenFda = Array.isArray(data.openfda?.brand_name)
              ? data.openfda.brand_name[0]
              : undefined;
            const genericFromOpenFda = Array.isArray(data.openfda?.generic_name)
              ? data.openfda.generic_name[0]
              : undefined;
            const dosageFromOpenFda = Array.isArray(data.openfda?.dosage_form)
              ? data.openfda.dosage_form[0]
              : undefined;
            const routeFromOpenFda = Array.isArray(data.openfda?.route)
              ? data.openfda.route.join(", ")
              : typeof data.openfda?.route === "string"
              ? data.openfda.route
              : undefined;
            const labelerName = typeof data.labeler_name === "string" ? data.labeler_name : undefined;
            const manufacturerArray = Array.isArray(data.manufacturer_name)
              ? data.manufacturer_name
              : undefined;
            const manufacturerSingle =
              typeof data.manufacturer_name === "string" ? data.manufacturer_name : undefined;
            const manufacturerFromOpenFda = Array.isArray(data.openfda?.manufacturer_name)
              ? data.openfda.manufacturer_name
              : undefined;
            const manufacturerName =
              labelerName ??
              (manufacturerArray ? manufacturerArray.join(", ") : undefined) ??
              manufacturerSingle ??
              (manufacturerFromOpenFda ? manufacturerFromOpenFda.join(", ") : undefined);

            const routeValue =
              (Array.isArray(data.route) && data.route.length
                ? data.route.join(", ")
                : typeof data.route === "string"
                ? data.route
                : undefined) ?? routeFromOpenFda;

            const splSetIdValue = (() => {
              const openFdaSpl = data.openfda?.spl_set_id;
              if (Array.isArray(openFdaSpl) && openFdaSpl.length) {
                return openFdaSpl[0];
              }
              if (typeof openFdaSpl === "string") {
                return openFdaSpl;
              }
              if (typeof data.spl_set_id === "string") {
                return data.spl_set_id;
              }
              return null;
            })();

            const openFda = {
              usedQuery: openFdaResult.used,
              productNdc: data.product_ndc ?? data.package_ndc ?? openFdaResult.used,
              brandName: data.brand_name ?? brandFromOpenFda,
              genericName: data.generic_name ?? genericFromOpenFda,
              dosageForm: data.dosage_form ?? dosageFromOpenFda,
              route: routeValue,
              manufacturerName,
              marketingCategory: typeof data.marketing_category === "string" ? data.marketing_category : undefined,
              splSetId: splSetIdValue,
            };
            entry.openFda = openFda;
          } else {
            entry.errors.push("openFDA lookup did not return results.");
          }

          const dailyMedCandidates = new Set<string>();
          dailyMedCandidates.add(display10);

          let dailyMedResult: { used: string; url: string; data: DailyMedRow } | null = null;
          for (const candidate of dailyMedCandidates) {
            if (!candidate) continue;
            const ndcCandidate = candidate;
            try {
              const dailyMedUrl = `https://dailymed.nlm.nih.gov/dailymed/services/v1/ndc/${encodeURIComponent(ndcCandidate)}/spls.json`;
              const res = await fetch(dailyMedUrl);
              if (!res.ok) {
                continue;
              }
              const json: { COLUMNS?: string[]; DATA?: unknown[] } = await res.json();
              const columns: string[] = Array.isArray(json?.COLUMNS) ? json.COLUMNS : [];
              const rowsRaw: unknown[] = Array.isArray(json?.DATA) ? json.DATA : [];
              if (columns.length && rowsRaw.length && Array.isArray(rowsRaw[0])) {
                const rowArray = rowsRaw[0] as Array<string | number | null | undefined>;
                const dataObj: DailyMedRow = {};
                columns.forEach((col, idx) => {
                  dataObj[col] = rowArray[idx];
                });
                dailyMedResult = { used: ndcCandidate, url: dailyMedUrl, data: dataObj };
                break;
              }
            } catch {
              // ignore and continue
            }
          }

          if (dailyMedResult) {
            const data = dailyMedResult.data;
            const setIdCandidate = typeof data.SETID === "string" ? data.SETID : undefined;
            const setIdValue = setIdCandidate ?? entry.openFda?.splSetId ?? null;
            const titleValue = typeof data.TITLE === "string" ? data.TITLE : null;
            const publishedDateValue =
              typeof data.PUBLISHED_DATE === "string" ? data.PUBLISHED_DATE : null;
            const splVersionValue =
              typeof data.SPL_VERSION === "number"
                ? data.SPL_VERSION
                : typeof data.SPL_VERSION === "string"
                ? Number(data.SPL_VERSION) || null
                : null;

            entry.dailyMed = {
              usedNdc: dailyMedResult.used,
              lookupUrl: dailyMedResult.url,
              setId: setIdValue,
              setIdFilterUrl: setIdValue
                ? `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json?setid=${setIdValue}`
                : null,
              title: titleValue,
              publishedDate: publishedDateValue,
              splVersion: splVersionValue,
              ndcsUrl: setIdValue
                ? `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/${setIdValue}/ndcs.json`
                : null,
            };
          } else {
            entry.errors.push("DailyMed lookup did not return results.");
          }

          lineageEntries.push(entry);
        }

        if (!cancelled) {
          setEntries(lineageEntries);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [rxcui]);

  const rxnavConceptUrl = `https://mor.nlm.nih.gov/RxNav/search?searchBy=RXCUI&searchTerm=${encodeURIComponent(
    rxcui
  )}`;
  const rxnavNdcApiUrl = `https://rxnav.nlm.nih.gov/REST/rxcui/${encodeURIComponent(rxcui)}/ndcs.json`;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <header className="flex flex-col gap-1">
        <h2 className="text-lg font-semibold text-slate-900">Full Data Lineage for RxCUI {rxcui}</h2>
        <p className="text-sm text-slate-600">
          Tracing canonical identifiers for <span className="font-medium">{selectionName}</span> across
          RxNorm, FDA openFDA, and DailyMed resources.
        </p>
        <div className="flex flex-wrap gap-3 text-xs text-slate-500">
          <a
            href={rxnavConceptUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded border border-slate-200 bg-slate-100 px-2 py-1 hover:border-slate-300 hover:bg-slate-200"
          >
            RxNav concept page
          </a>
          <a
            href={rxnavNdcApiUrl}
            target="_blank"
            rel="noreferrer"
            className="rounded border border-slate-200 bg-slate-100 px-2 py-1 hover:border-slate-300 hover:bg-slate-200"
          >
            RxNorm NDC API
          </a>
        </div>
      </header>

      {loading ? <p className="text-sm text-slate-500">Loading lineage data…</p> : null}
      {error ? <p className="text-sm text-red-600">{error}</p> : null}

      {!loading && !error && entries.length === 0 ? (
        <p className="text-sm text-slate-500">No downstream NDCs were discovered for this RxCUI.</p>
      ) : null}

      <div className="flex flex-col gap-4">
        {entries.map((entry) => {
          const openFdaLink = entry.openFda
            ? `https://api.fda.gov/drug/ndc.json?search=product_ndc=${encodeURIComponent(entry.openFda.usedQuery)}`
            : null;
          const dailyMedLookupLink = entry.dailyMed?.lookupUrl ?? null;
          const dailyMedSetIdLink = entry.dailyMed?.setId
            ? `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${entry.dailyMed.setId}`
            : null;
          const dailyMedSPLJsonLink = entry.dailyMed?.setId
            ? `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/${entry.dailyMed.setId}.json`
            : null;
          const dailyMedSetFilterLink = entry.dailyMed?.setIdFilterUrl ?? null;
          const dailyMedNdcsLink = entry.dailyMed?.ndcsUrl ?? null;

          return (
            <div key={entry.ndc11} className="rounded border border-slate-200 bg-slate-50 p-4 shadow-sm">
              <div className="flex flex-col gap-1 text-sm text-slate-800">
                <span className="font-semibold text-slate-900">RxNorm NDC 11-digit:</span>
                <span className="font-mono text-base text-slate-900">{entry.ndc11}</span>
                <span className="text-xs text-slate-600">
                  Display NDC (10-digit): <span className="font-mono">{entry.ndc10Display}</span>
                </span>
                <span className="text-xs text-slate-600">
                  Product NDC: <span className="font-mono">{entry.ndc10Base}</span>
                </span>
                <span className="text-[11px] text-slate-500">
                  Candidates tried: {entry.ndcCandidates.join(", ")}
                </span>
              </div>

              {entry.openFda ? (
                <div className="mt-3 rounded border border-slate-200 bg-white p-3 text-sm text-slate-800">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">openFDA product record</h3>
                    {openFdaLink ? (
                      <a
                        href={openFdaLink}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-blue-600 hover:underline"
                      >
                        View API response
                      </a>
                    ) : null}
                  </div>
                  <ul className="mt-2 space-y-1 text-xs text-slate-700">
                    {entry.openFda.productNdc ? (
                      <li>
                        <span className="font-medium text-slate-900">Product NDC:</span> {entry.openFda.productNdc}
                      </li>
                    ) : null}
                    {entry.openFda.brandName ? (
                      <li>
                        <span className="font-medium text-slate-900">Brand:</span> {entry.openFda.brandName}
                      </li>
                    ) : null}
                    {entry.openFda.genericName ? (
                      <li>
                        <span className="font-medium text-slate-900">Generic:</span> {entry.openFda.genericName}
                      </li>
                    ) : null}
                    {entry.openFda.dosageForm ? (
                      <li>
                        <span className="font-medium text-slate-900">Dosage form:</span> {entry.openFda.dosageForm}
                      </li>
                    ) : null}
                    {entry.openFda.route ? (
                      <li>
                        <span className="font-medium text-slate-900">Route:</span> {entry.openFda.route}
                      </li>
                    ) : null}
                    {entry.openFda.manufacturerName ? (
                      <li>
                        <span className="font-medium text-slate-900">Manufacturer:</span> {entry.openFda.manufacturerName}
                      </li>
                    ) : null}
                    {entry.openFda.marketingCategory ? (
                      <li>
                        <span className="font-medium text-slate-900">Marketing category:</span> {entry.openFda.marketingCategory}
                      </li>
                    ) : null}
                    {entry.openFda.splSetId ? (
                      <li>
                        <span className="font-medium text-slate-900">SPL Set ID:</span> {entry.openFda.splSetId}
                      </li>
                    ) : null}
                  </ul>
                </div>
              ) : null}

              {entry.dailyMed ? (
                <div className="mt-3 rounded border border-slate-200 bg-white p-3 text-sm text-slate-800">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-sm font-semibold text-slate-900">DailyMed label</h3>
                    <div className="flex items-center gap-2">
                      {dailyMedLookupLink ? (
                        <a
                          href={dailyMedLookupLink}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-blue-600 hover:underline"
                        >
                          v1 NDC lookup
                        </a>
                      ) : null}
                      {dailyMedSetIdLink ? (
                        <a
                          href={dailyMedSetIdLink}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-blue-600 hover:underline"
                        >
                          Drug info page
                        </a>
                      ) : null}
                      {dailyMedSPLJsonLink ? (
                        <a
                          href={dailyMedSPLJsonLink}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-blue-600 hover:underline"
                        >
                          SPL v2 JSON
                        </a>
                      ) : null}
                      {dailyMedSetFilterLink ? (
                        <a
                          href={dailyMedSetFilterLink}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-blue-600 hover:underline"
                        >
                          SPL v2 set filter
                        </a>
                      ) : null}
                      {dailyMedNdcsLink ? (
                        <a
                          href={dailyMedNdcsLink}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-blue-600 hover:underline"
                        >
                          SPL NDC list
                        </a>
                      ) : null}
                    </div>
                  </div>
                  <ul className="mt-2 space-y-1 text-xs text-slate-700">
                    <li>
                      <span className="font-medium text-slate-900">Lookup NDC:</span> {entry.dailyMed.usedNdc}
                    </li>
                    {entry.dailyMed.ndcsUrl ? (
                      <li>
                        <span className="font-medium text-slate-900">NDCs API:</span>{" "}
                        <a
                          href={entry.dailyMed.ndcsUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-xs text-blue-600 hover:underline"
                        >
                          View API response
                        </a>
                      </li>
                    ) : null}
                    {entry.dailyMed.setId ? (
                      <li>
                        <span className="font-medium text-slate-900">SETID:</span> {entry.dailyMed.setId}
                      </li>
                    ) : null}
                    {entry.dailyMed.title ? (
                      <li>
                        <span className="font-medium text-slate-900">Title:</span> {entry.dailyMed.title}
                      </li>
                    ) : null}
                    {entry.dailyMed.publishedDate ? (
                      <li>
                        <span className="font-medium text-slate-900">Published:</span> {entry.dailyMed.publishedDate}
                      </li>
                    ) : null}
                    {entry.dailyMed.splVersion ? (
                      <li>
                        <span className="font-medium text-slate-900">SPL version:</span> {entry.dailyMed.splVersion}
                      </li>
                    ) : null}
                  </ul>
                </div>
              ) : null}

              {entry.errors.length ? (
                <div className="mt-3 rounded border border-rose-200 bg-rose-50 p-3 text-xs text-rose-700">
                  {entry.errors.join(" ")}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}

