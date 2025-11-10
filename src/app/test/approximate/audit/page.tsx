"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { SqlJsStatic, Database } from "sql.js";
import { callOpenAIRaw } from "../../../../lib/api";
import { medicationTextNormalizationPrompt } from "../../../../lib/prompts";
import {
  findBestStringMatch,
  findBestStringMatchWithLLM,
  type LlmMatchResult,
  type BestMatchResult,
} from "../../../../lib/stringMatching";

const SQL_DUMP_PATH = "/Medication%201.sql";
const SQL_WASM_JS_PATH = "/sql-wasm.js";
const SQL_WASM_PATH = "/sql-wasm.wasm";
const LOCAL_STORAGE_KEY = "approximate-audit-state-v1";

declare global {
  interface Window {
    initSqlJs?: (config?: { locateFile?: (file: string) => string }) => Promise<SqlJsStatic>;
  }
}

let sqlJsInstance: Promise<SqlJsStatic> | null = null;

async function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsInstance) {
    sqlJsInstance = (async () => {
      if (typeof window === "undefined") {
        throw new Error("sql.js must be initialized in the browser");
      }
      await loadScript(SQL_WASM_JS_PATH);
      if (typeof window.initSqlJs !== "function") {
        throw new Error("initSqlJs is not available after loading sql.js script");
      }
      return window.initSqlJs({ locateFile: () => SQL_WASM_PATH });
    })();
  }
  return sqlJsInstance;
}

function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) {
      resolve();
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Failed to load script ${src}`));
    document.body.appendChild(script);
  });
}

function sanitizeSqlDump(rawSql: string): string {
  const normalized = rawSql.replace(/\r\n/g, "\n");
  return normalized
    .replace(/\/\*![\s\S]*?\*\//g, "")
    .replace(/--.*$/gm, "")
    .replace(/^SET\s+[^;]+;$/gim, "")
    .replace(/^START\s+TRANSACTION;$/gim, "")
    .replace(/^COMMIT;$/gim, "")
    .replace(/^LOCK\s+TABLES\s+[^;]+;$/gim, "")
    .replace(/^UNLOCK\s+TABLES;$/gim, "")
    .replace(/\)\s*ENGINE=[^;]+;/g, ");")
    .replace(/DEFAULT\s+CHARSET=[^;]+/gi, "")
    .replace(/COLLATE=[^;]+/gi, "")
    .replace(/`/g, '"')
    .replace(/\s+AUTO_INCREMENT=\d+/gi, "");
}

