"use client";

import { useCallback, useEffect, useState, Fragment } from "react";
import { loadMedicationsList } from "../../../lib/medicationsLoader";
import { getRxcuiProps } from "../../../lib/api";
import { callOpenAIRaw } from "../../../lib/api";
import { medicationNormalizationPrompt, compareMedicationNamesPrompt } from "../../../lib/prompts";

type NormalizedMedication = {
  ingredient: string;
  strength: string | null;
  form: string | null;
  brand: string | null;
  route: string | null;
  normalized: string;
};

type RxCuiResult = {
  rxcui: string | null;
  name: string | null;
  tty: string | null;
  source: 'exact' | 'approximate';
};

type SplSetIdResult = {
  splSetId: string | null;
  productNdc: string | null;
  rxcuis: string[];
  source: 'rxcui' | 'brand_ingredient' | 'brand_ingredient_strength' | 'relaxed' | 'broad';
};

type MedicationResult = {
  originalName: string;
  normalized: NormalizedMedication | null;
  rxcuiResult: RxCuiResult | null;
  splSetIdResult: SplSetIdResult | null;
  ndcData: Array<{
    ndc: string;
    normalizedNdc: string;
    fdaInfo: any;
    labelInfo: any;
  }>;
  status: "pending" | "processing" | "completed" | "error";
  error?: string;
};

// Normalize NDC to standard format (10-digit, 4-4-2)
function normalizeNDC(ndc: string): string {
  const s = ndc.replace(/\D/g, "");
  if (s.length === 11) {
    // Remove leading zero if present (e.g., 00069-3130-19 -> 0069-3130-19)
    // Check if first digit is 0, if so remove it and format as 10-digit
    if (s[0] === "0") {
      return `${s.slice(1, 5)}-${s.slice(5, 9)}-${s.slice(9)}`;
    }
    // Otherwise format as 5-4-2 (e.g., 12345-6789-01)
    return `${s.slice(0, 5)}-${s.slice(5, 9)}-${s.slice(9)}`;
  }
  if (s.length === 10) {
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
  }
  return ndc;
}

// Step 1: LLM Normalization
async function normalizeMedication(medicationName: string): Promise<NormalizedMedication | null> {
  try {
    const prompt = medicationNormalizationPrompt(medicationName);
    const { parsed } = await callOpenAIRaw("gpt-4o", prompt);
    const result = (parsed ?? {}) as any;
    
    if (result.ingredient && result.normalized) {
      return {
        ingredient: String(result.ingredient),
        strength: result.strength ? String(result.strength) : null,
        form: result.form ? String(result.form) : null,
        brand: result.brand ? String(result.brand) : null,
        route: result.route ? String(result.route) : null,
        normalized: String(result.normalized),
      };
    }
    return null;
  } catch (e) {
    console.error("Error in LLM normalization:", e);
    return null;
  }
}

