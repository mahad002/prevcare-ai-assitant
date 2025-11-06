"use client";

import { useCallback, useEffect, useState } from "react";
import { getRxCui, getRxcuiProps, getRxCuiCandidates } from "../../../lib/api";
import { callOpenAIRaw, callGemini } from "../../../lib/api";
import { medicationInvestigationPrompt, medicationVerificationPrompt, fixNamingConventionPrompt, compareMedicationNamesPrompt } from "../../../lib/prompts";
import { loadMedicationsList } from "../../../lib/medicationsLoader";

type TrialResult = {
  rawText: string;
  sources: string[];
  rxcuiCandidate: string | null;
  prompt?: string;
  response?: string;
  verification?: {
    ok: boolean;
    name?: string;
    synonyms?: string[];
    llmVerdict?: "match" | "no_match" | "uncertain";
    llmRationale?: string;
    verificationPrompt?: string;
    verificationResponse?: string;
  };
};

type MedicationResult = {
  originalName: string;
  normalizedName: string | null;
  namingResult: {
    original: string;
    normalized: string;
    corrected: boolean;
    rationale?: string;
    assurity?: number;
    prompt?: string;
    response?: string;
  } | null;
  rxcui: string | null; // RxNav RxCUI
  rxcuiCandidates: Array<{ rxcui: string; name?: string; tty?: string }>;
  trial: TrialResult | null; // Single trial result (using GPT-4o)
  bestRxCui: string | null; // Best RxCUI from trial or similarity matching
  bestCandidateMatch: {
    rxcui: string;
    score: number;
    name: string;
    tty?: string;
  } | null; // Best candidate match from similarity matching
  error?: string;
  status: "pending" | "processing" | "completed" | "error";
};

type ModelKey = "gpt-4o" | "gpt-5" | "gemini";

const models: Array<{ key: ModelKey; label: string; type: "openai" | "gemini" }> = [
  { key: "gpt-4o", label: "GPT-4o", type: "openai" },
  { key: "gpt-5", label: "GPT-5", type: "openai" },
  { key: "gemini", label: "Gemini 2.5 Pro", type: "gemini" },
];