function execAllStatements(db: Database, sql: string): void {
  const statements = sql
    .split(/;\s*(?=\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);

  for (const statement of statements) {
    try {
      const finalStatement = statement.endsWith(";") ? statement : `${statement};`;
      db.run(finalStatement);
    } catch (err) {
      console.warn("Failed to execute statement", statement, err);
    }
  }
}

type MedicationRecord = {
  id: string;
  rxcui: string;
  str: string;
};

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

type CandidateScore = {
  name: string;
  rxcui: string | null;
  semanticScore: number;
  lexicalScore: number;
  similarityScore: number;
  adjustedScore: number;
};

type CandidateCollection = {
  names: string[];
  metadata: CandidateInfo[];
};

type EvaluationOutcome = {
  index: number;
  record: MedicationRecord;
  normalization: NormalizationResult;
  direct: ApproximateSearchResult;
  normalized: ApproximateSearchResult;
  bestMatch: BestMatchResult | null;
  llmMatch: LlmMatchResult | null;
  candidates: CandidateScore[];
  finalName: string | null;
  finalRxcui: string | null;
  match: boolean;
  error?: string;
  durationMs: number;
};

async function normalizeTermWithLLM(term: string): Promise<NormalizationResult> {
  const trimmed = term.trim();
  if (!trimmed) {
    return { normalized: "", normalizedForSearch: "", raw: null, error: "Input empty" };
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
    const normalized =
      (typeof parsed?.normalized === "string" && parsed.normalized.trim()) || trimmed;
    const note = typeof parsed?.note === "string" ? parsed.note : null;
    return {
      normalized,
      normalizedForSearch: canonicalizeNormalizedTerm(normalized),
      note,
      raw: parsed,
    };
  } catch (err) {
    return {
      normalized: term,
      normalizedForSearch: canonicalizeNormalizedTerm(term),
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

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
    return { term: cleanTerm, candidates: [], raw: null };
  }
  const url = `https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=${encodeURIComponent(
    cleanTerm
  )}&maxEntries=100`;
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
    const candidates: ApproximateCandidate[] = Array.isArray(
      json?.approximateGroup?.candidate
    )
      ? json.approximateGroup.candidate
      : [];
    return { term: cleanTerm, candidates, raw: json };
  } catch (err) {
    return {
      term: cleanTerm,
      candidates: [],
      raw: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function gatherCandidateInfo(
  ...results: Array<ApproximateSearchResult | null>
): CandidateCollection {
  const names = new Set<string>();
  const metadataMap = new Map<string, CandidateInfo>();
  for (const result of results) {
    if (!result?.candidates) continue;
    for (const candidate of result.candidates) {
      const name = candidate.name as string | undefined;
      if (!name || !name.trim()) continue;
      const trimmed = name.trim();
      names.add(trimmed);
      if (!metadataMap.has(trimmed)) {
        const rxcuiValue = candidate.rxcui;
        const rxcuiString =
          typeof rxcuiValue === "string"
            ? rxcuiValue
            : typeof rxcuiValue === "number"
            ? String(rxcuiValue)
            : undefined;
        metadataMap.set(trimmed, {
          name: trimmed,
          rxcui: rxcuiString ?? null,
        });
      }
    }
  }
  return {
    names: Array.from(names),
    metadata: Array.from(metadataMap.values()),
  };
}

type EvaluationConfig = {
  limit: number;
  offset: number;
};

const DEFAULT_CONFIG: EvaluationConfig = {
  limit: 20,
  offset: 0,
};

function formatPercentage(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export default function ApproximateBatchAuditPage() {
  const [medications, setMedications] = useState<MedicationRecord[]>([]);
  const [loadingSql, setLoadingSql] = useState<boolean>(false);
  const [sqlError, setSqlError] = useState<string | null>(null);
  const [config, setConfig] = useState<EvaluationConfig>(DEFAULT_CONFIG);
  const [isEvaluating, setIsEvaluating] = useState<boolean>(false);
  const [progress, setProgress] = useState<number>(0);
  const [evaluationResults, setEvaluationResults] = useState<EvaluationOutcome[]>([]);
  const [lastProcessedIndex, setLastProcessedIndex] = useState<number>(-1);
  const [hasHydrated, setHasHydrated] = useState<boolean>(false);
  const [offsetOverride, setOffsetOverride] = useState<boolean>(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setLoadingSql(true);
      setSqlError(null);
      try {
        const [SQL, response] = await Promise.all([
          getSqlJs(),
          fetch(SQL_DUMP_PATH),
        ]);
        if (!response.ok) {
          throw new Error(`Unable to fetch SQL dump (status ${response.status})`);
        }
        const rawSql = await response.text();
        const sanitized = sanitizeSqlDump(rawSql);
        const database = new SQL.Database();
        execAllStatements(database, sanitized);

        const stmt = database.prepare(
          'SELECT medicationid as id, CAST(rxcui AS TEXT) as rxcui, str as str FROM "Medication"'
        );
        const rows: MedicationRecord[] = [];
        while (stmt.step()) {
          const row = stmt.getAsObject() as Record<string, unknown>;
          const id = typeof row.id === "string" ? row.id : crypto.randomUUID();
          const rxcui = typeof row.rxcui === "string" ? row.rxcui : String(row.rxcui ?? "");
          const str = typeof row.str === "string" ? row.str : "";
          if (str.trim()) {
            rows.push({ id, rxcui, str: str.trim() });
          }
        }
        stmt.free();
        database.close();
        if (!cancelled) {
          setMedications(rows);
        }
      } catch (err) {
        if (!cancelled) {
          setSqlError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled) {
          setLoadingSql(false);
        }
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (hasHydrated || loadingSql) return;
    try {
      const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY);
      if (!raw) {
        setHasHydrated(true);
        return;
      }
      const parsed = JSON.parse(raw) as {
        config?: EvaluationConfig;
        lastProcessedIndex?: number;
        evaluationResults?: EvaluationOutcome[];
      };
      if (parsed.config) {
        setConfig(parsed.config);
      }
      if (Array.isArray(parsed.evaluationResults)) {
        setEvaluationResults(parsed.evaluationResults);
        const lastEntry = parsed.evaluationResults[parsed.evaluationResults.length - 1];
        setLastProcessedIndex(parsed.lastProcessedIndex ?? (lastEntry?.index ?? -1));
      } else if (typeof parsed.lastProcessedIndex === "number") {
        setLastProcessedIndex(parsed.lastProcessedIndex);
      }
    } catch (err) {
      console.warn("Failed to hydrate audit state", err);
    } finally {
      setHasHydrated(true);
    }
  }, [hasHydrated, loadingSql]);

  useEffect(() => {
    if (!hasHydrated || loadingSql || offsetOverride) {
      return;
    }
    if (!medications.length) {
      return;
    }
    const desiredOffset = lastProcessedIndex >= 0 ? Math.min(lastProcessedIndex + 1, medications.length) : 0;
    if (config.offset !== desiredOffset) {
      setConfig((prev) => ({ ...prev, offset: desiredOffset }));
    }
  }, [config.offset, hasHydrated, lastProcessedIndex, loadingSql, medications.length, offsetOverride]);

  useEffect(() => {
    if (!hasHydrated) return;
    try {
      const payload = {
        config,
        lastProcessedIndex,
        evaluationResults,
      };
      window.localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(payload));
    } catch (err) {
      console.warn("Failed to persist audit state", err);
    }
  }, [config, evaluationResults, lastProcessedIndex, hasHydrated]);

  const handleConfigChange = useCallback(
    (field: keyof EvaluationConfig, value: number) => {
      setConfig((prev) => ({ ...prev, [field]: value }));
      setOffsetOverride(true);
    },
    []
  );

  const runEvaluation = useCallback(
    async (records: MedicationRecord[], globalStartIndex: number): Promise<{
      outcomes: EvaluationOutcome[];
      lastIndex: number;
    }> => {
      const outcomes: EvaluationOutcome[] = [];
      let lastIndex = globalStartIndex - 1;
      for (let index = 0; index < records.length; index += 1) {
        const record = records[index];
        const absoluteIndex = globalStartIndex + index;
        const start = performance.now();
        try {
          const normalization = await normalizeTermWithLLM(record.str);
          const direct = await fetchApproximateCandidates(record.str);
          const normalized = normalization.normalizedForSearch
            ? await fetchApproximateCandidates(normalization.normalizedForSearch)
            : { term: normalization.normalizedForSearch, candidates: [], raw: null };

          const candidateCollection = gatherCandidateInfo(direct, normalized);
          const metadataMap = new Map(
            candidateCollection.metadata.map((info) => [info.name.trim().toLowerCase(), info])
          );

          let bestMatch: BestMatchResult | null = null;
          let llmMatch: LlmMatchResult | null = null;
          let finalName: string | null = null;
          let finalRxcui: string | null = null;
          let evaluatedCandidates: CandidateScore[] = [];

          const lookupRxcui = (name: string | null | undefined): string | null => {
            if (!name) return null;
            const key = name.trim().toLowerCase();
            const scored = evaluatedCandidates.find(
              (candidate) => candidate.name.trim().toLowerCase() === key
            );
            if (scored?.rxcui) {
              return scored.rxcui;
            }
            return metadataMap.get(key)?.rxcui ?? null;
          };

          if (candidateCollection.names.length > 0) {
            bestMatch = await findBestStringMatch(record.str, candidateCollection.names);

            evaluatedCandidates = bestMatch.evaluated
              .slice()
              .sort((a, b) => b.adjustedScore - a.adjustedScore)
              .map((candidate) => {
                const key = candidate.candidate.trim().toLowerCase();
                const info = metadataMap.get(key);
                return {
                  name: candidate.candidate,
                  rxcui: info?.rxcui ?? null,
                  semanticScore: candidate.semanticScore,
                  lexicalScore: candidate.lexicalScore,
                  similarityScore: candidate.similarityScore,
                  adjustedScore: candidate.adjustedScore,
                };
              });

            const defaultName = bestMatch.candidate ?? candidateCollection.names[0];
            finalName = defaultName;
            finalRxcui = lookupRxcui(defaultName);

            const rankedEvaluated = evaluatedCandidates.slice(0, 5).map((entry) => ({
              name: entry.name,
              adjustedScore: entry.adjustedScore,
              similarity: entry.similarityScore,
              semanticScore: entry.semanticScore,
              lexicalScore: entry.lexicalScore,
            }));

            if (rankedEvaluated.length > 0) {
              llmMatch = await findBestStringMatchWithLLM(record.str, rankedEvaluated);
              if (llmMatch?.bestMatch && llmMatch.ranked.length > 0) {
                const topRanked = llmMatch.ranked[0];
                if (topRanked.similarity >= 0.9) {
                  finalName = llmMatch.bestMatch;
                  finalRxcui = lookupRxcui(finalName);
                }
              }
            }
          }

          const durationMs = performance.now() - start;
          const outcome: EvaluationOutcome = {
            index: absoluteIndex,
            record,
            normalization,
            direct,
            normalized,
            bestMatch,
            llmMatch,
            candidates: evaluatedCandidates,
            finalName,
            finalRxcui,
            match: finalRxcui === record.rxcui,
            durationMs,
          };
          outcomes.push(outcome);
          lastIndex = absoluteIndex;
          setProgress(index + 1);
          setEvaluationResults((prev) => prev.concat(outcome));
        } catch (err) {
          const durationMs = performance.now() - start;
          const outcome: EvaluationOutcome = {
            index: absoluteIndex,
            record,
            normalization: {
              normalized: record.str,
              normalizedForSearch: canonicalizeNormalizedTerm(record.str),
              raw: null,
              error: undefined,
            },
            direct: { term: record.str, candidates: [], raw: null, error: undefined },
            normalized: { term: record.str, candidates: [], raw: null, error: undefined },
            bestMatch: null,
            llmMatch: null,
            candidates: [],
            finalName: null,
            finalRxcui: null,
            match: false,
            error: err instanceof Error ? err.message : String(err),
            durationMs,
          };
          outcomes.push(outcome);
          lastIndex = absoluteIndex;
          setProgress(index + 1);
          setEvaluationResults((prev) => prev.concat(outcome));
        }
      }
      return { outcomes, lastIndex };
    },
    []
  );

  const handleEvaluate = useCallback(async () => {
    if (!medications.length || isEvaluating) return;
    const { limit, offset } = config;
    const slice = medications.slice(offset, offset + limit);
    setEvaluationResults([]);
    setProgress(0);
    setLastProcessedIndex(offset - 1);
    setIsEvaluating(true);
    try {
      const { outcomes, lastIndex } = await runEvaluation(slice, offset);
      setEvaluationResults(outcomes);
      setLastProcessedIndex(lastIndex);
      const nextOffset = lastIndex >= 0 ? Math.min(lastIndex + 1, medications.length) : offset;
      setConfig((prev) => ({ ...prev, offset: nextOffset }));
      setOffsetOverride(false);
    } finally {
      setIsEvaluating(false);
    }
  }, [config, medications, isEvaluating, runEvaluation]);

  const handleContinue = useCallback(async () => {
    if (!medications.length || isEvaluating) return;
    const startIndex = lastProcessedIndex + 1;
    if (startIndex >= medications.length) return;
    const remaining = medications.length - startIndex;
    const count = Math.min(config.limit, remaining);
    const slice = medications.slice(startIndex, startIndex + count);
    setProgress(0);
    setIsEvaluating(true);
    try {
      const { outcomes, lastIndex } = await runEvaluation(slice, startIndex);
      setEvaluationResults((prev) => prev.concat(outcomes));
      setLastProcessedIndex(lastIndex);
      const nextOffset = lastIndex >= 0 ? Math.min(lastIndex + 1, medications.length) : startIndex;
      setConfig((prev) => ({ ...prev, offset: nextOffset }));
      setOffsetOverride(false);
    } finally {
      setIsEvaluating(false);
    }
  }, [config.limit, isEvaluating, lastProcessedIndex, medications, runEvaluation]);

  const summary = useMemo(() => {
    if (!evaluationResults.length) {
      return {
        total: 0,
        successes: 0,
        failures: 0,
        accuracy: 0,
        averageDuration: 0,
      };
    }
    const successes = evaluationResults.filter((result) => result.match).length;
    const failures = evaluationResults.length - successes;
    const accuracy = evaluationResults.length ? successes / evaluationResults.length : 0;
    const averageDuration =
      evaluationResults.reduce((acc, result) => acc + result.durationMs, 0) /
      evaluationResults.length;
    return { total: evaluationResults.length, successes, failures, accuracy, averageDuration };
  }, [evaluationResults]);

  const successResults = useMemo(
    () => evaluationResults.filter((result) => result.match),
    [evaluationResults]
  );
  const failureResults = useMemo(
    () => evaluationResults.filter((result) => !result.match),
    [evaluationResults]
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold text-slate-900">Approximate Term Batch Audit</h1>
        <p className="text-sm text-slate-600">
          Evaluate the hybrid + LLM re-ranking pipeline against the Medication table in `Medication
          1.sql`. For each entry we normalize the free-text name, query RxNorm, score via embeddings,
          re-rank with GPT-4o-mini, and compare the predicted RxCUI to the reference value stored in
          the SQL dump.
        </p>
      </header>

      <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Dataset status</h2>
        {loadingSql ? (
          <p className="mt-2 text-sm text-slate-500">Loading SQL dump…</p>
        ) : sqlError ? (
          <p className="mt-2 text-sm text-red-600">Failed to load SQL dump: {sqlError}</p>
        ) : (
          <p className="mt-2 text-sm text-slate-600">
            Parsed <span className="font-semibold text-slate-900">{medications.length.toLocaleString()}</span>{" "}
            medication rows from `public/Medication 1.sql`.
          </p>
        )}
      </section>

      <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">Evaluation settings</h2>
        <div className="mt-3 grid gap-4 md:grid-cols-3">
          <label className="flex flex-col gap-1 text-sm text-slate-700">
            Limit
            <input
              type="number"
              min={1}
              max={medications.length || undefined}
              value={config.limit}
              onChange={(event) => handleConfigChange("limit", Number(event.target.value) || 0)}
              className="rounded border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
            />
          </label>
          <label className="flex flex-col gap-1 text-sm text-slate-700">
            Offset
            <input
              type="number"
              min={0}
              max={Math.max(0, medications.length - 1)}
              value={config.offset}
              onChange={(event) => handleConfigChange("offset", Number(event.target.value) || 0)}
              className="rounded border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200"
            />
          </label>
          <div className="flex flex-col gap-1 text-sm text-slate-700">
            Pipeline cost
            <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              Each record triggers multiple RxNorm REST calls and two GPT-4o requests (normalization and
              re-ranking). Start with a small limit to estimate cost and runtime.
            </p>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleEvaluate}
            disabled={loadingSql || !medications.length || isEvaluating || config.limit <= 0}
            className="inline-flex items-center justify-center rounded bg-slate-900 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
          >
            {isEvaluating ? "Evaluating…" : "Start new evaluation"}
          </button>
          <button
            type="button"
            onClick={handleContinue}
            disabled={
              loadingSql ||
              !medications.length ||
              isEvaluating ||
              config.limit <= 0 ||
              lastProcessedIndex + 1 >= medications.length
            }
            className="inline-flex items-center justify-center rounded border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-400 hover:text-slate-900 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400"
          >
            Continue from last result
          </button>
          <span className="text-xs text-slate-600">
            Last processed index: {lastProcessedIndex >= 0 ? lastProcessedIndex + 1 : "—"}
          </span>
          {isEvaluating ? (
            <span className="text-xs text-slate-600">
              Phase progress {progress} / {Math.min(config.limit, medications.length - (lastProcessedIndex + 1))}
            </span>
          ) : null}
        </div>
      </section>

      {evaluationResults.length ? (
        <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Summary</h2>
          <div className="mt-3 grid gap-3 text-sm text-slate-700 md:grid-cols-4">
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-center">
              <div className="text-xs uppercase tracking-wide text-slate-500">Evaluated</div>
              <div className="text-2xl font-semibold text-slate-900">{summary.total}</div>
            </div>
            <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-center">
              <div className="text-xs uppercase tracking-wide text-emerald-600">Correct</div>
              <div className="text-2xl font-semibold text-emerald-900">{summary.successes}</div>
            </div>
            <div className="rounded border border-rose-200 bg-rose-50 p-3 text-center">
              <div className="text-xs uppercase tracking-wide text-rose-600">Incorrect</div>
              <div className="text-2xl font-semibold text-rose-900">{summary.failures}</div>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 p-3 text-center">
              <div className="text-xs uppercase tracking-wide text-slate-500">Accuracy</div>
              <div className="text-2xl font-semibold text-slate-900">
                {formatPercentage(summary.accuracy)}
              </div>
              <div className="mt-1 text-[11px] text-slate-500">
                Avg latency {summary.averageDuration.toFixed(0)} ms
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {evaluationResults.length ? (
        <section className="rounded border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-lg font-semibold text-slate-900">Running results</h2>
          <p className="mt-1 text-xs text-slate-500">
            Each row appears as soon as it finishes processing. Columns show the SQL reference RxCUI, the
            hybrid pick, the LLM pick (if it overrode the hybrid result), and the final decision.
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-xs text-slate-700">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2">#</th>
                  <th className="px-3 py-2">Medication (SQL)</th>
                  <th className="px-3 py-2">Reference RxCUI</th>
                  <th className="px-3 py-2">Hybrid pick</th>
                  <th className="px-3 py-2">Hybrid RxCUI</th>
                  <th className="px-3 py-2">LLM pick</th>
                  <th className="px-3 py-2">LLM RxCUI</th>
                  <th className="px-3 py-2">Final RxCUI</th>
                  <th className="px-3 py-2">Result</th>
                  <th className="px-3 py-2">Latency (ms)</th>
                  <th className="px-3 py-2">Top candidates</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {evaluationResults.map((result) => {
                  const hybridName = result.bestMatch?.candidate ?? "—";
                  const hybridEntry = result.bestMatch?.candidate
                    ? result.candidates.find(
                        (candidate) =>
                          candidate.name.trim().toLowerCase() ===
                          result.bestMatch?.candidate?.trim().toLowerCase()
                      )
                    : undefined;
                  const hybridRxCui = hybridEntry?.rxcui ?? "—";
                  const llmOverride =
                    result.llmMatch?.bestMatch && result.llmMatch?.ranked.length
                      ? result.llmMatch.bestMatch
                      : null;
                  const llmEntry = llmOverride
                    ? result.candidates.find(
                        (candidate) =>
                          candidate.name.trim().toLowerCase() === llmOverride.trim().toLowerCase()
                      )
                    : undefined;
                  const llmRxCui = llmEntry?.rxcui ?? null;
                  const topAlternatives = result.candidates.slice(0, 3);
                  return (
                    <tr key={`${result.record.id}-${result.index}`} className="hover:bg-slate-50">
                      <td className="px-3 py-2 font-mono text-[11px] text-slate-500">
                        {result.index + 1}
                      </td>
                      <td className="max-w-xs px-3 py-2">
                        <div className="truncate font-mono text-[11px] text-slate-700">
                          {result.record.str}
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-slate-600">
                        {result.record.rxcui}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-slate-700">
                        {hybridName}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-slate-600">
                        {hybridRxCui}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-indigo-700">
                        {llmOverride ?? "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-indigo-600">
                        {llmOverride ? llmRxCui ?? "—" : "—"}
                      </td>
                      <td className="px-3 py-2 font-mono text-[11px] text-slate-900">
                        {result.finalRxcui ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {result.match ? (
                          <span className="rounded bg-emerald-500/20 px-2 py-1 text-emerald-700">Pass</span>
                        ) : (
                          <span className="rounded bg-rose-500/20 px-2 py-1 text-rose-700">Fail</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-[11px] text-slate-500">
                        {result.durationMs.toFixed(0)}
                      </td>
                      <td className="px-3 py-2 text-[11px] text-slate-500">
                        {result.candidates.length ? (
                          <details>
                            <summary className="cursor-pointer text-slate-600 hover:text-slate-800">
                              View top {Math.min(3, result.candidates.length)}
                            </summary>
                            <ol className="mt-1 space-y-1 text-[11px] text-slate-700">
                              {topAlternatives.map((candidate, idx) => (
                                <li key={`${candidate.name}-${idx}`} className="rounded border border-slate-200 bg-slate-50 p-2">
                                  <div className="font-mono text-slate-800">
                                    #{idx + 1} {candidate.name}
                                  </div>
                                  <div>RxCUI: {candidate.rxcui ?? "—"}</div>
                                  <div>
                                    Scores → adjusted {candidate.adjustedScore.toFixed(3)}, semantic {candidate.semanticScore.toFixed(3)}, lexical {candidate.lexicalScore.toFixed(3)}, blended {candidate.similarityScore.toFixed(3)}
                                  </div>
                                </li>
                              ))}
                            </ol>
                          </details>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {successResults.length ? (
        <EvaluationList title="Successful matches" entries={successResults} variant="success" />
      ) : null}
      {failureResults.length ? (
        <EvaluationList title="Failed matches" entries={failureResults} variant="failure" />
      ) : null}
    </div>
  );
}

type EvaluationListProps = {
  title: string;
  entries: EvaluationOutcome[];
  variant: "success" | "failure";
};

function EvaluationList({ title, entries, variant }: EvaluationListProps) {
  const borderColor = variant === "success" ? "border-emerald-200" : "border-rose-200";
  const bgColor = variant === "success" ? "bg-emerald-50" : "bg-rose-50";
  const textColor = variant === "success" ? "text-emerald-800" : "text-rose-800";
  const badgeColor = variant === "success" ? "bg-emerald-600" : "bg-rose-600";

  return (
    <section className={`rounded border ${borderColor} bg-white p-4 shadow-sm`}>
      <header className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        <span className={`rounded-full ${badgeColor} px-2 py-1 text-xs font-medium text-white`}>
          {entries.length}
        </span>
      </header>
      <div className="mt-3 flex flex-col gap-3">
        {entries.map((entry) => (
          <details
            key={entry.record.id}
            className={`rounded border ${borderColor} ${bgColor} p-3 ${textColor}`}
          >
            <summary className="cursor-pointer text-sm font-medium text-slate-900">
              {variant === "success" ? "Match" : "Mismatch"}: {entry.record.str}
            </summary>
            <div className="mt-2 space-y-2 text-xs text-slate-700">
              <div>
                <span className="font-medium text-slate-900">Expected RxCUI:</span> {entry.record.rxcui}
              </div>
              <div>
                <span className="font-medium text-slate-900">Predicted name:</span>{" "}
                {entry.finalName ?? "(none)"}
              </div>
              <div>
                <span className="font-medium text-slate-900">Predicted RxCUI:</span>{" "}
                {entry.finalRxcui ?? "(none)"}
              </div>
              {entry.bestMatch ? (
                <div>
                  <span className="font-medium text-slate-900">Hybrid reason:</span>{" "}
                  {entry.bestMatch.reason}
                </div>
              ) : null}
              {entry.llmMatch?.reason ? (
                <div>
                  <span className="font-medium text-slate-900">LLM reason:</span>{" "}
                  {entry.llmMatch.reason}
                </div>
              ) : null}
              {entry.normalization.note ? (
                <div>
                  <span className="font-medium text-slate-900">Normalization note:</span>{" "}
                  {entry.normalization.note}
                </div>
              ) : null}
              {entry.candidates.length ? (
                <details className="rounded border border-slate-200 bg-white/60 p-2">
                  <summary className="cursor-pointer text-xs font-medium text-slate-900">
                    Top {Math.min(5, entry.candidates.length)} candidates
                  </summary>
                  <ol className="mt-1 space-y-1 text-[11px] text-slate-700">
                    {entry.candidates.slice(0, 5).map((candidate, idx) => (
                      <li key={`${candidate.name}-${idx}`} className="rounded border border-slate-200 bg-slate-50 p-2">
                        <div className="font-mono text-slate-800">
                          #{idx + 1} {candidate.name}
                        </div>
                        <div>RxCUI: {candidate.rxcui ?? "—"}</div>
                        <div>
                          Scores → adjusted {candidate.adjustedScore.toFixed(3)}, semantic {candidate.semanticScore.toFixed(3)}, lexical {candidate.lexicalScore.toFixed(3)}, blended {candidate.similarityScore.toFixed(3)}
                        </div>
                      </li>
                    ))}
                  </ol>
                </details>
              ) : null}
              {entry.error ? (
                <div className="text-rose-600">
                  <span className="font-medium text-rose-700">Error:</span> {entry.error}
                </div>
              ) : null}
              <div className="text-[11px] text-slate-500">
                Duration {entry.durationMs.toFixed(0)} ms • Index {entry.index + 1}
              </div>
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