// Step 2: RxCUI Retrieval
async function getRxCuiFromName(normalizedName: string): Promise<RxCuiResult | null> {
  try {
    // Primary lookup: exact name match
    const exactRes = await fetch(
      `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(normalizedName)}`
    );
    
    if (exactRes.ok) {
      const exactJson = await exactRes.json();
      const rxcuis = exactJson?.idGroup?.rxnormId || [];
      if (rxcuis.length > 0) {
        const rxcui = String(rxcuis[0]);
        // Get properties to get name and TTY
        try {
          const props = await getRxcuiProps(rxcui);
          if (props) {
            return {
              rxcui,
              name: String(props.name || ""),
              tty: String((props as any).tty || ""),
              source: 'exact',
            };
          }
        } catch {}
        return {
          rxcui,
          name: null,
          tty: null,
          source: 'exact',
        };
      }
    }

    // Fallback: approximateTerm
    const approxRes = await fetch(
      `https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=${encodeURIComponent(normalizedName)}&maxEntries=20`
    );
    
    if (approxRes.ok) {
      const approxJson = await approxRes.json();
      const candidates = approxJson?.approximateGroup?.candidate || [];
      
      if (candidates.length > 0) {
        // Use LLM to find best match
        let bestCandidate: any = null;
        let bestScore = 0;
        
        for (const candidate of candidates.slice(0, 5)) {
          const candidateName = candidate.name || "";
          const candidateRxCui = String(candidate.rxcui || "");
          
          try {
            const comparePrompt = compareMedicationNamesPrompt(normalizedName, candidateName);
            const { parsed } = await callOpenAIRaw("gpt-4o", comparePrompt);
            const result = (parsed ?? {}) as any;
            const matchScore = typeof result.matchScore === "number" ? result.matchScore : 0;
            
            if (matchScore > bestScore && matchScore >= 80) {
              bestScore = matchScore;
              bestCandidate = candidate;
              bestCandidate.rxcui = candidateRxCui;
            }
          } catch (e) {
            // Continue to next candidate
          }
        }
        
        if (bestCandidate) {
          // Get properties
          try {
            const props = await getRxcuiProps(bestCandidate.rxcui);
            if (props) {
              return {
                rxcui: bestCandidate.rxcui,
                name: String(props.name || bestCandidate.name || ""),
                tty: String((props as any).tty || bestCandidate.tty || ""),
                source: 'approximate',
              };
            }
          } catch {}
          return {
            rxcui: bestCandidate.rxcui,
            name: bestCandidate.name || null,
            tty: bestCandidate.tty || null,
            source: 'approximate',
          };
        }
      }
    }
    
    return null;
  } catch (e) {
    console.error("Error in RxCUI retrieval:", e);
    return null;
  }
}

