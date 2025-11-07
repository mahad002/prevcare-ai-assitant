"use client";

import { useCallback, useEffect, useState } from "react";
import { getRxCui, getRxCuiCandidates } from "../../../../lib/api";
import { callOpenAIRaw } from "../../../../lib/api";
import { fixNamingConventionPrompt } from "../../../../lib/prompts";
import { loadMedicationsList } from "../../../../lib/medicationsLoader";
import { resolveMedication, type Resolution } from "../../../../lib/rxcuiResolution";
import { type RxCuiLookupResult } from "../../../../lib/rxcuiEnhanced";

type MedicationTestResult = {
  originalName: string;
  normalizedName: string | null;
  namingResult: {
    original: string;
    normalized: string;
    corrected: boolean;
    rationale?: string;
    assurity?: number;
  } | null;
  rxcui: string | null; // Most specific RxCUI
  groupRxCui: string | null; // Ingredient-level RxCUI (group)
  rxcuiApiResponse: unknown; // Raw API response from RxNav
  rxcuiResolution: Resolution | null; // New resolution result
  rxcuiLookupResult: RxCuiLookupResult | null; // Enhanced lookup result
  rxcuiCandidates: Array<{ rxcui: string; name?: string; tty?: string; source?: string; score?: number }>;
  rxcuiCandidatesApiResponse: unknown; // Raw API response for candidates
  error?: string;
  status: "pending" | "processing" | "completed" | "error";
};