export default function MedicationsBatchPage() {
  const [medications, setMedications] = useState<Array<{ name: string }>>([]);
  const [results, setResults] = useState<Record<string, MedicationResult>>({});
  const [loading, setLoading] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [autoRun, setAutoRun] = useState(false);
  const [delay, setDelay] = useState(1000);
  const [selectedModel, setSelectedModel] = useState<ModelKey>("gpt-4o");
  const [selectedResult, setSelectedResult] = useState<{
    medication: string;
    result: MedicationResult;
  } | null>(null);

  const asString = (v: unknown): string | null => (typeof v === "string" ? v : null);
  const asStringArray = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

  // Load medications list on mount
  useEffect(() => {
    const loadList = async () => {
      setLoadingList(true);
      try {
        const meds = await loadMedicationsList();
        setMedications(meds);
        const initialResults: Record<string, MedicationResult> = {};
        meds.forEach((med, index) => {
          const key = `${med.name}::${index}`;
          initialResults[key] = {
            originalName: med.name,
            normalizedName: null,
            namingResult: null,
            rxcui: null,
            rxcuiCandidates: [],
            trial: null,
            bestRxCui: null,
            bestCandidateMatch: null,
            status: "pending",
          };
        });
        setResults(initialResults);
      } catch (error) {
        console.error("Error loading medications:", error);
      } finally {
        setLoadingList(false);
      }
    };
    loadList();
  }, []);

  // Fix naming convention helper
  const fixNamingConvention = useCallback(async (medicationName: string) => {
    try {
      const prompt = fixNamingConventionPrompt(medicationName);
      const { parsed, http } = await callOpenAIRaw("gpt-4o", prompt);
      const result = (parsed ?? {}) as Record<string, unknown>;
      let responseText: string;
      try {
        if (http?.body) {
          const fullResponse = JSON.parse(http.body);
          const content = fullResponse?.choices?.[0]?.message?.content;
          if (content) {
            try {
              responseText = JSON.stringify(JSON.parse(content), null, 2);
            } catch {
              responseText = content;
            }
          } else {
            responseText = JSON.stringify(fullResponse, null, 2);
          }
        } else {
          responseText = JSON.stringify(parsed ?? {}, null, 2);
        }
      } catch {
        responseText = http?.body || JSON.stringify(parsed ?? {}, null, 2);
      }
      
      const original = typeof result.original === "string" ? result.original : medicationName;
      const normalized = typeof result.normalized === "string" ? result.normalized : medicationName;
      const corrected = typeof result.corrected === "boolean" ? result.corrected : false;
      const rationale = typeof result.rationale === "string" ? result.rationale : undefined;
      const assurity = typeof result.assurity === "number" && result.assurity >= 0 && result.assurity <= 100 
        ? result.assurity 
        : undefined;
      
      return { original, normalized, corrected, rationale, assurity, prompt, response: responseText };
    } catch (e) {
      console.error("Error fixing naming convention:", e);
      return {
        original: medicationName,
        normalized: medicationName,
        corrected: false,
      };
    }
  }, []);

  // Verify RxCUI against name
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

      // LLM-based verification
      let llmVerdict: "match" | "no_match" | "uncertain" | undefined;
      let llmRationale: string | undefined;
      let verificationPrompt: string | undefined;
      let verificationResponse: string | undefined;
      try {
        const vPrompt = medicationVerificationPrompt(inputName, { properties: props });
        verificationPrompt = vPrompt;
        const { parsed, http } = await callOpenAIRaw("gpt-4o", vPrompt);
        try {
          if (http?.body) {
            const fullResponse = JSON.parse(http.body);
            const content = fullResponse?.choices?.[0]?.message?.content;
            if (content) {
              try {
                verificationResponse = JSON.stringify(JSON.parse(content), null, 2);
              } catch {
                verificationResponse = content;
              }
            } else {
              verificationResponse = JSON.stringify(fullResponse, null, 2);
            }
          } else {
            verificationResponse = JSON.stringify(parsed ?? {}, null, 2);
          }
        } catch {
          verificationResponse = http?.body || JSON.stringify(parsed ?? {}, null, 2);
        }
        const pv = (parsed ?? {}) as Record<string, unknown>;
        const v = (typeof pv.verdict === "string" ? pv.verdict : "") as string;
        if (v === "match" || v === "no_match" || v === "uncertain") {
          llmVerdict = v;
        }
        const rationale = typeof pv.rationale === "string" ? pv.rationale : undefined;
        if (rationale) llmRationale = rationale;
      } catch {}

      const ok = okRule || llmVerdict === "match";
      return { ok, name: rxName, synonyms, llmVerdict, llmRationale, verificationPrompt, verificationResponse } as const;
    } catch {
      return { ok: false } as const;
    }
  }, []);

  // Run one trial
  const runOneTrial = useCallback(async (model: ModelKey, name: string, rxnavHintRxcui?: string | null, rxnavHintList?: string[] | null): Promise<TrialResult> => {
    const p = medicationInvestigationPrompt(name, null, rxnavHintRxcui, rxnavHintList);
    try {
      if (model === "gemini") {
        const raw = await callGemini(p) as unknown;
        const rawObj = (raw ?? {}) as Record<string, unknown>;
        const responseText = JSON.stringify(rawObj, null, 2);
        const sources: string[] = asStringArray(rawObj.sources);
        const rxcuiCandidate: string | null = asString(rawObj.rxcui);
        const verification = await verifyRxcuiAgainstName(rxcuiCandidate, name);
        return { 
          rawText: JSON.stringify(rawObj), 
          sources, 
          rxcuiCandidate, 
          verification, 
          prompt: p, 
          response: responseText 
        };
      } else {
        const { parsed, http } = await callOpenAIRaw(model, p);
        let responseText: string;
        try {
          if (http?.body) {
            const fullResponse = JSON.parse(http.body);
            const content = fullResponse?.choices?.[0]?.message?.content;
            if (content) {
              try {
                responseText = JSON.stringify(JSON.parse(content), null, 2);
              } catch {
                responseText = content;
              }
            } else {
              responseText = JSON.stringify(fullResponse, null, 2);
            }
          } else {
            responseText = JSON.stringify(parsed ?? {}, null, 2);
          }
        } catch {
          responseText = http?.body || JSON.stringify(parsed ?? {}, null, 2);
        }
        if (http && !http.ok) {
          return { rawText: http.body, sources: [], rxcuiCandidate: null, prompt: p, response: responseText };
        }
        const obj = (parsed ?? {}) as Record<string, unknown>;
        const sources: string[] = asStringArray(obj.sources);
        const rxcuiCandidate: string | null = asString(obj.rxcui);
        const verification = await verifyRxcuiAgainstName(rxcuiCandidate, name);
        return { rawText: JSON.stringify(parsed ?? {}), sources, rxcuiCandidate, verification, prompt: p, response: responseText };
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return { rawText: msg, sources: [], rxcuiCandidate: null, prompt: p, response: msg };
    }
  }, [verifyRxcuiAgainstName]);

  // Find best candidate by LLM similarity matching
  const findBestCandidateBySimilarity = useCallback(async (
    inputName: string,
    candidates: Array<{ rxcui: string; name?: string; tty?: string }>
  ): Promise<{ rxcui: string; score: number; name: string; tty?: string } | null> => {
    if (candidates.length === 0) return null;

    const candidateScores: Array<{ rxcui: string; score: number; name: string; tty?: string }> = [];

    // Fetch properties for all candidates to get names and synonyms
    for (const candidate of candidates) {
      try {
        const props = await getRxcuiProps(candidate.rxcui);
        if (!props) continue;

        const candidateName = String(props?.name || candidate.name || "");
        const candidateTty = String(props?.tty || candidate.tty || "");
        const synonymRaw = (props?.synonym || "") as string;
        const synonyms = synonymRaw
          ? String(synonymRaw)
              .split("|")
              .map((s) => s.trim())
              .filter(Boolean)
          : [];

        // Skip ingredient-level candidates (IN, MIN) - they're too generic
        // We want specific drug forms, not just ingredients
        if (candidateTty === "IN" || candidateTty === "MIN") {
          continue;
        }

        // Compare with candidate name
        let maxScore = 0;
        let bestMatchName = candidateName;

        try {
          const comparePrompt = compareMedicationNamesPrompt(inputName, candidateName);
          const { parsed } = await callOpenAIRaw("gpt-4o", comparePrompt);
          const result = (parsed ?? {}) as Record<string, unknown>;
          const matchScore = typeof result.matchScore === "number" ? result.matchScore : 0;
          if (matchScore > maxScore) {
            maxScore = matchScore;
            bestMatchName = candidateName;
          }
        } catch {
          // Skip failed comparisons
        }

        // Compare with each synonym
        for (const synonym of synonyms) {
          try {
            const comparePrompt = compareMedicationNamesPrompt(inputName, synonym);
            const { parsed } = await callOpenAIRaw("gpt-4o", comparePrompt);
            const result = (parsed ?? {}) as Record<string, unknown>;
            const matchScore = typeof result.matchScore === "number" ? result.matchScore : 0;
            if (matchScore > maxScore) {
              maxScore = matchScore;
              bestMatchName = synonym;
            }
          } catch {
            // Skip failed comparisons
            continue;
          }
        }

        if (maxScore > 0) {
          candidateScores.push({
            rxcui: candidate.rxcui,
            score: maxScore,
            name: bestMatchName,
            tty: candidateTty || undefined,
          });
        }
      } catch (e) {
        console.error(`Error processing candidate ${candidate.rxcui}:`, e);
        continue;
      }
    }

    // Return candidate with highest score
    if (candidateScores.length === 0) return null;
    
    // Sort by score (highest first), and if scores are equal, prefer more specific TTYs
    candidateScores.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }
      // If scores are equal, prefer more specific TTYs (SCD > SBD > others > IN)
      const ttyPriority: Record<string, number> = {
        'SCD': 4,
        'SBD': 3,
        'SCDF': 2,
        'SBDF': 2,
        'GPCK': 1,
        'BPCK': 1,
      };
      const aPriority = ttyPriority[a.tty || ''] || 0;
      const bPriority = ttyPriority[b.tty || ''] || 0;
      return bPriority - aPriority;
    });
    
    return candidateScores[0];
  }, []);

  // Test a single medication
  const testMedication = useCallback(async (medication: { name: string }, resultKey?: string) => {
    const medName = medication.name.trim();
    if (!medName) return;

    const key = resultKey || `${medName}::${medications.findIndex(m => m.name === medName)}`;
    
    setResults((prev) => ({
      ...prev,
      [key]: {
        ...prev[key] || {
          originalName: medName,
          normalizedName: null,
          namingResult: null,
          rxcui: null,
          rxcuiCandidates: [],
          trial: null,
          bestRxCui: null,
          bestCandidateMatch: null,
          status: "pending",
        },
        status: "processing",
        error: undefined,
      },
    }));

    try {
      // Step 1: Fix naming convention
      const namingResult = await fixNamingConvention(medName);
      
      // Use normalized name if correction was made
      const searchName = (namingResult?.corrected && namingResult.normalized && namingResult.normalized.trim() !== medName.trim()) 
        ? namingResult.normalized.trim() 
        : medName;

      // Step 2: Get RxCUI from RxNav
      const rx = await getRxCui(searchName);
      const cands = await getRxCuiCandidates(searchName, 8);

      // Step 3: Run trial with selected model
      const trial = await runOneTrial(
        selectedModel,
        searchName,
        rx,
        cands.map((c) => c.rxcui)
      );

      // Step 4: Build comprehensive candidates list for similarity matching
      // Include all candidates plus the direct lookup result
      const allCandidates: Array<{ rxcui: string; name?: string; tty?: string }> = [...cands];
      
      // Add direct lookup result if not already in candidates
      if (rx && !cands.find(c => c.rxcui === rx)) {
        allCandidates.push({ rxcui: rx });
      }

      // Step 5: Always run similarity matching to find the best candidate
      // This will filter out ingredient-level candidates and find the best match
      let bestRxCui: string | null = null;
      let bestCandidateMatch: { rxcui: string; score: number; name: string; tty?: string } | null = null;
      
      if (allCandidates.length > 0) {
        // Always run similarity matching on all candidates
        const bestCandidate = await findBestCandidateBySimilarity(searchName, allCandidates);
        if (bestCandidate) {
          // Use similarity match result (this filters out IN/MIN candidates)
          bestRxCui = bestCandidate.rxcui;
          bestCandidateMatch = bestCandidate;
        } else {
          // If similarity matching found nothing, check if we have non-ingredient candidates
          // Check each candidate to find the first non-ingredient one
          let foundNonIngredient = false;
          for (const candidate of cands) {
            try {
              const props = await getRxcuiProps(candidate.rxcui);
              if (props) {
                const tty = String(props?.tty || candidate.tty || "");
                if (tty !== "IN" && tty !== "MIN") {
                  bestRxCui = candidate.rxcui;
                  foundNonIngredient = true;
                  break;
                }
              }
            } catch {
              continue;
            }
          }
          
          // If no non-ingredient candidate found in cands, check direct lookup result
          if (!foundNonIngredient && rx) {
            try {
              const rxProps = await getRxcuiProps(rx);
              if (rxProps) {
                const rxTty = String(rxProps?.tty || "");
                if (rxTty !== "IN" && rxTty !== "MIN") {
                  bestRxCui = rx;
                }
              }
            } catch {
              // If we can't check, don't use ingredient-level as fallback
              // Leave bestRxCui as null
            }
          }
        }
      } else {
        // No candidates - check RxNav result if it's not an ingredient
        if (rx) {
          try {
            const rxProps = await getRxcuiProps(rx);
            if (rxProps) {
              const rxTty = String(rxProps?.tty || "");
              if (rxTty !== "IN" && rxTty !== "MIN") {
                bestRxCui = rx;
              }
            }
          } catch {
            bestRxCui = rx;
          }
        }
      }

      setResults((prev) => ({
        ...prev,
        [key]: {
          originalName: medName,
          normalizedName: searchName !== medName ? searchName : null,
          namingResult,
          rxcui: rx,
          rxcuiCandidates: cands,
          trial,
          bestRxCui,
          bestCandidateMatch,
          status: "completed",
        },
      }));
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setResults((prev) => ({
        ...prev,
        [key]: {
          ...prev[key] || {
            originalName: medName,
            normalizedName: null,
            namingResult: null,
            rxcui: null,
            rxcuiCandidates: [],
            trial: null,
            bestRxCui: null,
            bestCandidateMatch: null,
            status: "pending",
          },
          status: "error",
          error: msg,
        },
      }));
    }
  }, [fixNamingConvention, medications, selectedModel, runOneTrial, findBestCandidateBySimilarity]);

  // Helper to get result key
  const getResultKey = useCallback((med: { name: string }, index: number) => {
    const possibleKey = `${med.name}::${index}`;
    if (results[possibleKey]) return possibleKey;
    const existingKey = Object.keys(results).find(key => 
      key.startsWith(`${med.name}::`) || key === med.name
    );
    return existingKey || possibleKey;
  }, [results]);

  // Auto-run effect
  useEffect(() => {
    if (!autoRun || loading || medications.length === 0) return;
    if (currentIndex >= medications.length) {
      setAutoRun(false);
      setLoading(false);
      return;
    }

    const timer = setTimeout(async () => {
      const med = medications[currentIndex];
      const key = getResultKey(med, currentIndex);
      await testMedication(med, key);
      setCurrentIndex((prev) => prev + 1);
    }, delay);

    return () => clearTimeout(timer);
  }, [autoRun, currentIndex, medications, delay, testMedication, loading, getResultKey]);

  // Handle start batch test
  const handleStartBatch = useCallback(async () => {
    setLoading(true);
    setCurrentIndex(0);
    setAutoRun(true);
  }, []);

  // Handle stop batch test
  const handleStopBatch = useCallback(() => {
    setAutoRun(false);
    setLoading(false);
  }, []);

  // Handle test single medication
  const handleTestSingle = useCallback(async (medication: { name: string }, resultKey?: string) => {
    await testMedication(medication, resultKey);
  }, [testMedication]);

  // Handle test all (no delay)
  const handleTestAll = useCallback(async () => {
    setLoading(true);
    setCurrentIndex(0);
    for (let i = 0; i < medications.length; i++) {
      const med = medications[i];
      const key = getResultKey(med, i);
      await testMedication(med, key);
      setCurrentIndex(i + 1);
    }
    setLoading(false);
  }, [medications, testMedication, getResultKey]);

  // Statistics
  const stats = {
    total: medications.length,
    completed: medications.filter((med, index) => {
      const key = getResultKey(med, index);
      return results[key]?.status === "completed";
    }).length,
    error: medications.filter((med, index) => {
      const key = getResultKey(med, index);
      return results[key]?.status === "error";
    }).length,
    pending: medications.filter((med, index) => {
      const key = getResultKey(med, index);
      const result = results[key];
      return !result || result.status === "pending";
    }).length,
    processing: medications.filter((med, index) => {
      const key = getResultKey(med, index);
      return results[key]?.status === "processing";
    }).length,
  };

  const completedResults = Object.values(results).filter((r) => r.status === "completed");

  return (
    <main className="mx-auto max-w-7xl p-4 sm:p-6">
      <div className="rounded-xl bg-white/80 backdrop-blur border px-4 sm:px-6 py-5 shadow-sm mb-4">
        <h1 className="text-xl sm:text-2xl font-bold text-blue-700">Medications Batch Processing</h1>
        <p className="text-xs sm:text-sm text-gray-600 mt-1">
          Process all medications from medications list.rtf using test med logic - normalize input, fetch RxCUI and suggestions.
        </p>
      </div>

      {/* Statistics */}
      <div className="mb-4 grid grid-cols-2 sm:grid-cols-5 gap-2">
        <div className="bg-white/80 rounded-lg p-3 border">
          <div className="text-xs text-gray-600">Total</div>
          <div className="text-lg font-bold text-gray-900">{stats.total}</div>
        </div>
        <div className="bg-white/80 rounded-lg p-3 border">
          <div className="text-xs text-gray-600">Completed</div>
          <div className="text-lg font-bold text-green-700">{stats.completed}</div>
        </div>
        <div className="bg-white/80 rounded-lg p-3 border">
          <div className="text-xs text-gray-600">Processing</div>
          <div className="text-lg font-bold text-blue-700">{stats.processing}</div>
        </div>
        <div className="bg-white/80 rounded-lg p-3 border">
          <div className="text-xs text-gray-600">Error</div>
          <div className="text-lg font-bold text-red-700">{stats.error}</div>
        </div>
        <div className="bg-white/80 rounded-lg p-3 border">
          <div className="text-xs text-gray-600">Pending</div>
          <div className="text-lg font-bold text-gray-700">{stats.pending}</div>
        </div>
      </div>

      {/* Controls */}
      <div className="mb-4 flex flex-wrap gap-2 items-center">
        <button
          onClick={handleStartBatch}
          disabled={loading || loadingList || medications.length === 0}
          className="bg-blue-600 hover:bg-blue-700 text-white rounded-lg px-4 py-2 text-sm disabled:opacity-60"
        >
          Start Batch (Auto)
        </button>
        <button
          onClick={handleStopBatch}
          disabled={!autoRun}
          className="bg-red-600 hover:bg-red-700 text-white rounded-lg px-4 py-2 text-sm disabled:opacity-60"
        >
          Stop
        </button>
        <button
          onClick={handleTestAll}
          disabled={loading || loadingList || medications.length === 0}
          className="bg-green-600 hover:bg-green-700 text-white rounded-lg px-4 py-2 text-sm disabled:opacity-60"
        >
          Test All (No Delay)
        </button>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-600">Model:</label>
          <select
            value={selectedModel}
            onChange={(e) => setSelectedModel(e.target.value as ModelKey)}
            disabled={autoRun || loading}
            className="border rounded px-2 py-1 text-sm"
          >
            {models.map((m) => (
              <option key={m.key} value={m.key}>{m.label}</option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-600">Delay (ms):</label>
          <input
            type="number"
            value={delay}
            onChange={(e) => setDelay(parseInt(e.target.value) || 1000)}
            min="100"
            max="10000"
            step="100"
            className="border rounded px-2 py-1 text-sm w-20"
            disabled={autoRun}
          />
        </div>
        {autoRun && (
          <div className="text-xs text-gray-600">
            Progress: {currentIndex} / {medications.length}
          </div>
        )}
      </div>

      {loadingList && (
        <div className="text-sm text-gray-600">Loading medications list...</div>
      )}

      {/* Results Table */}
      <div className="bg-white/80 rounded-xl border shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-100">
              <tr>
                <th className="px-3 py-2 text-left font-medium text-gray-700">Status</th>
                <th className="px-3 py-2 text-left font-medium text-gray-700">Original Name</th>
                <th className="px-3 py-2 text-left font-medium text-gray-700">Normalized</th>
                <th className="px-3 py-2 text-left font-medium text-gray-700">Assurity</th>
                <th className="px-3 py-2 text-left font-medium text-gray-700">RxNav RxCUI</th>
                <th className="px-3 py-2 text-left font-medium text-gray-700">Best RxCUI</th>
                <th className="px-3 py-2 text-left font-medium text-gray-700">Verification</th>
                <th className="px-3 py-2 text-left font-medium text-gray-700">Candidates</th>
                <th className="px-3 py-2 text-left font-medium text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {medications.map((med, idx) => {
                const resultKey = getResultKey(med, idx);
                const result = results[resultKey] || {
                  originalName: med.name,
                  normalizedName: null,
                  namingResult: null,
                  rxcui: null,
                  rxcuiCandidates: [],
                  trial: null,
                  bestRxCui: null,
                  bestCandidateMatch: null,
                  status: "pending" as const,
                };

                return (
                  <tr key={idx} className={result.status === "processing" ? "bg-blue-50" : result.status === "error" ? "bg-red-50" : ""}>
                    <td className="px-3 py-2">
                      <span className={`px-2 py-1 rounded text-[10px] font-medium ${
                        result.status === "completed" ? "bg-green-100 text-green-800" :
                        result.status === "processing" ? "bg-blue-100 text-blue-800" :
                        result.status === "error" ? "bg-red-100 text-red-800" :
                        "bg-gray-100 text-gray-800"
                      }`}>
                        {result.status}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-900">{med.name}</td>
                    <td className="px-3 py-2">
                      {result.normalizedName ? (
                        <span className="font-mono text-green-700">{result.normalizedName}</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {result.namingResult?.assurity !== undefined ? (
                        <span className="font-semibold text-blue-700">{result.namingResult.assurity}%</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {result.rxcui ? (
                        <span className="font-mono text-gray-700">{result.rxcui}</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {result.bestRxCui ? (
                        <div className="space-y-1">
                          <div className="font-mono text-blue-700">{result.bestRxCui}</div>
                          {result.bestCandidateMatch && result.bestCandidateMatch.rxcui === result.bestRxCui && (
                            <div className="text-[9px] text-orange-600">
                              Similarity: {result.bestCandidateMatch.score.toFixed(0)}%
                              {result.bestCandidateMatch.tty && ` (${result.bestCandidateMatch.tty})`}
                            </div>
                          )}
                          {!result.bestCandidateMatch && result.trial?.rxcuiCandidate === result.bestRxCui && result.trial?.verification?.ok && (
                            <div className="text-[9px] text-green-600">✓ Verified</div>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {result.trial?.verification ? (
                        <div className="space-y-1">
                          {result.trial.verification.ok ? (
                            <span className="text-green-700 text-[10px] font-semibold">✓ Match</span>
                          ) : (
                            <span className="text-red-700 text-[10px] font-semibold">✗ No Match</span>
                          )}
                          {result.trial.verification.llmVerdict && (
                            <div className="text-[9px] text-gray-600">
                              LLM: {result.trial.verification.llmVerdict}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {result.rxcuiCandidates.length > 0 ? (
                        <button
                          onClick={() => setSelectedResult({ medication: med.name, result })}
                          className="text-gray-700 hover:text-blue-700 text-[10px] underline"
                        >
                          {result.rxcuiCandidates.length} candidates
                        </button>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1 items-center">
                        <button
                          onClick={() => {
                            const key = getResultKey(med, idx);
                            handleTestSingle(med, key);
                          }}
                          disabled={result.status === "processing"}
                          className="text-blue-600 hover:text-blue-800 text-[10px] disabled:opacity-50"
                        >
                          Test
                        </button>
                        {result.trial && (
                          <button
                            onClick={() => setSelectedResult({ medication: med.name, result })}
                            className="text-[10px] text-gray-600 hover:text-gray-800 underline"
                          >
                            Details
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Detail Modal */}
      {selectedResult && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
          onClick={() => setSelectedResult(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl p-4 max-w-4xl max-h-[90vh] overflow-auto m-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-xs space-y-4">
              <div className="flex justify-between items-center mb-2">
                <h3 className="font-semibold text-gray-900">{selectedResult.medication}</h3>
                <button
                  onClick={() => setSelectedResult(null)}
                  className="text-gray-500 hover:text-gray-700 text-lg"
                >
                  ✕
                </button>
              </div>

              {/* Naming Result */}
              {selectedResult.result.namingResult && (
                <div>
                  <div className="font-medium mb-1 text-gray-700">Naming Convention:</div>
                  <div className="bg-gray-50 p-3 rounded border space-y-1">
                    <div><span className="font-medium">Original:</span> {selectedResult.result.namingResult.original}</div>
                    {selectedResult.result.namingResult.corrected && (
                      <div><span className="font-medium">Normalized:</span> {selectedResult.result.namingResult.normalized}</div>
                    )}
                    {selectedResult.result.namingResult.assurity !== undefined && (
                      <div><span className="font-medium">Assurity:</span> {selectedResult.result.namingResult.assurity}%</div>
                    )}
                    {selectedResult.result.namingResult.rationale && (
                      <div><span className="font-medium">Rationale:</span> {selectedResult.result.namingResult.rationale}</div>
                    )}
                  </div>
                </div>
              )}

              {/* Trial Result */}
              {selectedResult.result.trial && (
                <div>
                  <div className="font-medium mb-1 text-gray-700">LLM Trial Result ({selectedModel}):</div>
                  <div className="bg-gray-50 p-3 rounded border space-y-2">
                    <div><span className="font-medium">RxCUI Candidate:</span> <span className="font-mono">{selectedResult.result.trial.rxcuiCandidate || "—"}</span></div>
                    {selectedResult.result.trial.verification && (
                      <div>
                        <div><span className="font-medium">Verification:</span> {selectedResult.result.trial.verification.ok ? "✓ Match" : "✗ No Match"}</div>
                        {selectedResult.result.trial.verification.name && (
                          <div><span className="font-medium">RxNav Name:</span> {selectedResult.result.trial.verification.name}</div>
                        )}
                        {selectedResult.result.trial.verification.llmVerdict && (
                          <div><span className="font-medium">LLM Verdict:</span> {selectedResult.result.trial.verification.llmVerdict}</div>
                        )}
                        {selectedResult.result.trial.verification.llmRationale && (
                          <div><span className="font-medium">LLM Rationale:</span> {selectedResult.result.trial.verification.llmRationale}</div>
                        )}
                      </div>
                    )}
                    {selectedResult.result.trial.sources.length > 0 && (
                      <div>
                        <div className="font-medium mb-1">Sources:</div>
                        <ul className="list-disc pl-5 space-y-0.5">
                          {selectedResult.result.trial.sources.map((s, i) => (
                            <li key={i} className="break-all">{s}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {(selectedResult.result.trial.prompt || selectedResult.result.trial.response) && (
                      <details className="mt-2">
                        <summary className="text-[11px] text-gray-600 cursor-pointer font-medium">Prompt & Response</summary>
                        <div className="mt-2 space-y-2">
                          {selectedResult.result.trial.prompt && (
                            <div>
                              <div className="text-[11px] font-medium text-gray-700 mb-1">Prompt:</div>
                              <pre className="p-2 bg-white rounded text-[11px] whitespace-pre-wrap break-words border max-h-64 overflow-auto">{selectedResult.result.trial.prompt}</pre>
                            </div>
                          )}
                          {selectedResult.result.trial.response && (
                            <div>
                              <div className="text-[11px] font-medium text-gray-700 mb-1">Response:</div>
                              <pre className="p-2 bg-white rounded text-[11px] whitespace-pre-wrap break-words border max-h-64 overflow-auto">{selectedResult.result.trial.response}</pre>
                            </div>
                          )}
                        </div>
                      </details>
                    )}
                  </div>
                </div>
              )}

              {/* Candidates */}
              {selectedResult.result.rxcuiCandidates.length > 0 && (
                <div>
                  <div className="font-medium mb-1 text-gray-700">RxNav Candidates:</div>
                  <div className="bg-gray-50 p-3 rounded border space-y-1 max-h-64 overflow-auto">
                    {selectedResult.result.rxcuiCandidates.map((c, i) => (
                      <div key={i} className="border-b border-gray-200 pb-1 last:border-b-0">
                        <span className="font-mono text-blue-700">{c.rxcui}</span>
                        {c.name && <span className="ml-2 text-gray-700">{c.name}</span>}
                        {c.tty && <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-gray-100 border">{c.tty}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Summary */}
      {completedResults.length > 0 && (
        <div className="mt-6 bg-white/80 rounded-xl border p-4 shadow-sm">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Summary</h2>
          <div className="text-xs space-y-1">
            <div>
              <span className="font-medium">Total tested:</span> {completedResults.length}
            </div>
            <div>
              <span className="font-medium">With normalization:</span>{" "}
              {completedResults.filter((r) => r.normalizedName).length}
            </div>
            <div>
              <span className="font-medium">With RxCUI:</span>{" "}
              {completedResults.filter((r) => r.rxcui).length}
            </div>
            <div>
              <span className="font-medium">With verified RxCUI:</span>{" "}
              {completedResults.filter((r) => r.trial?.verification?.ok).length}
            </div>
            <div>
              <span className="font-medium">Average assurity:</span>{" "}
              {(() => {
                const withAssurity = completedResults.filter((r) => r.namingResult?.assurity !== undefined);
                if (withAssurity.length === 0) return "—";
                const avg = withAssurity.reduce((sum, r) => sum + (r.namingResult?.assurity || 0), 0) / withAssurity.length;
                return `${avg.toFixed(1)}%`;
              })()}
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