// Step 3: SPL Set ID Retrieval with fallbacks
async function getSplSetId(
  rxcui: string | null,
  normalized: NormalizedMedication
): Promise<SplSetIdResult | null> {
  if (!rxcui && !normalized.brand && !normalized.ingredient) {
    return null;
  }

  try {
    // Primary: Search by RxCUI
    if (rxcui) {
      const rxcuiRes = await fetch(
        `https://api.fda.gov/drug/ndc.json?search=openfda.rxcui:"${rxcui}"&limit=1`
      );
      
      if (rxcuiRes.ok) {
        const rxcuiJson = await rxcuiRes.json();
        const results = rxcuiJson?.results || [];
        if (results.length > 0) {
          const r = results[0];
          const splSetId = r.openfda?.spl_set_id 
            ? (Array.isArray(r.openfda.spl_set_id) ? r.openfda.spl_set_id[0] : r.openfda.spl_set_id)
            : null;
          
          if (splSetId) {
            const rxcuis = r.openfda?.rxcui 
              ? (Array.isArray(r.openfda.rxcui) ? r.openfda.rxcui.map(String) : [String(r.openfda.rxcui)])
              : [];
            
            return {
              splSetId: String(splSetId),
              productNdc: r.product_ndc || null,
              rxcuis,
              source: 'rxcui',
            };
          }
        }
      }
    }

    // Fallback 1: Brand + Ingredient (exact)
    if (normalized.brand && normalized.ingredient) {
      const brandIngredientQuery = `brand_name.exact:"${normalized.brand.toUpperCase()}"+AND+active_ingredients.name.exact:"${normalized.ingredient.toUpperCase()}"`;
      const fallback1Res = await fetch(
        `https://api.fda.gov/drug/ndc.json?search=${encodeURIComponent(brandIngredientQuery)}&limit=1`
      );
      
      if (fallback1Res.ok) {
        const fallback1Json = await fallback1Res.json();
        const results = fallback1Json?.results || [];
        if (results.length > 0) {
          const r = results[0];
          const splSetId = r.openfda?.spl_set_id 
            ? (Array.isArray(r.openfda.spl_set_id) ? r.openfda.spl_set_id[0] : r.openfda.spl_set_id)
            : null;
          
          if (splSetId) {
            const rxcuis = r.openfda?.rxcui 
              ? (Array.isArray(r.openfda.rxcui) ? r.openfda.rxcui.map(String) : [String(r.openfda.rxcui)])
              : [];
            
            return {
              splSetId: String(splSetId),
              productNdc: r.product_ndc || null,
              rxcuis,
              source: 'brand_ingredient',
            };
          }
        }
      }

      // Fallback 2: Brand + Ingredient + Strength
      if (normalized.strength) {
        const strengthValue = normalized.strength.match(/(\d+(?:\.\d+)?)/)?.[1];
        if (strengthValue) {
          const brandIngredientStrengthQuery = `${brandIngredientQuery}+AND+active_ingredients.strength:"${strengthValue}"`;
          const fallback2Res = await fetch(
            `https://api.fda.gov/drug/ndc.json?search=${encodeURIComponent(brandIngredientStrengthQuery)}&limit=1`
          );
          
          if (fallback2Res.ok) {
            const fallback2Json = await fallback2Res.json();
            const results = fallback2Json?.results || [];
            if (results.length > 0) {
              const r = results[0];
              const splSetId = r.openfda?.spl_set_id 
                ? (Array.isArray(r.openfda.spl_set_id) ? r.openfda.spl_set_id[0] : r.openfda.spl_set_id)
                : null;
              
              if (splSetId) {
                const rxcuis = r.openfda?.rxcui 
                  ? (Array.isArray(r.openfda.rxcui) ? r.openfda.rxcui.map(String) : [String(r.openfda.rxcui)])
                  : [];
                
                return {
                  splSetId: String(splSetId),
                  productNdc: r.product_ndc || null,
                  rxcuis,
                  source: 'brand_ingredient_strength',
                };
              }
            }
          }
        }
      }

      // Fallback 3: Relaxed (drop .exact modifiers)
      const relaxedQuery = `brand_name:"${normalized.brand.toUpperCase()}"+AND+active_ingredients.name:"${normalized.ingredient.toUpperCase()}"`;
      const fallback3Res = await fetch(
        `https://api.fda.gov/drug/ndc.json?search=${encodeURIComponent(relaxedQuery)}&limit=1`
      );
      
      if (fallback3Res.ok) {
        const fallback3Json = await fallback3Res.json();
        const results = fallback3Json?.results || [];
        if (results.length > 0) {
          const r = results[0];
          const splSetId = r.openfda?.spl_set_id 
            ? (Array.isArray(r.openfda.spl_set_id) ? r.openfda.spl_set_id[0] : r.openfda.spl_set_id)
            : null;
          
          if (splSetId) {
            const rxcuis = r.openfda?.rxcui 
              ? (Array.isArray(r.openfda.rxcui) ? r.openfda.rxcui.map(String) : [String(r.openfda.rxcui)])
              : [];
            
            return {
              splSetId: String(splSetId),
              productNdc: r.product_ndc || null,
              rxcuis,
              source: 'broad',
            };
          }
        }
      }
    }

    return null;
  } catch (e) {
    console.error("Error in SPL Set ID retrieval:", e);
    return null;
  }
}