export default function BatchTestMedPage() {
  const [medications, setMedications] = useState<Array<{ name: string }>>([]);
  const [results, setResults] = useState<Record<string, MedicationTestResult>>({});
  const [loading, setLoading] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [autoRun, setAutoRun] = useState(false);
  const [delay, setDelay] = useState(1000); // Delay between tests in ms
  const [selectedApiResponse, setSelectedApiResponse] = useState<{
    rxcui?: unknown;
    candidates?: unknown;
    candidateType?: 'processed' | 'lookup';
    lookupResult?: RxCuiLookupResult | null;
    resolution?: Resolution | null;
  } | null>(null);

  // Load medications list on mount
  useEffect(() => {
    const loadList = async () => {
      setLoadingList(true);
      try {
        const meds = await loadMedicationsList();
        setMedications(meds);
        // Initialize results - use index as key to handle duplicate medication names
        const initialResults: Record<string, MedicationTestResult> = {};
        meds.forEach((med, index) => {
          // Use index-based key to handle duplicates, but keep name lookup for compatibility
          const key = `${med.name}::${index}`;
          initialResults[key] = {
          originalName: med.name,
          normalizedName: null,
          namingResult: null,
          rxcui: null,
          groupRxCui: null,
          rxcuiApiResponse: null,
          rxcuiResolution: null,
          rxcuiLookupResult: null,
          rxcuiCandidates: [],
          rxcuiCandidatesApiResponse: null,
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
      const { parsed } = await callOpenAIRaw("gpt-4o", prompt);
      const result = (parsed ?? {}) as Record<string, unknown>;
      
      const original = typeof result.original === "string" ? result.original : medicationName;
      const normalized = typeof result.normalized === "string" ? result.normalized : medicationName;
      const corrected = typeof result.corrected === "boolean" ? result.corrected : false;
      const rationale = typeof result.rationale === "string" ? result.rationale : undefined;
      const assurity = typeof result.assurity === "number" && result.assurity >= 0 && result.assurity <= 100 
        ? result.assurity 
        : undefined;
      
      return { original, normalized, corrected, rationale, assurity };
    } catch (e) {
      console.error("Error fixing naming convention:", e);
      return {
        original: medicationName,
        normalized: medicationName,
        corrected: false,
      };
    }
  }, []);

  // Test a single medication
  const testMedication = useCallback(async (medication: { name: string }, resultKey?: string) => {
    const medName = medication.name.trim();
    if (!medName) return;

    // Use provided key or find/create one
    const key = resultKey || `${medName}::${medications.findIndex(m => m.name === medName)}`;
    
    // Update status to processing
    setResults((prev) => ({
      ...prev,
      [key]: {
        ...prev[key] || {
          originalName: medName,
          normalizedName: null,
          namingResult: null,
          rxcui: null,
          groupRxCui: null,
          rxcuiApiResponse: null,
          rxcuiResolution: null,
          rxcuiLookupResult: null,
          rxcuiCandidates: [],
          rxcuiCandidatesApiResponse: null,
          status: "pending",
        },
        status: "processing",
        error: undefined,
      },
    }));

    try {
      // Step 1: Fix naming convention
      const namingResult = await fixNamingConvention(medName);
      
      // Use normalized name if correction was made and it's different from original
      const searchName = (namingResult?.corrected && namingResult.normalized && namingResult.normalized.trim() !== medName.trim()) 
        ? namingResult.normalized.trim() 
        : medName;

      // Step 2: Search RxCUI with new resolution flow
      let rxcui: string | null = null;
      let groupRxCui: string | null = null;
      let rxcuiApiResponse: unknown = null;
      let rxcuiResolution: Resolution | null = null;
      let rxcuiCandidates: Array<{ rxcui: string; name?: string; tty?: string; source?: string; score?: number }> = [];
      let rxcuiCandidatesApiResponse: unknown = null;

      try {
        // Use new resolution flow
        rxcuiResolution = await resolveMedication(medName);
        
        if (rxcuiResolution.final) {
          rxcui = rxcuiResolution.final.rxcui;
          rxcuiApiResponse = {
            resolution: rxcuiResolution,
          };
        }
        
        if (rxcuiResolution.groupRxCui?.ingredientRxcui) {
          groupRxCui = rxcuiResolution.groupRxCui.ingredientRxcui;
        }
        
        // Convert candidates to display format
        rxcuiCandidates = rxcuiResolution.candidates.map(c => ({
          rxcui: c.rxcui,
          name: c.name,
          tty: c.tty,
          source: c.source,
          score: c.compositeScore || c.approxScore,
        }));
        
        rxcuiCandidatesApiResponse = {
          resolution: rxcuiResolution,
          candidates: rxcuiResolution.candidates,
        };
      } catch (apiError) {
        console.error("Error in RxCUI resolution:", apiError);
        // Fallback to basic lookup
        try {
          rxcui = await getRxCui(searchName);
          rxcuiCandidates = await getRxCuiCandidates(searchName, 8);
        } catch (fallbackError) {
          console.error("Fallback lookup also failed:", fallbackError);
        }
      }

      // Update results
      setResults((prev) => ({
        ...prev,
        [key]: {
          originalName: medName,
          normalizedName: searchName !== medName ? searchName : null,
          namingResult,
          rxcui,
          groupRxCui: groupRxCui,
          rxcuiApiResponse,
          rxcuiResolution,
          rxcuiLookupResult: null,
          rxcuiCandidates,
          rxcuiCandidatesApiResponse,
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
            groupRxCui: null,
            rxcuiApiResponse: null,
            rxcuiResolution: null,
            rxcuiLookupResult: null,
            rxcuiCandidates: [],
            rxcuiCandidatesApiResponse: null,
            status: "pending",
          },
          status: "error",
          error: msg,
        },
      }));
    }
  }, [fixNamingConvention, medications]);

  // Helper to get result key for a medication
  const getResultKey = useCallback((med: { name: string }, index: number) => {
    // Try to find existing key with this name and index
    const possibleKey = `${med.name}::${index}`;
    if (results[possibleKey]) return possibleKey;
    // Fallback: try to find any key with this name (for backward compatibility)
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

  // Statistics - count based on medications array, not results object (to handle duplicates correctly)
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
        <h1 className="text-xl sm:text-2xl font-bold text-blue-700">Batch Medication Test</h1>
        <p className="text-xs sm:text-sm text-gray-600 mt-1">
          Test all medications from the list using the test med method.
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
                <th className="px-3 py-2 text-left font-medium text-gray-700">Group RxCUI</th>
                <th className="px-3 py-2 text-left font-medium text-gray-700">Exact RxCUI</th>
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
            groupRxCui: null,
            rxcuiApiResponse: null,
            rxcuiLookupResult: null,
            rxcuiCandidates: [],
            rxcuiCandidatesApiResponse: null,
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
                      {result.groupRxCui ? (
                        <span className="font-mono text-gray-700" title="Ingredient-level RxCUI">{result.groupRxCui}</span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {result.rxcui ? (
                        <div className="space-y-1">
                          <div className="font-mono text-blue-700" title="Most specific RxCUI">
                            {result.rxcui}
                          </div>
                          {result.rxcuiCandidates.length > 0 && (
                            <div className="text-[9px] text-gray-600">
                              Selected from {result.rxcuiCandidates.length} candidates
                              {result.rxcuiCandidates.length > 0 && (
                                <div className="mt-1 text-[8px] text-gray-500 max-w-xs">
                                  Top candidates: {result.rxcuiCandidates.slice(0, 3).map((c, i) => (
                                    <span key={i}>
                                      {c.rxcui}
                                      {c.source === 'RXNORM' && <span className="text-green-600">*</span>}
                                      {i < Math.min(2, result.rxcuiCandidates.length - 1) && ', '}
                                    </span>
                                  ))}
                                  {result.rxcuiCandidates.length > 3 && ` (+${result.rxcuiCandidates.length - 3} more)`}
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      ) : result.rxcuiLookupResult ? (
                        <span className="text-red-600 text-[10px]" title={result.rxcuiLookupResult.error || "No RxCUI found"}>
                          Failed ({result.rxcuiLookupResult.attempts.length} attempts)
                        </span>
                      ) : result.rxcuiCandidates.length > 0 ? (
                        <div className="text-[9px] text-gray-600">
                          {result.rxcuiCandidates.length} candidates found, but none selected
                          <div className="mt-1 text-[8px] text-gray-500">
                            Top: {result.rxcuiCandidates.slice(0, 3).map((c, i) => (
                              <span key={i}>
                                {c.rxcui}
                                {c.source === 'RXNORM' && <span className="text-green-600">*</span>}
                                {i < Math.min(2, result.rxcuiCandidates.length - 1) && ', '}
                              </span>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {result.rxcuiCandidates.length > 0 ? (
                        <button
                          onClick={() => setSelectedApiResponse({
                            candidates: result.rxcuiCandidates,
                            candidateType: 'processed',
                          })}
                          className="text-gray-700 hover:text-blue-700 text-[10px] underline"
                        >
                          {result.rxcuiCandidates.length} candidates
                        </button>
                      ) : result.rxcuiLookupResult?.attempts.some(a => a.apiResponse?.approximateGroup?.candidate) ? (
                        <button
                          onClick={() => {
                            const candidates = result.rxcuiLookupResult!.attempts
                              .flatMap(a => {
                                const cands = (a.apiResponse?.approximateGroup?.candidate || []) as Array<{
                                  rxcui?: unknown;
                                  name?: unknown;
                                  source?: unknown;
                                  score?: unknown;
                                  rank?: unknown;
                                }>;
                                return cands.map((c) => ({
                                  rxcui: String(c.rxcui || ''),
                                  name: String(c.name || ''),
                                  source: String(c.source || ''),
                                  score: typeof c.score === 'number' ? c.score : 0,
                                  rank: String(c.rank || ''),
                                }));
                              })
                              .filter((c) => c.rxcui);
                            setSelectedApiResponse({
                              candidates,
                              candidateType: 'lookup',
                            });
                          }}
                          className="text-gray-700 hover:text-blue-700 text-[10px] underline"
                        >
                          View candidates
                        </button>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1 items-center">
                        <button
                          onClick={() => {
                            // Store the result key for this test
                            const key = getResultKey(med, idx);
                            handleTestSingle(med, key);
                          }}
                          disabled={result.status === "processing"}
                          className="text-blue-600 hover:text-blue-800 text-[10px] disabled:opacity-50"
                        >
                          Test
                        </button>
                        {(result.rxcuiApiResponse || result.rxcuiCandidatesApiResponse || result.rxcuiResolution) && (
                          <button
                            onClick={() => setSelectedApiResponse({
                              rxcui: result.rxcuiApiResponse,
                              candidates: result.rxcuiCandidatesApiResponse,
                              resolution: result.rxcuiResolution,
                            })}
                            className="text-[10px] text-gray-600 hover:text-gray-800 underline"
                          >
                            API
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

      {/* API Response Modal */}
      {selectedApiResponse && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50"
          onClick={() => setSelectedApiResponse(null)}
        >
          <div
            className="bg-white rounded-lg shadow-xl p-4 max-w-4xl max-h-[90vh] overflow-auto m-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-xs space-y-4">
              <div className="flex justify-between items-center mb-2">
                <h3 className="font-semibold text-gray-900">RxCUI API Responses</h3>
                <button
                  onClick={() => setSelectedApiResponse(null)}
                  className="text-gray-500 hover:text-gray-700 text-lg"
                >
                  ✕
                </button>
              </div>
              {selectedApiResponse.rxcui != null && (
                <div>
                  <div className="font-medium mb-1 text-gray-700">RxCUI API Response:</div>
                  <pre className="text-[10px] whitespace-pre-wrap break-words bg-gray-50 p-3 rounded border overflow-auto max-h-64">
                    {JSON.stringify(selectedApiResponse.rxcui, null, 2)}
                  </pre>
                </div>
              )}
              {selectedApiResponse.candidates != null && (
                <div>
                  <div className="font-medium mb-2 text-gray-700">
                    {selectedApiResponse.candidateType === 'processed' ? 'Candidates List' : 'Candidates from Lookup'}:
                  </div>
                  <div className="bg-gray-50 p-3 rounded border overflow-auto max-h-96">
                    <div className="text-[10px] space-y-2">
                      {Array.isArray(selectedApiResponse.candidates) ? (
                        (selectedApiResponse.candidates as Array<{
                          rxcui?: unknown;
                          name?: unknown;
                          tty?: unknown;
                          source?: unknown;
                          score?: unknown;
                        }>).map((candidate, cIdx: number) => (
                          <div key={cIdx} className="border-b border-gray-200 pb-2 last:border-b-0">
                            <div className="font-mono text-blue-700 font-semibold">{String(candidate.rxcui ?? '')}</div>
                            {candidate.name != null && (
                              <div className="text-gray-700 text-[9px] mt-1">{String(candidate.name)}</div>
                            )}
                            <div className="flex gap-3 mt-1 flex-wrap">
                              {candidate.tty != null && (
                                <div className="text-gray-600 text-[9px]">TTY: {String(candidate.tty)}</div>
                              )}
                              {candidate.source != null && (
                                <div className={`text-[9px] ${String(candidate.source) === 'RXNORM' ? 'text-green-700 font-semibold' : 'text-gray-600'}`}>
                                  Source: {String(candidate.source)}
                                </div>
                              )}
                              {candidate.score !== undefined && (
                                <div className="text-gray-600 text-[9px]">Score: {typeof candidate.score === 'number' ? candidate.score.toFixed(2) : parseFloat(String(candidate.score)).toFixed(2)}</div>
                              )}
                            </div>
                          </div>
                        ))
                      ) : (
                        <pre className="text-[10px] whitespace-pre-wrap break-words">
                          {JSON.stringify(selectedApiResponse.candidates, null, 2)}
                        </pre>
                      )}
                    </div>
                  </div>
                </div>
              )}
              {selectedApiResponse.resolution && (
                <div>
                  <div className="font-medium mb-1 text-gray-700">Resolution Result:</div>
                  <div className="bg-gray-50 p-3 rounded border space-y-2">
                    <div className="text-[10px]">
                      {selectedApiResponse.resolution.final ? (
                        <>
                          <div><span className="font-medium">Status:</span> Found</div>
                          <div><span className="font-medium">RxCUI:</span> {selectedApiResponse.resolution.final.rxcui}</div>
                          <div><span className="font-medium">TTY:</span> {selectedApiResponse.resolution.final.tty}</div>
                          <div><span className="font-medium">Name:</span> {selectedApiResponse.resolution.final.name}</div>
                          <div><span className="font-medium">Verification:</span> Status={selectedApiResponse.resolution.final.verification.statusChecked ? '✓' : '✗'}, Properties={selectedApiResponse.resolution.final.verification.propertiesChecked ? '✓' : '✗'}, NDC={selectedApiResponse.resolution.final.verification.ndcFound ? '✓' : '✗'}</div>
                        </>
                      ) : (
                        <div className="text-red-600">No match found</div>
                      )}
                      {selectedApiResponse.resolution.groupRxCui?.ingredientRxcui && (
                        <div><span className="font-medium">Group RxCUI:</span> {selectedApiResponse.resolution.groupRxCui.ingredientRxcui} ({selectedApiResponse.resolution.groupRxCui.ingredientName})</div>
                      )}
                      <div className="mt-2">
                        <div className="font-medium mb-1">Differences:</div>
                        <div className="text-[9px] text-gray-700">
                          {selectedApiResponse.resolution.differences.join('; ')}
                        </div>
                      </div>
                      <div className="mt-2">
                        <div className="font-medium mb-1">Attempts Log ({selectedApiResponse.resolution.attemptsLog.length}):</div>
                        <div className="space-y-1 max-h-48 overflow-auto text-[9px]">
                          {selectedApiResponse.resolution.attemptsLog.map((log: string, idx: number) => (
                            <div key={idx} className="text-gray-600 font-mono">{log}</div>
                          ))}
                        </div>
                      </div>
                    </div>
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

