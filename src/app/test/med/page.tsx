
"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getRxCui, getRxcuiProps, getRxCuiCandidates } from "../../../lib/api";
import { callOpenAIRaw, callGemini } from "../../../lib/api";
import { medicationInvestigationPrompt, medicationVerificationPrompt } from "../../../lib/prompts";

type TrialResult = {
  rawText: string;
  sources: string[];
  rxcuiCandidate: string | null;
  verification?: {
    ok: boolean;
    name?: string;
    synonyms?: string[];
      llmVerdict?: "match" | "no_match" | "uncertain";
      llmRationale?: string;
  };
};

type ModelKey = "gpt-4o" | "gpt-5" | "gemini";

const models: Array<{ key: ModelKey; label: string; type: "openai" | "gemini" }> = [
  { key: "gpt-4o", label: "GPT-4o", type: "openai" },
  { key: "gpt-5", label: "GPT-5", type: "openai" },
  { key: "gemini", label: "Gemini 2.5 Pro", type: "gemini" },
];

export default function TestMedPage() {
  const [med, setMed] = useState("");
  const [rxcui, setRxcui] = useState<string | null>(null);
  const [rxcuiCandidates, setRxcuiCandidates] = useState<Array<{ rxcui: string; name?: string; tty?: string }>>([]);
  const [candidateProps, setCandidateProps] = useState<Record<string, Record<string, unknown> | null>>({});
  const [candidatePropsErr, setCandidatePropsErr] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trials, setTrials] = useState<Record<ModelKey, TrialResult[]>>({
    "gpt-4o": [],
    "gpt-5": [],
    "gemini": [],
  });
  const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

  const promptFor = useCallback((name: string, previousBadRxcui?: string | null, rxnavHintRxcui?: string | null, rxnavHintList?: string[] | null) => (
    medicationInvestigationPrompt(name, previousBadRxcui, rxnavHintRxcui, rxnavHintList)
  ), []);

  // Stable RxCUI verification helper placed before runOneTrial to satisfy hook deps
  const verifyRxcuiAgainstName = useCallback(async (rxcuiCandidate: string | null, inputName: string) => {
    try {
      if (!rxcuiCandidate) return { ok: false } as const;
      const props = await getRxcuiProps(rxcuiCandidate);
      if (!props) return { ok: false } as const;
      const rxName = String(props?.name || "");
      const synonymRaw = (props?.synonym || "") as string;
      const synonyms = synonymRaw
        ? String(synonymRaw)
            .split("|")
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
      const extractStrength = (s: string) => {
        const m = s.match(/(\d+(?:\.\d+)?)\s*(mg|mcg|g|ml)\b/i);
        return m ? `${m[1]} ${m[2].toUpperCase()}` : null;
      };
      const extractIngredient = (s: string) => norm(s).split(/\d/)[0].trim();
      const formKeywords = ["oral", "tablet", "capsule", "solution", "suspension", "injection", "cream", "ointment", "spray", "patch"];
      const extractForms = (s: string) => {
        const n = norm(s);
        return formKeywords.filter((k) => n.includes(k));
      };

      const inputNorm = norm(inputName);
      const rxNorm = norm(rxName);

      const inputStrength = extractStrength(inputName);
      const rxStrength = extractStrength(rxName);
      if (inputStrength && rxStrength && inputStrength !== rxStrength) {
        return { ok: false, name: rxName, synonyms } as const;
      }

      const exactLike = rxName ? inputNorm.includes(rxNorm) || rxNorm.includes(inputNorm) : false;
      const ingredientMatch = extractIngredient(inputName) && extractIngredient(inputName) === extractIngredient(rxName);
      const formsInput = extractForms(inputName);
      const formsRx = extractForms(rxName);
      const formOverlap = formsInput.some((f) => formsRx.includes(f));

      const synMatch = synonyms.some((s) => {
        const sn = norm(s);
        const sStrength = extractStrength(s);
        if (inputStrength && sStrength && inputStrength !== sStrength) return false;
        const sIngredient = extractIngredient(s);
        const sForms = extractForms(s);
        const sFormOverlap = formsInput.some((f) => sForms.includes(f));
        return inputNorm.includes(sn) || sn.includes(inputNorm) || (sIngredient && sIngredient === extractIngredient(inputName) && sFormOverlap);
      });

      const okRule = exactLike || (ingredientMatch && (formOverlap || !formsInput.length)) || synMatch;

      // LLM-based verification using GPT-4o over full RxNav properties JSON
      let llmVerdict: "match" | "no_match" | "uncertain" | undefined;
      let llmRationale: string | undefined;
      try {
        const vPrompt = medicationVerificationPrompt(inputName, { properties: props });
        const { parsed } = await callOpenAIRaw("gpt-4o", vPrompt);
        const pv = (parsed ?? {}) as Record<string, unknown>;
        const v = (typeof pv.verdict === "string" ? pv.verdict : "") as string;
        if (v === "match" || v === "no_match" || v === "uncertain") {
          llmVerdict = v;
        }
        const rationale = typeof pv.rationale === "string" ? pv.rationale : undefined;
        if (rationale) llmRationale = rationale;
      } catch {}

      const ok = okRule || llmVerdict === "match";
      return { ok, name: rxName, synonyms, llmVerdict, llmRationale } as const;
    } catch {
      return { ok: false } as const;
    }
  }, []);

  const runOneTrial = useCallback(async (model: ModelKey, name: string, previousBadRxcui?: string | null, rxnavHintRxcui?: string | null, rxnavHintList?: string[] | null): Promise<TrialResult> => {
    const p = promptFor(name, previousBadRxcui, rxnavHintRxcui, rxnavHintList);
    try {
      if (model === "gemini") {
        const raw = await callGemini(p) as unknown;
        const rawObj = (raw ?? {}) as Record<string, unknown>;
        const sources: string[] = asStringArray(rawObj.sources);
        const rxcuiCandidate: string | null = asString(rawObj.rxcui);
        const verification = await verifyRxcuiAgainstName(rxcuiCandidate, name);
        return { rawText: JSON.stringify(rawObj), sources, rxcuiCandidate, verification };
      } else {
        const { parsed, http } = await callOpenAIRaw(model, p);
        if (http && !http.ok) {
          return { rawText: http.body, sources: [], rxcuiCandidate: null };
        }
        const obj = (parsed ?? {}) as Record<string, unknown>;
        const sources: string[] = asStringArray(obj.sources);
        const rxcuiCandidate: string | null = asString(obj.rxcui);
        const verification = await verifyRxcuiAgainstName(rxcuiCandidate, name);
        return { rawText: JSON.stringify(parsed ?? {}), sources, rxcuiCandidate, verification };
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { rawText: msg, sources: [], rxcuiCandidate: null };
    }
  }, [promptFor, verifyRxcuiAgainstName]);

  

  const handleRun = useCallback(async () => {
    const name = med.trim();
    if (!name) return;
    setLoading(true);
    setError(null);
    setTrials({ "gpt-4o": [], "gpt-5": [], "gemini": [] });
    try {
      const rx = await getRxCui(name);
      setRxcui(rx);
      const cands = await getRxCuiCandidates(name, 8);
      setRxcuiCandidates(cands);

      // Run three trials per model in sequence for easier rate-limit handling
      const next: Record<ModelKey, TrialResult[]> = { "gpt-4o": [], "gpt-5": [], "gemini": [] };
      for (const m of models) {
        let previousBad: string | null = null;
        for (let i = 0; i < 3; i++) {
          const res = await runOneTrial(
            m.key,
            name,
            previousBad,
            rx,
            (rxcuiCandidates || []).map((c) => c.rxcui)
          );
          next[m.key].push(res);
          setTrials((prev) => ({ ...prev, [m.key]: next[m.key] }));
          // If verification failed and we have a candidate, feed it back to next trial
          if (res.rxcuiCandidate && !(res.verification?.ok)) {
            previousBad = res.rxcuiCandidate;
          } else {
            previousBad = null;
          }
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [med, runOneTrial]);

  const domainCounts = useMemo(() => {
    const counts = new Map<string, number>();
    const add = (d: string) => counts.set(d, (counts.get(d) || 0) + 1);
    (Object.values(trials).flat() || []).forEach((t) => t.sources.forEach(add));
    // sort by count desc
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [trials]);

  const maxCount = useMemo(() => (domainCounts[0]?.[1] ?? 1), [domainCounts]);

  const rxcuiCounts = useMemo(() => {
    const counts = new Map<string, number>();
    (Object.values(trials).flat() || [])
      .map((t) => t.rxcuiCandidate || "")
      .filter(Boolean)
      .forEach((rx) => counts.set(rx, (counts.get(rx) || 0) + 1));
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [trials]);

  // Count only verified matches per RxCUI
  const verifiedRxcuiCounts = useMemo(() => {
    const counts = new Map<string, number>();
    (Object.values(trials).flat() || [])
      .filter((t) => t.rxcuiCandidate && t.verification?.ok)
      .forEach((t) => {
        const key = t.rxcuiCandidate as string;
        counts.set(key, (counts.get(key) || 0) + 1);
      });
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [trials]);

  // Select best RxCUI: prefer most verified matches, else most raw proposals
  const bestRx = useMemo(() => {
    if (verifiedRxcuiCounts.length > 0) return verifiedRxcuiCounts[0][0];
    if (rxcuiCounts.length > 0) return rxcuiCounts[0][0];
    return null as string | null;
  }, [verifiedRxcuiCounts, rxcuiCounts]);

  const [bestProps, setBestProps] = useState<Record<string, unknown> | null>(null);
  const [bestPropsErr, setBestPropsErr] = useState<string | null>(null);

  // Fetch RxNav properties for the best RxCUI
  useMemo(() => {
    (async () => {
      setBestProps(null);
      setBestPropsErr(null);
      if (!bestRx) return;
      try {
        const props = await getRxcuiProps(bestRx);
        setBestProps(props);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        setBestPropsErr(msg);
      }
    })();
  }, [bestRx]);

  // Fetch RxNav properties for all suggestion candidates (bottom section)
  useEffect(() => {
    let cancelled = false;
    async function run() {
      const tasks = rxcuiCandidates
        .filter((c) => !candidateProps[c.rxcui])
        .map(async (c) => {
          try {
            const props = await getRxcuiProps(c.rxcui);
            if (!cancelled) {
              setCandidateProps((prev) => ({ ...prev, [c.rxcui]: props }));
            }
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!cancelled) {
              setCandidatePropsErr((prev) => ({ ...prev, [c.rxcui]: msg }));
            }
          }
        });
      await Promise.all(tasks);
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [rxcuiCandidates, candidateProps]);

  return (
    <main className="mx-auto max-w-7xl p-4 sm:p-6">
      <div className="rounded-xl bg-white/80 backdrop-blur border px-4 sm:px-6 py-5 shadow-sm">
        <h1 className="text-xl sm:text-2xl font-bold text-blue-700">Test Medication Tools</h1>
        <p className="text-xs sm:text-sm text-gray-600 mt-1">
          Enter a medication to resolve its RxCUI and compare model outputs across multiple trials.
        </p>
      </div>

      <section className="mt-4 flex items-stretch gap-2">
        <input
          value={med}
          onChange={(e) => setMed(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleRun()}
          placeholder="e.g., Amoxicillin 500 mg capsule"
          className="border rounded-lg w-full p-2 text-sm"
        />
        <button
          onClick={handleRun}
          disabled={loading || !med.trim()}
          className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 text-sm disabled:opacity-60"
        >
          {loading ? "Running…" : "Run"}
        </button>
      </section>

      <section className="mt-4">
        <div className="text-sm text-gray-700">
          <span className="font-medium">RxCUI:</span> <span className="font-mono">{rxcui ?? "—"}</span>
        </div>
        {rxcuiCandidates.length > 1 && (
          <div className="mt-2 text-xs">
            <div className="text-gray-700 font-medium mb-1">Suggestions</div>
            <ul className="space-y-1">
              {rxcuiCandidates.map((c) => (
                <li key={c.rxcui} className="flex items-center gap-2">
                  <span className="font-mono text-gray-900">{c.rxcui}</span>
                  <span className="text-gray-600">{c.name}</span>
                  {c.tty && <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 border">{c.tty}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && (
          <div className="mt-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>
        )}
      </section>

      <section className="mt-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        {models.map((m) => (
          <div key={m.key} className="bg-white/80 backdrop-blur rounded-xl border shadow-sm p-4">
            <div className="flex items-center justify-between mb-2">
              <h2 className="text-sm font-semibold">{m.label}</h2>
              <span className="text-[11px] text-gray-500">3 trials</span>
            </div>
            <div className="space-y-3">
              {trials[m.key].length === 0 && (
                <div className="text-xs text-gray-500 italic">No trials yet.</div>
              )}
              {trials[m.key].map((t, idx) => (
                <div key={idx} className="border rounded-lg p-2 bg-gray-50">
                  <div className="text-[11px] text-gray-600 mb-1">Trial {idx + 1}</div>
                  <div className="text-xs">
                    <div className="mb-1"><span className="font-medium">LLM RxCUI:</span> <span className="font-mono">{t.rxcuiCandidate ?? "—"}</span></div>
                    {t.rxcuiCandidate && (
                      <div className="mb-2">
                        <span className="font-medium">RxNav verification:</span> {t.verification?.ok ? (
                          <span className="text-green-700">match</span>
                        ) : (
                          <span className="text-red-700">no match</span>
                        )}
                        {t.verification?.name && (
                          <div className="text-[11px] text-gray-600 mt-0.5">
                            name: <span className="font-mono">{t.verification.name}</span>
                          </div>
                        )}
                        {t.verification?.synonyms && t.verification.synonyms.length > 0 && (
                          <div className="text-[11px] text-gray-600 mt-0.5">
                            synonyms: <span className="font-mono">{t.verification.synonyms.slice(0,3).join(" | ")}{t.verification.synonyms.length > 3 ? " | …" : ""}</span>
                          </div>
                        )}
                        {t.verification?.llmVerdict && (
                          <div className="text-[11px] text-gray-700 mt-0.5">
                            LLM verdict: <span className="font-semibold">{t.verification.llmVerdict}</span>{t.verification.llmRationale ? ` – ${t.verification.llmRationale}` : ""}
                          </div>
                        )}
                      </div>
                    )}
                    <div className="font-medium mb-1">Sources</div>
                    {t.sources.length === 0 ? (
                      <div className="text-gray-500 italic">None parsed</div>
                    ) : (
                      <ul className="list-disc pl-5 space-y-0.5">
                        {t.sources.map((s, i) => (
                          <li key={i} className="break-all">{s}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <details className="mt-2">
                    <summary className="text-[11px] text-gray-600 cursor-pointer">Raw</summary>
                    <pre className="mt-1 p-2 bg-white rounded text-[11px] whitespace-pre-wrap break-words">{t.rawText}</pre>
                  </details>
                </div>
              ))}
            </div>
          </div>
        ))}
      </section>

      <section className="mt-8">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Domain frequency across all trials</h3>
        {domainCounts.length === 0 ? (
          <div className="text-xs text-gray-500">No data yet.</div>
        ) : (
          <div className="space-y-2">
            {domainCounts.map(([domain, count]) => (
              <div key={domain} className="flex items-center gap-3">
                <div className="w-40 text-[11px] text-gray-700 truncate" title={domain}>{domain}</div>
                <div className="flex-1 h-3 bg-gray-200 rounded">
                  <div
                    className="h-3 bg-blue-600 rounded"
                    style={{ width: `${Math.max(8, (count / maxCount) * 100)}%` }}
                    title={`${domain}: ${count}`}
                  />
                </div>
                <div className="w-8 text-[11px] text-gray-700 text-right">{count}</div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="mt-8">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Proposed RxCUI values (all trials)</h3>
        {rxcuiCounts.length === 0 ? (
          <div className="text-xs text-gray-500">No RxCUI values proposed by models.</div>
        ) : (
          <div className="space-y-1 text-xs">
            {rxcuiCounts.map(([rx, count]) => (
              <div key={rx} className="flex items-center justify-between border rounded px-2 py-1 bg-white">
                <span className="font-mono">{rx}</span>
                <span className="text-gray-700">{count}</span>
              </div>
            ))}
          </div>
        )}
      </section>

      {rxcuiCandidates.length > 0 && (
        <section className="mt-8">
          <h3 className="text-sm font-semibold text-gray-900 mb-2">Suggestion details (RxNav responses)</h3>
          <div className="space-y-3">
            {rxcuiCandidates.map((c) => (
              <div key={c.rxcui} className="border rounded-lg p-3 bg-white">
                <div className="text-sm">
                  <span className="font-medium">RxCUI:</span> <span className="font-mono">{c.rxcui}</span>
                  {c.name && <span className="ml-2 text-gray-700">{c.name}</span>}
                  {c.tty && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-gray-100 border">{c.tty}</span>}
                </div>
                {candidatePropsErr[c.rxcui] && (
                  <div className="mt-1 text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">{candidatePropsErr[c.rxcui]}</div>
                )}
                {candidateProps[c.rxcui] && (
                  <details className="mt-2">
                    <summary className="text-[11px] text-gray-600 cursor-pointer">Raw JSON</summary>
                    <pre className="mt-1 p-2 bg-gray-50 rounded text-[11px] whitespace-pre-wrap break-words">{JSON.stringify({ properties: candidateProps[c.rxcui] }, null, 2)}</pre>
                  </details>
                )}
                {!candidateProps[c.rxcui] && !candidatePropsErr[c.rxcui] && (
                  <div className="mt-1 text-[11px] text-gray-500">Loading properties…</div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="mt-8">
        <h3 className="text-sm font-semibold text-gray-900 mb-2">Most suitable RxCUI</h3>
        {!bestRx ? (
          <div className="text-xs text-gray-500">No candidates yet.</div>
        ) : (
          <div className="space-y-2 text-sm">
            <div>
              <span className="font-medium">RxCUI:</span> <span className="font-mono">{bestRx}</span>
              {verifiedRxcuiCounts.length > 0 ? (
                <span className="ml-2 text-[11px] text-green-700">most verified matches</span>
              ) : (
                <span className="ml-2 text-[11px] text-gray-600">most proposed</span>
              )}
            </div>
            {bestPropsErr && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2">{bestPropsErr}</div>
            )}
            {bestProps && (
              <div className="border rounded-lg p-3 bg-white">
                <div className="text-[11px] text-gray-600">RxNav properties</div>
                <div className="mt-1 text-xs">
                  <div>name: <span className="font-mono">{String(bestProps?.name || "")}</span></div>
                  {String((bestProps as Record<string, unknown>)?.synonym || "") && (
                    <div className="mt-1">synonym: <span className="font-mono break-all">{String((bestProps as Record<string, unknown>).synonym || "")}</span></div>
                  )}
                  {String((bestProps as Record<string, unknown>)?.tty || "") && (
                    <div className="mt-1">tty: <span className="font-mono">{String((bestProps as Record<string, unknown>).tty || "")}</span></div>
                  )}
                </div>
                <details className="mt-2">
                  <summary className="text-[11px] text-gray-600 cursor-pointer">Raw JSON</summary>
                  <pre className="mt-1 p-2 bg-gray-50 rounded text-[11px] whitespace-pre-wrap break-words">{JSON.stringify({ properties: bestProps }, null, 2)}</pre>
                </details>
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}