// Step 4: Fetch NDCs using SPL Set ID
async function getNDCsBySplSetId(splSetId: string): Promise<Array<{
  ndc: string;
  normalizedNdc: string;
  fdaInfo: any;
  labelInfo: any;
}>> {
  try {
    const ndcRes = await fetch(
      `https://api.fda.gov/drug/ndc.json?search=openfda.spl_set_id:"${splSetId}"&limit=200`
    );
    
    if (!ndcRes.ok) return [];

    const ndcJson = await ndcRes.json();
    const results = ndcJson?.results || [];
    
    const ndcMap = new Map<string, {
      ndc: string;
      normalizedNdc: string;
      fdaInfo: any;
      labelInfo: any;
    }>();

    for (const r of results) {
      // Add product_ndc
      if (r.product_ndc) {
        const normalized = normalizeNDC(r.product_ndc);
        if (!ndcMap.has(normalized)) {
          ndcMap.set(normalized, {
            ndc: r.product_ndc,
            normalizedNdc: normalized,
            fdaInfo: {
              labeler_name: r.labeler_name,
              brand_name: r.brand_name,
              marketing_status: r.marketing_status,
              package_description: r.package_description,
              marketing_start: r.marketing_start_date,
              marketing_end: r.marketing_end_date,
              application_number: r.application_number,
              dosage_form: r.dosage_form,
              route: r.route,
              product_type: r.product_type,
              generic_name: r.generic_name,
            },
            labelInfo: null,
          });
        }
      }

      // Add packaging NDCs
      if (r.packaging) {
        for (const p of r.packaging) {
          if (p.package_ndc) {
            const normalized = normalizeNDC(p.package_ndc);
            if (!ndcMap.has(normalized)) {
              ndcMap.set(normalized, {
                ndc: p.package_ndc,
                normalizedNdc: normalized,
                fdaInfo: {
                  labeler_name: r.labeler_name,
                  brand_name: r.brand_name,
                  marketing_status: r.marketing_status,
                  package_description: p.description || r.package_description,
                  marketing_start: r.marketing_start_date,
                  marketing_end: r.marketing_end_date,
                  application_number: r.application_number,
                  dosage_form: r.dosage_form,
                  route: r.route,
                  product_type: r.product_type,
                  generic_name: r.generic_name,
                },
                labelInfo: null,
              });
            }
          }
        }
      }
    }

    // Step 5: Fetch FDA label for SPL Set ID
    try {
      const labelRes = await fetch(
        `https://api.fda.gov/drug/label.json?search=openfda.spl_set_id:"${splSetId}"&limit=1`
      );
      
      if (labelRes.ok) {
        const labelJson = await labelRes.json();
        const labelResults = labelJson?.results || [];
        if (labelResults.length > 0) {
          const labelData = labelResults[0];
          // Apply label info to all NDCs
          for (const [key, ndcItem] of ndcMap.entries()) {
            ndcMap.set(key, {
              ...ndcItem,
              labelInfo: {
                indications_and_usage: labelData.indications_and_usage,
                warnings: labelData.warnings,
                marketing_status: labelData.marketing_status,
                openfda: labelData.openfda,
              },
            });
          }
        }
      }
    } catch (labelError) {
      console.error("Error fetching FDA label:", labelError);
    }

    return Array.from(ndcMap.values());
  } catch (e) {
    console.error("Error fetching NDCs by SPL Set ID:", e);
    return [];
  }
}

