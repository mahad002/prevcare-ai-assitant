import { useState } from "react";
import { Medication } from "../types/models";
import { medicationPrompt } from "../lib/prompts";
import { queryGemini, getRxCui, validateRxCui, getNDCs, getFDAInfo } from "../lib/api";
// Note: queryGemini function name is kept for backward compatibility, but it now uses OpenAI

export function useMedicationAssistant() {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<Medication[]>([]);
  const [diagnosis, setDiagnosis] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  const getRecommendations = async (condition: string) => {
    if (!condition.trim()) return;
    setLoading(true);
    setError(null);
    try {
      // Step 1: Get clinical recommendations from GPT (clinical reasoning)
      const ai = await queryGemini(medicationPrompt(condition));
      const meds = ai.recommended_drugs || [];
      
      if (meds.length === 0) {
        setDiagnosis(ai.diagnosis || condition);
        setResult([]);
        setLoading(false);
        return;
      }

      // Step 2: Post-process and resolve authoritative RxCUIs from RxNav
      const enriched: Medication[] = [];

      for (const med of meds) {
        // Step 2a: Resolve RxCUI from drug name (authoritative U.S. drug identifier)
        const rxcui = await getRxCui(med.drug_name);
        
        if (!rxcui) {
          // If RxCUI not found, still include the medication but log it
          console.warn(`RxCUI not found for: ${med.drug_name}`);
          enriched.push({ ...med, rxcui: undefined, ndcs: [] });
          continue;
        }

        // Step 2b: Validate RxCUI before proceeding
        const isValid = await validateRxCui(rxcui);
        
        if (!isValid) {
          // If RxCUI is invalid, skip enrichment but log it
          console.warn(`Invalid RxCUI ${rxcui} for: ${med.drug_name}. Skipping NDC and FDA enrichment.`);
          enriched.push({ ...med, rxcui, ndcs: [] });
          continue;
        }

        // Step 3: Get NDCs for this validated RxCUI
        const ndcs = await getNDCs(rxcui);
        const ndcDetails = [] as any[];
        
        // Step 4: Enrich with FDA data for the first few for performance, but include all NDC codes
        const MAX_FDA_ENRICH = 3;
        for (let idx = 0; idx < ndcs.length; idx++) {
          const n = ndcs[idx];
          if (idx < MAX_FDA_ENRICH) {
            const fda = await getFDAInfo(n);
            ndcDetails.push({ ndc: n, ...(fda || {}) });
          } else {
            ndcDetails.push({ ndc: n });
          }
        }
        
        enriched.push({ ...med, rxcui, ndcs: ndcDetails });
      }

      setDiagnosis(ai.diagnosis || condition);
      setResult(enriched);
    } catch (error) {
      console.error("Error getting recommendations:", error);
      const errorMessage = error instanceof Error ? error.message : "An unknown error occurred";
      setError(errorMessage);
      setResult([]);
      setDiagnosis(condition);
    } finally {
      setLoading(false);
    }
  };

  return { loading, result, diagnosis, error, getRecommendations };
}
