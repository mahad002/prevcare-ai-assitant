"use client";

import { useCallback, useMemo, useState } from "react";
import { callOpenAIRaw, callGemini, getRxCui, validateRxCui } from "../../../lib/api";
import { medicationPrompt } from "../../../lib/prompts";
import { CheckCircle, XCircle, Loader2, RefreshCcw } from "lucide-react";

type Drug = {
  drug_name: string;
  drug_class?: string;
  strength?: string;
  dosage_form?: string;
  route?: string;
};

type ModelResult = {
  raw?: any;
  rawHttp?: { status: number; ok: boolean; body: string } | null;
  drugs: Array<Drug & { rxcui?: string | null; valid?: boolean | null }>;
  error?: string | null;
  lastCondition?: string;
  lastPrompt?: string;
};

const models = [
  { key: "gpt-4o", label: "GPT-4o", type: "openai" as const },
  { key: "gpt-5", label: "GPT-5", type: "openai" as const },
  { key: "gemini", label: "Gemini 2.5 Pro", type: "gemini" as const },
];

export default function LLMComparisonPage() {
  const [condition, setCondition] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState<"all" | "valid" | "invalid">("all");
  const [results, setResults] = useState<Record<string, ModelResult>>({});
  const [error, setError] = useState<string | null>(null);
  const [cardLoading, setCardLoading] = useState<Record<string, boolean>>({});
  // Per-model condition override (e.g., GPT-5)
  const [perModelCondition, setPerModelCondition] = useState<Record<string, string>>({});

  // 🔹 Helper: Enrich drug list with RxCUI and validation
  async function enrichDrugs(drugs: Drug[]) {
    const enriched: Array<Drug & { rxcui?: string | null; valid?: boolean | null }> = [];
    for (const d of drugs) {
      const rxcui = await getRxCui(d.drug_name);
      const valid = rxcui ? await validateRxCui(rxcui) : null;
      enriched.push({ ...d, rxcui, valid });
    }
    return enriched;
  }

  // 🔹 Run all models
  const runAll = useCallback(async () => {
    if (!condition.trim()) return;
    setLoading(true);
    setError(null);
    setResults({});
    const promptAll = medicationPrompt(condition);

    try {
      const calls = models.map(async (m) => {
        try {
          if (m.type === "openai") {
            const { parsed, http } = await callOpenAIRaw(m.key, promptAll);
            const enriched = await enrichDrugs(parsed?.recommended_drugs ?? []);
            return { key: m.key, value: { raw: parsed, rawHttp: http, drugs: enriched, lastCondition: condition, lastPrompt: promptAll } };
          } else {
            const raw = await callGemini(promptAll);
            const enriched = await enrichDrugs(raw?.recommended_drugs ?? []);
            return { key: m.key, value: { raw, rawHttp: null, drugs: enriched, lastCondition: condition, lastPrompt: promptAll } };
          }
        } catch (e: any) {
          return {
            key: m.key,
            value: { raw: null, rawHttp: null, drugs: [], error: e?.message || String(e), lastCondition: condition, lastPrompt: promptAll },
          };
        }
      });

      const settled = await Promise.all(calls);
      const map: Record<string, ModelResult> = {};
      settled.forEach((r) => (map[r.key] = r.value));
      setResults(map);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [condition]);

  // 🔹 Run individual model
  const runOne = useCallback(
    async (modelKey: string, type: "openai" | "gemini") => {
      const effectiveCondition = (perModelCondition[modelKey] ?? condition).trim();
      if (!effectiveCondition) return;
      setCardLoading((s) => ({ ...s, [modelKey]: true }));
      const p = medicationPrompt(effectiveCondition);
      try {
        if (type === "openai") {
          const { parsed, http } = await callOpenAIRaw(modelKey, p);
          const enriched = await enrichDrugs(parsed?.recommended_drugs ?? []);
          setResults((prev) => ({ ...prev, [modelKey]: { raw: parsed, rawHttp: http, drugs: enriched, lastCondition: effectiveCondition, lastPrompt: p } }));
        } else {
          const raw = await callGemini(p);
          const enriched = await enrichDrugs(raw?.recommended_drugs ?? []);
          setResults((prev) => ({ ...prev, [modelKey]: { raw, rawHttp: null, drugs: enriched, lastCondition: effectiveCondition, lastPrompt: p } }));
        }
      } catch (e: any) {
        setResults((prev) => ({ ...prev, [modelKey]: { raw: null, rawHttp: null, drugs: [], error: e?.message || String(e), lastCondition: effectiveCondition, lastPrompt: p } }));
      } finally {
        setCardLoading((s) => ({ ...s, [modelKey]: false }));
      }
    },
    [condition, perModelCondition]
  );

  // 🔹 Filters
  const filterFn = useCallback(
    (d: { valid?: boolean | null }) => {
      if (filter === "all") return true;
      if (filter === "valid") return d.valid === true;
      return d.valid === false;
    },
    [filter]
  );

  const hasAny = useMemo(() => Object.values(results).some((r) => r?.drugs?.length), [results]);

  // 🔹 Compute comparison summary
  const summary = useMemo(() => {
    const allNames = new Map<string, Set<string>>();
    for (const [model, res] of Object.entries(results)) {
      for (const d of res?.drugs || []) {
        const name = d.drug_name.toLowerCase();
        if (!allNames.has(name)) allNames.set(name, new Set());
        allNames.get(name)!.add(model);
      }
    }
    const overlap = Array.from(allNames.entries()).filter(([, s]) => s.size > 1).length;
    const unique = Array.from(allNames.entries()).filter(([, s]) => s.size === 1).length;
    const total = allNames.size;
    return { overlap, unique, total };
  }, [results]);

  return (
    <main className="mx-auto max-w-7xl p-4 sm:p-6">
      {/* HEADER */}
      <div className="rounded-xl bg-white/80 backdrop-blur border px-4 sm:px-6 py-5 sticky top-0 z-10 shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-blue-700">AI Medication Model Comparator</h1>
            <p className="text-xs sm:text-sm text-gray-600 mt-1">
              Compare GPT-4o, GPT-5, and Gemini outputs with real RxCUI validation.
            </p>
          </div>

          <div className="flex w-full sm:w-auto gap-2">
            <input
              value={condition}
              onChange={(e) => setCondition(e.target.value)}
              placeholder="Enter diagnosis or symptom…"
              className="border rounded-lg w-full p-2 text-sm"
            />
            <button
              onClick={runAll}
              className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 text-sm flex items-center gap-2"
              disabled={loading || !condition.trim()}
            >
              {loading ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Running…
                </>
              ) : (
                <>
                  <RefreshCcw className="h-4 w-4" /> Run all
                </>
              )}
            </button>
          </div>
        </div>

        {/* Filters */}
        <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-gray-600">Filter:</span>
          {(["all", "valid", "invalid"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`rounded-full px-3 py-1 border transition ${
                filter === f
                  ? f === "valid"
                    ? "bg-green-700 text-white border-green-700"
                    : f === "invalid"
                    ? "bg-red-700 text-white border-red-700"
                    : "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
              }`}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {/* Error */}
      {error && <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-4 text-sm text-red-700">{error}</div>}

      {/* SUMMARY */}
      {hasAny && (
        <div className="mt-6 mb-4 bg-gray-50 border rounded-lg p-4 text-sm flex flex-wrap justify-between items-center">
          <div className="font-medium text-gray-700">Comparison Summary:</div>
          <div className="flex flex-wrap gap-3 mt-2 sm:mt-0">
            <span className="px-2 py-1 bg-blue-100 text-blue-800 rounded-md">Total unique drugs: {summary.total}</span>
            <span className="px-2 py-1 bg-green-100 text-green-800 rounded-md">Shared across models: {summary.overlap}</span>
            <span className="px-2 py-1 bg-gray-100 text-gray-800 rounded-md">Unique to one model: {summary.unique}</span>
          </div>
        </div>
      )}

      {/* MODEL CARDS */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-5 mt-4">
        {models.map((m) => {
          const r = results[m.key];
          const list = (r?.drugs || []).filter(filterFn);
          const isLoading = !!cardLoading[m.key];
          const override = perModelCondition[m.key] ?? "";
          return (
            <div
              key={m.key}
              className="bg-white/80 backdrop-blur rounded-xl border shadow-sm p-4 flex flex-col relative"
            >
              <div className="flex items-center justify-between mb-3 sticky top-0 bg-white/80 backdrop-blur py-1 z-10 border-b">
                <div className="flex items-center gap-2">
                  <div className="h-2.5 w-2.5 rounded-full bg-blue-600" />
                  <h2 className="text-base font-semibold">{m.label}</h2>
                </div>
                <button
                  onClick={() => runOne(m.key, m.type)}
                  className="text-xs border px-3 py-1 rounded-md bg-white hover:bg-gray-50 disabled:opacity-60"
                  disabled={isLoading || !(override || condition).trim()}
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="inline-block h-3.5 w-3.5 animate-spin" /> Running…
                    </>
                  ) : (
                    "Run"
                  )}
                </button>
              </div>

              {/* Per-model condition input (only shown for GPT-5) */}
              {m.key === "gpt-5" && (
                <div className="mb-3 flex items-stretch gap-2">
                  <input
                    value={override}
                    onChange={(e) => setPerModelCondition((s) => ({ ...s, [m.key]: e.target.value }))}
                    placeholder="Enter diagnosis/symptom for GPT-5…"
                    className="border rounded-lg w-full p-2 text-sm"
                  />
                  <button
                    onClick={() => runOne(m.key, m.type)}
                    className="text-xs border px-3 py-2 rounded-md bg-white hover:bg-gray-50 disabled:opacity-60"
                    disabled={isLoading || !(override || condition).trim()}
                  >
                    {isLoading ? "Running…" : "Run"}
                  </button>
                </div>
              )}

              {/* For other models, simple Run button */}
              {m.key !== "gpt-5" && (
                <div className="mb-3">
                  <button
                    onClick={() => runOne(m.key, m.type)}
                    className="text-xs border px-3 py-1 rounded-md bg-white hover:bg-gray-50 disabled:opacity-60"
                    disabled={isLoading || !condition.trim()}
                  >
                    {isLoading ? "Running…" : "Run"}
                  </button>
                </div>
              )}

              {r?.lastCondition && (
                <p className="text-[11px] text-gray-500 mb-2">Prompted with: <span className="font-mono">{r.lastCondition}</span></p>
              )}

              {r?.error && <div className="mb-3 text-xs text-red-600">{r.error}</div>}

              {r?.rawHttp && (
                <details className="mb-3">
                  <summary className="text-xs text-gray-700 cursor-pointer">
                    Raw HTTP ({r.rawHttp.status}{r.rawHttp.ok ? " OK" : " Error"})
                  </summary>
                  <pre className="mt-2 p-2 bg-gray-100 rounded text-[11px] overflow-x-auto whitespace-pre-wrap">
                    {r.rawHttp.body}
                  </pre>
                </details>
              )}

              {r?.lastPrompt && (
                <details className="mb-3">
                  <summary className="text-xs text-gray-700 cursor-pointer">Prompt sent</summary>
                  <pre className="mt-2 p-2 bg-gray-50 rounded text-[11px] whitespace-pre-wrap overflow-x-auto">{r.lastPrompt}</pre>
                </details>
              )}

              {list.length === 0 ? (
                <div className="text-sm text-gray-500 italic">No items to display.</div>
              ) : (
                <div className="space-y-3 overflow-y-auto max-h-[28rem] pr-1">
                  {list.map((d, idx) => (
                    <div
                      key={idx}
                      className="p-3 rounded-lg border bg-gray-50 hover:bg-gray-100 transition-colors"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold text-gray-900">{d.drug_name}</p>
                          <p className="text-xs text-gray-600 mt-0.5">
                            {d.drug_class && <span>{d.drug_class} • </span>}
                            {d.strength && <span>{d.strength} • </span>}
                            {d.dosage_form && <span>{d.dosage_form} • </span>}
                            {d.route && <span>{d.route}</span>}
                          </p>
                          <p className="text-[11px] text-gray-500 mt-1">RxCUI: {d.rxcui || "—"}</p>
                        </div>
                        <span
                          className={`text-[11px] h-fit px-2 py-1 rounded flex items-center gap-1 ${
                            d.valid === true
                              ? "bg-green-200 text-green-900"
                              : d.valid === false
                              ? "bg-red-200 text-red-900"
                              : "bg-gray-200 text-gray-800"
                          }`}
                        >
                          {d.valid === true ? (
                            <CheckCircle className="h-3 w-3" />
                          ) : d.valid === false ? (
                            <XCircle className="h-3 w-3" />
                          ) : (
                            <Loader2 className="h-3 w-3 animate-spin" />
                          )}
                          {d.valid === true ? "Valid" : d.valid === false ? "Invalid" : "Unknown"}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </section>
    </main>
  );
}