export default function FMBPage() {
  const [medications, setMedications] = useState<Array<{ name: string }>>([]);
  const [results, setResults] = useState<Record<string, MedicationResult>>({});
  const [loading, setLoading] = useState(false);
  const [loadingList, setLoadingList] = useState(true);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [autoRun, setAutoRun] = useState(false);
  const [delay, setDelay] = useState(1000);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

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
            normalized: null,
            rxcuiResult: null,
            splSetIdResult: null,
            ndcData: [],
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
          normalized: null,
          rxcuiResult: null,
          splSetIdResult: null,
          ndcData: [],
          status: "pending",
        },
        status: "processing",
        error: undefined,
      },
    }));

    try {
      // Step 1: LLM Normalization
      const normalized = await normalizeMedication(medName);
      if (!normalized) {
        throw new Error("Failed to normalize medication name");
      }

      // Step 2: RxCUI Retrieval
      const rxcuiResult = await getRxCuiFromName(normalized.normalized);

      // Step 3: SPL Set ID Retrieval with fallbacks
      const splSetIdResult = await getSplSetId(
        rxcuiResult?.rxcui || null,
        normalized
      );

      // Step 4: Fetch NDCs using SPL Set ID
      let ndcData: Array<{
        ndc: string;
        normalizedNdc: string;
        fdaInfo: any;
        labelInfo: any;
      }> = [];

      if (splSetIdResult?.splSetId) {
        ndcData = await getNDCsBySplSetId(splSetIdResult.splSetId);
      }

      setResults((prev) => ({
        ...prev,
        [key]: {
          originalName: medName,
          normalized,
          rxcuiResult,
          splSetIdResult,
          ndcData,
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
            normalized: null,
            rxcuiResult: null,
            splSetIdResult: null,
            ndcData: [],
            status: "pending",
          },
          status: "error",
          error: msg,
        },
      }));
    }
  }, [medications]);

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

  // Toggle row expansion
  const toggleRow = useCallback((key: string) => {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }, []);

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

  return (
    <main className="mx-auto max-w-7xl p-4 sm:p-6">
      <div className="rounded-xl bg-white/80 backdrop-blur border px-4 sm:px-6 py-5 shadow-sm mb-4">
        <h1 className="text-xl sm:text-2xl font-bold text-blue-700">FMB - Medication Batch</h1>
        <p className="text-xs sm:text-sm text-gray-600 mt-1">
          Batch processing using LLM normalization, RxCUI retrieval with LLM comparison, SPL Set ID retrieval with fallbacks, and NDC fetching. Shows Input, Normalised Name, RxCUI Value, SPL Set ID, and NDCs.
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
                <th className="px-3 py-2 text-left font-medium text-gray-700 w-8"></th>
                <th className="px-3 py-2 text-left font-medium text-gray-700">Status</th>
                <th className="px-3 py-2 text-left font-medium text-gray-700">Input</th>
                <th className="px-3 py-2 text-left font-medium text-gray-700">Normalised Name</th>
                <th className="px-3 py-2 text-left font-medium text-gray-700">RxCUI Value</th>
                <th className="px-3 py-2 text-left font-medium text-gray-700">SPL Set ID</th>
                <th className="px-3 py-2 text-left font-medium text-gray-700">NDCs</th>
                <th className="px-3 py-2 text-left font-medium text-gray-700">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              {medications.map((med, idx) => {
                const resultKey = getResultKey(med, idx);
                const result = results[resultKey] || {
                  originalName: med.name,
                  normalized: null,
                  rxcuiResult: null,
                  splSetIdResult: null,
                  ndcData: [],
                  status: "pending" as const,
                };
                const isExpanded = expandedRows.has(resultKey);

                return (
                  <Fragment key={idx}>
                    <tr
                      className={
                        result.status === "processing"
                          ? "bg-blue-50"
                          : result.status === "error"
                          ? "bg-red-50"
                          : ""
                      }
                    >
                      <td className="px-3 py-2">
                        {result.status === "completed" && result.ndcData.length > 0 && (
                          <button
                            onClick={() => toggleRow(resultKey)}
                            className="text-gray-600 hover:text-blue-700"
                          >
                            {isExpanded ? "▼" : "▶"}
                          </button>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`px-2 py-1 rounded text-[10px] font-medium ${
                            result.status === "completed"
                              ? "bg-green-100 text-green-800"
                              : result.status === "processing"
                              ? "bg-blue-100 text-blue-800"
                              : result.status === "error"
                              ? "bg-red-100 text-red-800"
                              : "bg-gray-100 text-gray-800"
                          }`}
                        >
                          {result.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-gray-900">{med.name}</td>
                      <td className="px-3 py-2">
                        {result.normalized ? (
                          <div className="space-y-1">
                            <span className="font-mono text-green-700">{result.normalized.normalized}</span>
                            {result.normalized.ingredient && (
                              <div className="text-[9px] text-gray-600">
                                Ingredient: {result.normalized.ingredient}
                                {result.normalized.strength && ` | ${result.normalized.strength}`}
                                {result.normalized.form && ` | ${result.normalized.form}`}
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {result.rxcuiResult?.rxcui ? (
                          <div className="space-y-1">
                            <div className="font-mono text-blue-700 font-semibold">{result.rxcuiResult.rxcui}</div>
                            {result.rxcuiResult.name && (
                              <div className="text-[9px] text-gray-600">{result.rxcuiResult.name}</div>
                            )}
                            {result.rxcuiResult.tty && (
                              <div className="text-[9px] text-gray-500">
                                TTY: {result.rxcuiResult.tty} ({result.rxcuiResult.source})
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {result.splSetIdResult?.splSetId ? (
                          <div className="space-y-1">
                            <div className="font-mono text-purple-700 text-[10px] break-all">
                              {result.splSetIdResult.splSetId}
                            </div>
                            <div className="text-[9px] text-gray-500">
                              Source: {result.splSetIdResult.source}
                            </div>
                          </div>
                        ) : (
                          <span className="text-gray-400">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {result.ndcData.length > 0 ? (
                          <div className="space-y-1">
                            <div className="text-[9px] text-gray-600">
                              {result.ndcData.length} NDC{result.ndcData.length !== 1 ? "s" : ""}
                            </div>
                            <div className="text-[8px] text-gray-500 max-w-xs">
                              {result.ndcData.slice(0, 3).map((ndcItem, i) => (
                                <span key={i}>
                                  {ndcItem.normalizedNdc}
                                  {i < Math.min(2, result.ndcData.length - 1) && ", "}
                                </span>
                              ))}
                              {result.ndcData.length > 3 && ` (+${result.ndcData.length - 3} more)`}
                            </div>
                          </div>
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
                        </div>
                      </td>
                    </tr>
                    {/* Expanded row with NDCs and details */}
                    {isExpanded && result.status === "completed" && (
                      <tr key={`${idx}-expanded`}>
                        <td colSpan={8} className="px-3 py-4 bg-gray-50">
                          <div className="space-y-4">
                            {/* Normalization Details */}
                            {result.normalized && (
                              <div>
                                <h4 className="text-xs font-semibold text-gray-700 mb-2">Normalization Details:</h4>
                                <div className="bg-white rounded border p-3">
                                  <div className="text-[10px] space-y-1">
                                    <div><span className="font-medium">Normalized:</span> {result.normalized.normalized}</div>
                                    <div><span className="font-medium">Ingredient:</span> {result.normalized.ingredient}</div>
                                    {result.normalized.strength && (
                                      <div><span className="font-medium">Strength:</span> {result.normalized.strength}</div>
                                    )}
                                    {result.normalized.form && (
                                      <div><span className="font-medium">Form:</span> {result.normalized.form}</div>
                                    )}
                                    {result.normalized.brand && (
                                      <div><span className="font-medium">Brand:</span> {result.normalized.brand}</div>
                                    )}
                                    {result.normalized.route && (
                                      <div><span className="font-medium">Route:</span> {result.normalized.route}</div>
                                    )}
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* RxCUI Result */}
                            {result.rxcuiResult && (
                              <div>
                                <h4 className="text-xs font-semibold text-gray-700 mb-2">RxCUI Result:</h4>
                                <div className="bg-white rounded border p-3">
                                  <div className="text-[10px] space-y-1">
                                    <div><span className="font-medium">RxCUI:</span> <span className="font-mono">{result.rxcuiResult.rxcui || "—"}</span></div>
                                    {result.rxcuiResult.name && (
                                      <div><span className="font-medium">Name:</span> {result.rxcuiResult.name}</div>
                                    )}
                                    {result.rxcuiResult.tty && (
                                      <div><span className="font-medium">TTY:</span> {result.rxcuiResult.tty}</div>
                                    )}
                                    <div><span className="font-medium">Source:</span> {result.rxcuiResult.source}</div>
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* SPL Set ID Result */}
                            {result.splSetIdResult && (
                              <div>
                                <h4 className="text-xs font-semibold text-gray-700 mb-2">SPL Set ID Result:</h4>
                                <div className="bg-white rounded border p-3">
                                  <div className="text-[10px] space-y-1">
                                    <div><span className="font-medium">SPL Set ID:</span> <span className="font-mono">{result.splSetIdResult.splSetId || "—"}</span></div>
                                    {result.splSetIdResult.productNdc && (
                                      <div><span className="font-medium">Product NDC:</span> {result.splSetIdResult.productNdc}</div>
                                    )}
                                    {result.splSetIdResult.rxcuis.length > 0 && (
                                      <div>
                                        <span className="font-medium">RxCUIs:</span> {result.splSetIdResult.rxcuis.join(", ")}
                                      </div>
                                    )}
                                    <div><span className="font-medium">Source:</span> {result.splSetIdResult.source}</div>
                                  </div>
                                </div>
                              </div>
                            )}

                            {/* NDC Data */}
                            {result.ndcData.length > 0 && (
                              <div>
                                <h4 className="text-xs font-semibold text-gray-700 mb-2">
                                  NDCs ({result.ndcData.length}):
                                </h4>
                                <div className="bg-white rounded border p-3 max-h-96 overflow-auto">
                                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                                    {result.ndcData.map((ndcItem, nIdx) => (
                                      <div
                                        key={nIdx}
                                        className="p-3 bg-gray-50 rounded border border-gray-200 hover:border-blue-400 transition-all"
                                      >
                                        <div className="mb-2">
                                          <label className="text-[10px] text-gray-600">NDC</label>
                                          <p className="font-mono text-sm font-semibold text-gray-900">
                                            {ndcItem.normalizedNdc}
                                          </p>
                                        </div>
                                        {ndcItem.fdaInfo && (
                                          <>
                                            {ndcItem.fdaInfo.labeler_name && (
                                              <div className="mb-1">
                                                <label className="text-[10px] text-gray-600">Labeler</label>
                                                <p className="text-xs text-gray-800">{ndcItem.fdaInfo.labeler_name}</p>
                                              </div>
                                            )}
                                            {ndcItem.fdaInfo.brand_name && (
                                              <div className="mb-1">
                                                <label className="text-[10px] text-gray-600">Brand</label>
                                                <p className="text-xs font-semibold text-blue-700">
                                                  {ndcItem.fdaInfo.brand_name}
                                                </p>
                                              </div>
                                            )}
                                            {ndcItem.fdaInfo.generic_name && (
                                              <div className="mb-1">
                                                <label className="text-[10px] text-gray-600">Generic</label>
                                                <p className="text-xs text-gray-700">
                                                  {ndcItem.fdaInfo.generic_name}
                                                </p>
                                              </div>
                                            )}
                                            {ndcItem.fdaInfo.dosage_form && (
                                              <div className="mb-1">
                                                <label className="text-[10px] text-gray-600">Dosage Form</label>
                                                <p className="text-xs text-gray-800">
                                                  {ndcItem.fdaInfo.dosage_form}
                                                </p>
                                              </div>
                                            )}
                                            {ndcItem.fdaInfo.package_description && (
                                              <div className="mb-1">
                                                <label className="text-[10px] text-gray-600">Package</label>
                                                <p className="text-xs text-gray-800">
                                                  {ndcItem.fdaInfo.package_description}
                                                </p>
                                              </div>
                                            )}
                                            {ndcItem.fdaInfo.marketing_status && (
                                              <div className="mb-1">
                                                <label className="text-[10px] text-gray-600">Status</label>
                                                <span
                                                  className={`text-[10px] px-2 py-0.5 rounded ${
                                                    ndcItem.fdaInfo.marketing_status === "Active" || 
                                                    (ndcItem.fdaInfo.marketing_start && !ndcItem.fdaInfo.marketing_end)
                                                      ? "bg-green-100 text-green-700"
                                                      : "bg-red-100 text-red-700"
                                                  }`}
                                                >
                                                  {ndcItem.fdaInfo.marketing_status}
                                                </span>
                                              </div>
                                            )}
                                            {ndcItem.fdaInfo.marketing_start && (
                                              <div className="mb-1">
                                                <label className="text-[10px] text-gray-600">Marketing Date</label>
                                                <p className="text-xs text-gray-800">
                                                  {ndcItem.fdaInfo.marketing_start}
                                                  {ndcItem.fdaInfo.marketing_end &&
                                                    ` - ${ndcItem.fdaInfo.marketing_end}`}
                                                </p>
                                              </div>
                                            )}
                                            {ndcItem.fdaInfo.application_number && (
                                              <div className="mb-1">
                                                <label className="text-[10px] text-gray-600">Application #</label>
                                                <p className="text-xs text-gray-800">{ndcItem.fdaInfo.application_number}</p>
                                              </div>
                                            )}
                                            {ndcItem.labelInfo && (
                                              <div className="mb-1 mt-2 pt-2 border-t">
                                                <label className="text-[10px] text-gray-600">Label Available</label>
                                                <p className="text-xs text-gray-800">✓ FDA Label Data</p>
                                              </div>
                                            )}
                                          </>
                                        )}
                                        {!ndcItem.fdaInfo && (
                                          <div className="text-[10px] text-gray-500">No FDA info available</div>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              </div>
                            )}

                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </main>
  );
}

