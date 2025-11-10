"use client";

import { useState, useCallback } from "react";
import { callOpenAIRaw } from "../../../lib/api";
import { getRxcuiProps, getNDCs, getFDAInfo } from "../../../lib/api";
import { medicationNormalizationPrompt, medicationComparisonPrompt, medicationSynonymExpansionPrompt, medicationEntailmentPrompt } from "../../../lib/prompts";

// Normalize NDC to standard format (10 or 11 digits with hyphens)
function normalizeNDC(ndc: string): string {
  const s = ndc.replace(/\D/g, ""); // Remove all non-digits
  if (s.length === 10) {
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
  }
  if (s.length === 11) {
    // Try 5-4-2 first, then 5-3-3
    if (s.slice(5, 9).length === 4) {
      return `${s.slice(0, 5)}-${s.slice(5, 9)}-${s.slice(9)}`;
    }
    return `${s.slice(0, 5)}-${s.slice(5, 8)}-${s.slice(8)}`;
  }
  return ndc; // Return original if can't normalize
}

type NormalizedData = {
  ingredient: string;
  strength: string | null;
  form: string | null;
  brand: string | null;
  route: string | null;
  package_quantity: string | null;
  normalized: string;
};

type RxCuiCandidate = {
  rxcui: string;
  name: string;
  score: number;
  source: "exact" | "approximate";
};

type VerificationResult = {
  ingredientMatch: number; // 0, 0.5, or 1
  strengthMatch: number;
  formMatch: number;
  brandMatch: number;
  routeMatch: number;
  rxnormScore: number; // RxNorm's own approximateTerm score (0-100)
  isActive: boolean; // If suppress = N and status = ACTIVE
  assurity: number;
  details: {
    ingredient: string;
    strength: string;
    form: string;
    brand: string;
    route: string;
    tty: string;
    suppress: string;
    status: string;
  };
  semanticEntailment?: {
    entails: boolean;
    confidence: number;
    reasoning: string;
  };
};

type NDCInfo = {
  ndc: string;
  normalizedNdc: string;
  active: boolean;
  fdaInfo: {
    labeler_name?: string;
    brand_name?: string;
    marketing_status?: string;
    package_description?: string;
    marketing_start?: string;
    marketing_end?: string;
    application_number?: string;
    finished?: boolean;
    dosage_form?: string;
    route?: string;
    strength?: string;
    product_type?: string;
    product_ndc?: string;
    source?: string; // Track which source: "DailyMed", "FDA (SPL)", "FDA (RxCUI)", "RxNorm", "none"
    spl_set_id?: string; // SPL Set ID if available
  } | null;
};

type GroupedNDCs = {
  [manufacturer: string]: {
    brand_name?: string;
    active: Array<{
      ndc: string;
      package: string;
      start?: string;
      end?: string;
      application_number?: string;
      strength?: string;
      count?: string;
      source?: string; // Track source: "DailyMed", "FDA (SPL)", "FDA (RxCUI)", "RxNorm"
      product_type?: string;
      route?: string;
      dosage_form?: string;
      product_ndc?: string;
      spl_set_id?: string;
    }>;
    inactive: Array<{
      ndc: string;
      package: string;
      start?: string;
      end?: string;
      application_number?: string;
      source?: string; // Track source: "DailyMed", "FDA (SPL)", "FDA (RxCUI)", "RxNorm"
      product_type?: string;
      route?: string;
      dosage_form?: string;
      product_ndc?: string;
      spl_set_id?: string;
    }>;
  };
};

type FinalResultComponent = {
  input: string;
  normalized: string;
  rxcui: string | null;
  rxnorm_name: string | null;
  tty: string | null;
  brand: string | null;
  assurity_score: number;
  match_status: string;
  ndcs: GroupedNDCs;
  llm_confidence?: number;
  final_confidence?: number;
};

type FinalResult = {
  scd: FinalResultComponent | null; // Semantic Clinical Drug (generic)
  sbd: FinalResultComponent | null; // Semantic Branded Drug (branded)
};

export default function TestMed2Page() {
  const [med, setMed] = useState("");
  const [loading, setLoading] = useState(false);
  const [step, setStep] = useState<string>("");
  const [normalizedData, setNormalizedData] = useState<NormalizedData | null>(null);
  const [candidates, setCandidates] = useState<RxCuiCandidate[]>([]);
  const [verificationResults, setVerificationResults] = useState<Record<string, VerificationResult>>({});
  const [ndcResults, setNdcResults] = useState<Record<string, NDCInfo[]>>({});
  const [finalResult, setFinalResult] = useState<FinalResult | null>(null);
  const [llmComparison, setLlmComparison] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);
  const [dailyMedData, setDailyMedData] = useState<Record<string, any>>({}); // Store DailyMed raw data by RxCUI
  const [fdaSplData, setFdaSplData] = useState<Record<string, any>>({}); // Store FDA SPL Set ID search data by RxCUI

  // Step 1: Enhanced LLM Normalization (returns both canonical and decomposed structure)
  const step1Normalize = useCallback(async (input: string): Promise<NormalizedData> => {
    setStep("Step 1: LLM Normalization...");
    try {
      const prompt = medicationNormalizationPrompt(input);
      const { parsed } = await callOpenAIRaw("gpt-4o", prompt);
      const result = parsed as any;
      
      return {
        ingredient: result.ingredient || "",
        strength: result.strength || null,
        form: result.form || null,
        brand: result.brand || null,
        route: result.route || null,
        package_quantity: result.package_quantity || null,
        normalized: result.normalized || input,
      };
    } catch (e) {
      throw new Error(`Normalization failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  // Canonicalization Layer - Normalize medication tokens to RxNorm naming patterns
  const canonicalizeMedicationName = useCallback((name: string): string => {
    let canonical = name.toUpperCase();
    
    // Canonical mapping for RxNorm naming patterns
    const canonicalMap: Record<string, string> = {
      'ACTUATE': 'ACTUAT',
      'ACTUATION': 'ACTUAT',
      'ACTUATIONS': 'ACTUAT',
      'GRAM': 'GM',
      'GRAMS': 'GM',
      'MILLIGRAM': 'MG',
      'MILLIGRAMS': 'MG',
      'MICROGRAM': 'MCG',
      'MICROGRAMS': 'MCG',
      'INHALATION': 'INHAL',
      'SPRAY': 'AEROSOL',
      'SPRAYS': 'AEROSOL',
      'POWDER FOR ORAL SUSPENSION': 'POWDER FOR SUSPENSION',
      'ORAL POWDER FOR SUSPENSION': 'POWDER FOR SUSPENSION',
      'CAPSULE': 'CAP',
      'CAPSULES': 'CAP',
      'TABLET': 'TAB',
      'TABLETS': 'TAB',
      'SUSPENSION': 'SUSP',
      'SOLUTION': 'SOL',
      'LIQUID': 'SOL',
    };
    
    // Apply canonical mappings (whole word replacement)
    for (const [key, value] of Object.entries(canonicalMap)) {
      // Use word boundaries to match whole words only
      const regex = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      canonical = canonical.replace(regex, value);
    }
    
    return canonical;
  }, []);

  // Calculate Levenshtein distance between two strings
  const levenshteinDistance = useCallback((str1: string, str2: string): number => {
    const len1 = str1.length;
    const len2 = str2.length;
    const matrix: number[][] = [];
    
    for (let i = 0; i <= len1; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= len2; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= len1; i++) {
      for (let j = 1; j <= len2; j++) {
        const cost = str1[i - 1].toLowerCase() === str2[j - 1].toLowerCase() ? 0 : 1;
        matrix[i][j] = Math.min(
          matrix[i - 1][j] + 1,      // deletion
          matrix[i][j - 1] + 1,      // insertion
          matrix[i - 1][j - 1] + cost // substitution
        );
      }
    }
    
    return matrix[len1][len2];
  }, []);

  // Calculate string similarity score (0-100, higher is better)
  const calculateStringSimilarity = useCallback((str1: string, str2: string): number => {
    const normalized1 = str1.toLowerCase().trim();
    const normalized2 = str2.toLowerCase().trim();
    
    if (normalized1 === normalized2) return 100;
    
    const maxLen = Math.max(normalized1.length, normalized2.length);
    if (maxLen === 0) return 100;
    
    const distance = levenshteinDistance(normalized1, normalized2);
    const similarity = ((maxLen - distance) / maxLen) * 100;
    
    return Math.max(0, Math.min(100, similarity));
  }, [levenshteinDistance]);

  // Step 2: Enhanced Tiered RxNorm Query with Canonicalization and Related Expansion
  const step2FetchCandidates = useCallback(async (
    normalized: string,
    normalizedData: NormalizedData
  ): Promise<RxCuiCandidate[]> => {
    setStep("Step 2: Tiered RxNorm Query (Exact → Approximate → Synonym Expansion)...");
    const candidates: RxCuiCandidate[] = [];
    const seenRxCuis = new Set<string>();
    
    try {
      // Tier 1: Exact match (first priority)
      setStep("Step 2.1: Exact match search...");
      const exactRes = await fetch(
        `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(normalized)}`
      );
      if (exactRes.ok) {
        const exactJson = await exactRes.json();
        const ids: string[] = exactJson?.idGroup?.rxnormId || [];
        for (const id of ids) {
          if (seenRxCuis.has(String(id))) continue;
          const props = await getRxcuiProps(String(id));
          if (props?.name) {
            candidates.push({
              rxcui: String(id),
              name: props.name,
              score: 100,
              source: "exact",
            });
            seenRxCuis.add(String(id));
          }
        }
      }

      // Tier 2: Approximate match (tokenized, maxEntries=20)
      setStep("Step 2.2: Approximate match search...");
      const approxRes = await fetch(
        `https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=${encodeURIComponent(normalized)}`
      );
      if (approxRes.ok) {
        const approxJson = await approxRes.json();
        const approxCandidates = approxJson?.approximateGroup?.candidate || [];
        for (const candidate of approxCandidates) {
          const rxcui = candidate?.rxcui ? String(candidate.rxcui) : null;
          const score = candidate?.score ? parseFloat(String(candidate.score)) : 0;
          const name = candidate?.name || "";
          
          if (rxcui && score > 0 && !seenRxCuis.has(rxcui)) {
            candidates.push({
              rxcui,
              name,
              score,
              source: "approximate",
            });
            seenRxCuis.add(rxcui);
          }
        }
      }

      // Step 2.4: TTY-Aware Re-ranking (post-scoring correction layer)
      if (candidates.length > 0 && candidates.some(c => c.source === "approximate")) {
        setStep("Step 2.4: TTY-aware re-ranking (brand vs generic)...");
        const approximateCandidates = candidates.filter(c => c.source === "approximate");
        const hasBrand = !!normalizedData.brand;
        
        for (const candidate of approximateCandidates) {
          try {
            const props = await getRxcuiProps(candidate.rxcui);
            if (props) {
              const tty = String(props.tty || "").toUpperCase();
              
              // TTY-based score adjustment using split scoring logic
              if (hasBrand) {
                // Brand scoring: Boost SBD, SBDF, SBDC; Demote SCD, DF, DFG
                if (["SBD", "SBDF", "SBDC"].includes(tty)) {
                  candidate.score *= 1.2;
                  console.log(`Boosted ${candidate.rxcui} (${tty}) by 20% for brand scoring: ${candidate.score.toFixed(2)}`);
                } else if (["SCD", "DF", "DFG"].includes(tty)) {
                  candidate.score *= 0.8;
                  console.log(`Demoted ${candidate.rxcui} (${tty}) by 20% for brand scoring: ${candidate.score.toFixed(2)}`);
                } else if (["MIN", "PIN"].includes(tty)) {
                  // Additional demotion for ingredient-level concepts
                  candidate.score *= 0.7;
                  console.log(`Demoted ${candidate.rxcui} (${tty}) by 30%: ${candidate.score.toFixed(2)}`);
                }
              } else {
                // Generic scoring: Boost SCD, SCDF, SCDC; Demote SBD, SBDF, SBDC, DF, DFG
                if (["SCD", "SCDF", "SCDC"].includes(tty)) {
                  candidate.score *= 1.2;
                  console.log(`Boosted ${candidate.rxcui} (${tty}) by 20% for generic scoring: ${candidate.score.toFixed(2)}`);
                } else if (["SBD", "SBDF", "SBDC", "DF", "DFG"].includes(tty)) {
                  candidate.score *= 0.8;
                  console.log(`Demoted ${candidate.rxcui} (${tty}) by 20% for generic scoring: ${candidate.score.toFixed(2)}`);
                } else if (["MIN", "PIN"].includes(tty)) {
                  // Additional demotion for ingredient-level concepts
                  candidate.score *= 0.7;
                  console.log(`Demoted ${candidate.rxcui} (${tty}) by 30%: ${candidate.score.toFixed(2)}`);
                }
              }
            }
          } catch (e) {
            console.warn(`Error fetching TTY for ${candidate.rxcui}:`, e);
          }
        }
        
        // Re-sort candidates after TTY weighting
        candidates.sort((a, b) => {
          // Keep exact matches at top
          if (a.source === "exact" && b.source !== "exact") return -1;
          if (b.source === "exact" && a.source !== "exact") return 1;
          // Sort by adjusted score
          return b.score - a.score;
        });
      }

      // Tier 3: Synonym expansion fallback (if both fail or insufficient results)
      if (candidates.length < 3) {
        setStep("Step 2.5: Synonym expansion fallback...");
        try {
          // Generate synonyms using LLM
          const synonymPrompt = medicationSynonymExpansionPrompt(normalizedData);
          const { parsed: synonymResult } = await callOpenAIRaw("gpt-4o", synonymPrompt);
          const variants: string[] = (synonymResult as any)?.variants || [];
          
          // Query each variant via approximateTerm (canonicalize first)
          for (const variant of variants.slice(0, 5)) {
            try {
              const canonicalVariant = canonicalizeMedicationName(variant);
              const variantRes = await fetch(
                `https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=${encodeURIComponent(canonicalVariant)}&maxEntries=5`
              );
              if (variantRes.ok) {
                const variantJson = await variantRes.json();
                const variantCandidates = variantJson?.approximateGroup?.candidate || [];
                for (const candidate of variantCandidates) {
                  const rxcui = candidate?.rxcui ? String(candidate.rxcui) : null;
                  const rxnormScore = candidate?.score ? parseFloat(String(candidate.score)) : 0;
                  const name = candidate?.name || "";
                  
                  if (rxcui && rxnormScore > 0 && !seenRxCuis.has(rxcui)) {
                    // Apply lexical re-scoring to synonym variants too
                    const stringSimilarity = calculateStringSimilarity(normalized, name);
                    const finalScore = (rxnormScore * 0.7 * 0.9) + (stringSimilarity * 0.3 * 0.9); // Reduced for variant
                    
                    candidates.push({
                      rxcui,
                      name,
                      score: finalScore,
                      source: "approximate",
                    });
                    seenRxCuis.add(rxcui);
                  }
                }
              }
            } catch (e) {
              console.warn(`Error querying variant "${variant}":`, e);
            }
          }
        } catch (e) {
          console.warn("Synonym expansion failed:", e);
        }
      }

      // Tier 4: Ingredient-only search (fallback if still no results)
      if (candidates.length === 0 && normalizedData.ingredient) {
        setStep("Step 2.6: Ingredient-only search fallback...");
        try {
          const ingredientRes = await fetch(
            `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(normalizedData.ingredient)}`
          );
          if (ingredientRes.ok) {
            const ingredientJson = await ingredientRes.json();
            const ids: string[] = ingredientJson?.idGroup?.rxnormId || [];
            for (const id of ids.slice(0, 3)) {
              if (seenRxCuis.has(String(id))) continue;
              const props = await getRxcuiProps(String(id));
              if (props?.name) {
                candidates.push({
                  rxcui: String(id),
                  name: props.name,
                  score: 60, // Lower score for ingredient-only match
                  source: "approximate",
                });
                seenRxCuis.add(String(id));
              }
            }
          }
        } catch (e) {
          console.warn("Ingredient-only search failed:", e);
        }
      }
    } catch (e) {
      console.error("Error fetching candidates:", e);
    }

    // Sort by score descending (after all expansions and re-scoring)
    return candidates.sort((a, b) => {
      // Keep exact matches at top
      if (a.source === "exact" && b.source !== "exact") return -1;
      if (b.source === "exact" && a.source !== "exact") return 1;
      // Sort by adjusted score
      return b.score - a.score;
    });
  }, [canonicalizeMedicationName, calculateStringSimilarity]);

  // Step 3: Enhanced Cross-verification with Improved Weighting and TTY Verification
  const step3Verify = useCallback(async (
    normalized: NormalizedData,
    candidates: RxCuiCandidate[]
  ): Promise<Record<string, VerificationResult>> => {
    setStep("Step 3: Enhanced cross-verification with weighted scoring and TTY verification...");
    const results: Record<string, VerificationResult> = {};
    
    // Determine expected TTY based on input (brand vs generic)
    const hasBrand = !!normalized.brand;
    const expectedTTY = hasBrand ? ["SBD", "SBDF", "SBDC"] : ["SCD", "SCDF", "SCDC"];
    
    // Helper functions for split scoring (brand vs generic)
    const calculateBrandAssurity = (
      ingredientMatch: number,
      strengthMatch: number,
      formMatch: number,
      routeMatch: number,
      brandMatch: number,
      rxnormScore: number
    ): number => {
      // Brand-oriented scoring: Brand(35%), Ingredient(30%), Form(15%), Strength(10%), Route(5%), RxNorm(5%)
      return (
        0.35 * brandMatch +
        0.30 * ingredientMatch +
        0.15 * formMatch +
        0.10 * strengthMatch +
        0.05 * routeMatch +
        0.05 * rxnormScore
      ) * 100;
    };
    
    const calculateGenericAssurity = (
      ingredientMatch: number,
      strengthMatch: number,
      formMatch: number,
      routeMatch: number,
      rxnormScore: number
    ): number => {
      // Generic-oriented scoring: Ingredient(40%), Strength(25%), Form(15%), Route(10%), RxNorm(10%)
      return (
        0.40 * ingredientMatch +
        0.25 * strengthMatch +
        0.15 * formMatch +
        0.10 * routeMatch +
        0.10 * rxnormScore
      ) * 100;
    };

    for (const candidate of candidates.slice(0, 5)) { // Top 5 candidates
      try {
        const props = await getRxcuiProps(candidate.rxcui);
        if (!props) continue;

        const rxName = String(props.name || "");
        const rxSynonym = String(props.synonym || "");
        const synonyms = rxSynonym ? rxSynonym.split("|").map(s => s.trim()).filter(Boolean) : [];
        const allNames = [rxName, ...synonyms].map(n => n.toLowerCase());
        const tty = String(props.tty || "");
        const suppress = String(props.suppress || "");
        const status = String(props.status || "");

        // Normalize strings for comparison
        const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
        
        // Extract strength with unit normalization support
        // Enhanced to capture more unit types
        const extractStrength = (s: string) => {
          // Match patterns like "1000 MG", "1 G", "500 MCG", "125 MG/5 ML", "100 IU", "2 ACTUATE", etc.
          // Try to match common medication units
          const patterns = [
            /(\d+(?:\.\d+)?)\s*(MG|MCG|UG|G|KG|ML|L|CL|DL|IU|MEQ|ACTUATE|PUFF|SPRAY|%|FL\s*OZ|TSP|TBSP|TABLESPOON|TEASPOON)\b/i,
            /(\d+(?:\.\d+)?)\s*(MG|MCG|G|ML)\s*\/\s*(\d+(?:\.\d+)?)\s*(MG|MCG|G|ML)\b/i, // Ratios
          ];
          
          for (const pattern of patterns) {
            const match = s.match(pattern);
            if (match) {
              if (match[3] && match[4]) {
                // Ratio format
                return `${match[1]} ${match[2].toUpperCase()}/${match[3]} ${match[4].toUpperCase()}`;
              }
              return `${match[1]} ${match[2].toUpperCase()}`;
            }
          }
          
          return null;
        };
        
        // Comprehensive unit conversion registry for medications
        const UNIT_CONVERSIONS: Record<string, {
          type: 'weight' | 'volume' | 'special' | 'percentage';
          toBase: (value: number) => number; // Convert to base unit (MG for weight, ML for volume)
          fromBase: (value: number) => number; // Convert from base unit
        }> = {
          // Weight units (base: MG)
          'KG': { type: 'weight', toBase: (v) => v * 1000000, fromBase: (v) => v / 1000000 }, // 1 KG = 1,000,000 MG
          'G': { type: 'weight', toBase: (v) => v * 1000, fromBase: (v) => v / 1000 }, // 1 G = 1000 MG
          'MG': { type: 'weight', toBase: (v) => v, fromBase: (v) => v }, // Base unit
          'MCG': { type: 'weight', toBase: (v) => v / 1000, fromBase: (v) => v * 1000 }, // 1 MCG = 0.001 MG
          'UG': { type: 'weight', toBase: (v) => v / 1000, fromBase: (v) => v * 1000 }, // UG = MCG
          'NG': { type: 'weight', toBase: (v) => v / 1000000, fromBase: (v) => v * 1000000 }, // 1 NG = 0.000001 MG
          'OZ': { type: 'weight', toBase: (v) => v * 28349.5, fromBase: (v) => v / 28349.5 }, // 1 OZ (weight) = 28.3495 G = 28349.5 MG
          'OUNCE': { type: 'weight', toBase: (v) => v * 28349.5, fromBase: (v) => v / 28349.5 }, // Weight ounce
          'LB': { type: 'weight', toBase: (v) => v * 453592, fromBase: (v) => v / 453592 }, // 1 LB = 453.592 G = 453592 MG
          
          // Volume units (base: ML)
          'L': { type: 'volume', toBase: (v) => v * 1000, fromBase: (v) => v / 1000 }, // 1 L = 1000 ML
          'LITER': { type: 'volume', toBase: (v) => v * 1000, fromBase: (v) => v / 1000 },
          'ML': { type: 'volume', toBase: (v) => v, fromBase: (v) => v }, // Base unit
          'CL': { type: 'volume', toBase: (v) => v * 10, fromBase: (v) => v / 10 }, // 1 CL = 10 ML
          'DL': { type: 'volume', toBase: (v) => v * 100, fromBase: (v) => v / 100 }, // 1 DL = 100 ML
          'FL OZ': { type: 'volume', toBase: (v) => v * 29.5735, fromBase: (v) => v / 29.5735 }, // 1 FL OZ = 29.5735 ML
          'FLUID OUNCE': { type: 'volume', toBase: (v) => v * 29.5735, fromBase: (v) => v / 29.5735 }, // Fluid ounce
          'FLUID OZ': { type: 'volume', toBase: (v) => v * 29.5735, fromBase: (v) => v / 29.5735 }, // Fluid oz
          'TSP': { type: 'volume', toBase: (v) => v * 4.92892, fromBase: (v) => v / 4.92892 }, // 1 TSP = 4.92892 ML
          'TBSP': { type: 'volume', toBase: (v) => v * 14.7868, fromBase: (v) => v / 14.7868 }, // 1 TBSP = 14.7868 ML
          'TABLESPOON': { type: 'volume', toBase: (v) => v * 14.7868, fromBase: (v) => v / 14.7868 },
          'TEASPOON': { type: 'volume', toBase: (v) => v * 4.92892, fromBase: (v) => v / 4.92892 },
          'DROPS': { type: 'volume', toBase: (v) => v * 0.05, fromBase: (v) => v / 0.05 }, // 1 drop ≈ 0.05 ML
          'GTTS': { type: 'volume', toBase: (v) => v * 0.05, fromBase: (v) => v / 0.05 }, // gtts = drops
          
          // Special units (cannot convert, must match exactly)
          'IU': { type: 'special', toBase: (v) => v, fromBase: (v) => v }, // International Units
          'UNITS': { type: 'special', toBase: (v) => v, fromBase: (v) => v }, // Units (insulin, etc.)
          'UNIT': { type: 'special', toBase: (v) => v, fromBase: (v) => v },
          'MEQ': { type: 'special', toBase: (v) => v, fromBase: (v) => v }, // Milliequivalents
          'MEQL': { type: 'special', toBase: (v) => v, fromBase: (v) => v }, // Milliequivalents per liter
          'MMOL': { type: 'special', toBase: (v) => v, fromBase: (v) => v }, // Millimoles
          'MMOL/L': { type: 'special', toBase: (v) => v, fromBase: (v) => v },
          'MG/KG': { type: 'special', toBase: (v) => v, fromBase: (v) => v }, // Per kilogram (dosage)
          'MCG/KG': { type: 'special', toBase: (v) => v, fromBase: (v) => v },
          'MG/M2': { type: 'special', toBase: (v) => v, fromBase: (v) => v }, // Per square meter
          'ACTUATE': { type: 'special', toBase: (v) => v, fromBase: (v) => v }, // Actuations (inhalers)
          'PUFF': { type: 'special', toBase: (v) => v, fromBase: (v) => v }, // Puffs (inhalers)
          'SPRAY': { type: 'special', toBase: (v) => v, fromBase: (v) => v }, // Sprays (nasal)
          
          // Percentage
          '%': { type: 'percentage', toBase: (v) => v, fromBase: (v) => v },
          'PERCENT': { type: 'percentage', toBase: (v) => v, fromBase: (v) => v },
        };
        
        // Normalize unit name (handle variations like "FL OZ", "FL.OZ", "FL_OZ", etc.)
        const normalizeUnitName = (unit: string): string => {
          const normalized = unit.toUpperCase().trim()
            .replace(/[._-]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          
          // Handle common variations
          const variations: Record<string, string> = {
            'FLOZ': 'FL OZ',
            'FL OZ': 'FL OZ',
            'FLUID OUNCE': 'FL OZ',
            'FLUID OZ': 'FL OZ',
            'TSP': 'TSP',
            'TSPN': 'TSP',
            'TEASPOON': 'TSP',
            'TBSP': 'TBSP',
            'TABLESPOON': 'TBSP',
            'MCG': 'MCG',
            'UG': 'MCG',
            'MICROGRAM': 'MCG',
            'MG': 'MG',
            'MILLIGRAM': 'MG',
            'G': 'G',
            'GRAM': 'G',
            'KG': 'KG',
            'KILOGRAM': 'KG',
            'ML': 'ML',
            'MILLILITER': 'ML',
            'MILLILITRE': 'ML',
            'L': 'L',
            'LITER': 'L',
            'LITRE': 'L',
            'IU': 'IU',
            'UNITS': 'UNITS',
            'UNIT': 'UNITS',
            'MEQ': 'MEQ',
            'MEQL': 'MEQ',
            'ACTUATE': 'ACTUATE',
            'ACTUATION': 'ACTUATE',
            'PUFF': 'PUFF',
            'PUFFS': 'PUFF',
            'SPRAY': 'SPRAY',
            'SPRAYS': 'SPRAY',
          };
          
          return variations[normalized] || normalized;
        };
        
        // Normalize strength to base units for comparison
        // Converts: all weight to MG, all volume to ML, special units stay as-is
        const normalizeStrengthToBaseUnit = (strength: string): { 
          value: number; 
          unit: string; 
          normalizedUnit: string;
          valueInBase: number;
          unitType: 'weight' | 'volume' | 'special' | 'percentage';
        } | null => {
          if (!strength) return null;
          
          // Enhanced regex to capture more unit patterns
          // Matches: "1000 MG", "1 G", "500 MCG", "125 MG/5 ML", "100 IU", "2 ACTUATE", etc.
          const match = strength.match(/(\d+(?:\.\d+)?)\s*([A-Z%\/\s]+?)(?:\s|$|\/|,|;)/i);
          if (!match) {
            // Try simpler pattern
            const simpleMatch = strength.match(/(\d+(?:\.\d+)?)\s*(MG|MCG|UG|G|KG|ML|L|IU|MEQ|ACTUATE|PUFF|SPRAY|%)\b/i);
            if (!simpleMatch) return null;
            const value = parseFloat(simpleMatch[1]);
            const unit = normalizeUnitName(simpleMatch[2]);
            const conversion = UNIT_CONVERSIONS[unit];
            if (!conversion) return { value, unit, normalizedUnit: unit, valueInBase: value, unitType: 'special' };
            
            return {
              value,
              unit: simpleMatch[2].toUpperCase(),
              normalizedUnit: unit,
              valueInBase: conversion.toBase(value),
              unitType: conversion.type,
            };
          }
          
          const value = parseFloat(match[1]);
          const rawUnit = match[2].trim();
          const unit = normalizeUnitName(rawUnit);
          
          const conversion = UNIT_CONVERSIONS[unit];
          if (!conversion) {
            // Unknown unit, return as-is
            return { value, unit: rawUnit.toUpperCase(), normalizedUnit: unit, valueInBase: value, unitType: 'special' };
          }
          
          return {
            value,
            unit: rawUnit.toUpperCase(),
            normalizedUnit: unit,
            valueInBase: conversion.toBase(value),
            unitType: conversion.type,
          };
        };
        
        // Compare strengths with unit normalization
        const compareStrengths = (strength1: string | null, strength2: string | null): number => {
          if (!strength1 || !strength2) {
            if (!strength1 && !strength2) return 1; // Both missing = match
            return 0; // One missing, one present = no match
          }
          
          // Handle ratios like "125 MG/5 ML", "250 MG/5 ML", etc.
          if (strength1.includes('/') || strength2.includes('/')) {
            // For ratios, do exact string comparison (after normalization)
            const normalized1 = strength1.replace(/\s+/g, ' ').trim().toUpperCase();
            const normalized2 = strength2.replace(/\s+/g, ' ').trim().toUpperCase();
            if (normalized1 === normalized2) return 1;
            
            // Try to parse and compare ratios using comprehensive unit conversion
            // Match patterns like "125 MG/5 ML", "250 MG/10 ML", etc.
            const ratioPattern = /(\d+(?:\.\d+)?)\s*([A-Z%\/\s]+?)\s*\/\s*(\d+(?:\.\d+)?)\s*([A-Z%\/\s]+?)(?:\s|$|,|;)/i;
            const ratio1Match = strength1.match(ratioPattern);
            const ratio2Match = strength2.match(ratioPattern);
            
            if (ratio1Match && ratio2Match) {
              const num1 = parseFloat(ratio1Match[1]);
              const unit1Raw = ratio1Match[2].trim();
              const den1 = parseFloat(ratio1Match[3]);
              const unit1DenRaw = ratio1Match[4].trim();
              
              const num2 = parseFloat(ratio2Match[1]);
              const unit2Raw = ratio2Match[2].trim();
              const den2 = parseFloat(ratio2Match[3]);
              const unit2DenRaw = ratio2Match[4].trim();
              
              // Normalize unit names
              const unit1 = normalizeUnitName(unit1Raw);
              const unit1Den = normalizeUnitName(unit1DenRaw);
              const unit2 = normalizeUnitName(unit2Raw);
              const unit2Den = normalizeUnitName(unit2DenRaw);
              
              // Get conversion functions
              const conv1 = UNIT_CONVERSIONS[unit1];
              const conv1Den = UNIT_CONVERSIONS[unit1Den];
              const conv2 = UNIT_CONVERSIONS[unit2];
              const conv2Den = UNIT_CONVERSIONS[unit2Den];
              
              // Both numerator and denominator must have compatible units
              if (conv1 && conv2 && conv1Den && conv2Den) {
                // Numerators must be same type (both weight or both volume)
                // Denominators must be same type (both weight or both volume)
                if (conv1.type === conv2.type && conv1Den.type === conv2Den.type) {
                  // Convert to base units
                  const num1Base = conv1.toBase(num1);
                  const num2Base = conv2.toBase(num2);
                  const den1Base = conv1Den.toBase(den1);
                  const den2Base = conv2Den.toBase(den2);
                  
                  // Compare ratios
                  const ratio1Value = num1Base / den1Base;
                  const ratio2Value = num2Base / den2Base;
                  
                  const tolerance = 0.001;
                  if (Math.abs(ratio1Value - ratio2Value) < tolerance) {
                    return 1; // Exact match
                  }
                  
                  const maxRatio = Math.max(Math.abs(ratio1Value), Math.abs(ratio2Value), 0.0001);
                  const deviation = Math.abs(ratio1Value - ratio2Value) / maxRatio;
                  
                  if (deviation < 0.01) return 1; // Very close (within 1%)
                  if (deviation < 0.1) return 0.5; // Within 10%
                  if (deviation < 0.2) return 0.3; // Within 20%
                }
              }
              
              return 0;
            }
            
            return 0;
          }
          
          // Normalize both strengths to base units
          const norm1 = normalizeStrengthToBaseUnit(strength1);
          const norm2 = normalizeStrengthToBaseUnit(strength2);
          
          if (!norm1 || !norm2) {
            // Fallback to exact string comparison
            return strength1.toUpperCase() === strength2.toUpperCase() ? 1 : 0;
          }
          
          // Get normalized values (already converted to base units)
          const value1InBase = norm1.valueInBase;
          const value2InBase = norm2.valueInBase;
          
          // Handle special units - must match exactly (same unit type and value)
          if (norm1.unitType === 'special' || norm2.unitType === 'special') {
            // For special units, compare exact unit names and values
            if (norm1.unitType === 'special' && norm2.unitType === 'special') {
              // Both are special units - must be same unit type
              if (norm1.normalizedUnit === norm2.normalizedUnit) {
                const tolerance = 0.001;
                if (Math.abs(value1InBase - value2InBase) < tolerance) {
                  return 1; // Exact match
                }
                // Allow small deviation for special units
                const deviation = Math.abs(value1InBase - value2InBase) / Math.max(Math.abs(value1InBase), Math.abs(value2InBase), 0.0001);
                if (deviation < 0.01) return 1;
                if (deviation < 0.1) return 0.5;
              }
              return 0; // Different special unit types
            }
            // One is special, one is not - no match
            return 0;
          }
          
          // Only compare if units are compatible (both weight, both volume, or both percentage)
          if (norm1.unitType !== norm2.unitType) {
            return 0; // Incompatible units (weight vs volume, etc.)
          }
          
          // Compare normalized values with tolerance for floating point errors
          const tolerance = 0.001;
          if (Math.abs(value1InBase - value2InBase) < tolerance) {
            return 1; // Exact match (e.g., 1000 MG = 1 G, 1000 MCG = 1 MG, 1 L = 1000 ML)
          }
          
          // Check for close match (small differences due to rounding)
          const maxValue = Math.max(Math.abs(value1InBase), Math.abs(value2InBase), 0.0001);
          const deviation = Math.abs(value1InBase - value2InBase) / maxValue;
          
          if (deviation < 0.01) {
            return 1; // Very close (within 1% - likely same value with rounding)
          } else if (deviation < 0.1) {
            return 0.5; // Within 10%
          } else if (deviation < 0.2) {
            return 0.3; // Within 20%
          }
          
          return 0; // No match
        };
        const extractIngredient = (s: string) => {
          const normalized = normalize(s);
          const parts = normalized.split(/\d/);
          return parts[0]?.trim() || "";
        };
        const extractForm = (s: string) => {
          const normalized = normalize(s);
          const forms = ["tablet", "capsule", "solution", "suspension", "cream", "ointment", "injection", "spray", "patch", "gel", "lotion", "foam"];
          for (const form of forms) {
            if (normalized.includes(form)) return form;
          }
          return null;
        };
        const extractBrand = (s: string) => {
          const match = s.match(/\[([^\]]+)\]/);
          return match ? match[1].toLowerCase() : null;
        };
        const extractRoute = (s: string) => {
          const normalized = normalize(s);
          const routes = ["oral", "topical", "injection", "intravenous", "intramuscular", "subcutaneous", "rectal", "vaginal", "ophthalmic", "otic", "nasal", "inhalation"];
          for (const route of routes) {
            if (normalized.includes(route)) return route;
          }
          return null;
        };

        // Fetch route from related.json if available
        let rxRoute: string | null = null;
        try {
          const relatedRes = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${candidate.rxcui}/related.json?tty=DF`);
          if (relatedRes.ok) {
            const relatedJson = await relatedRes.json();
            const conceptGroups = relatedJson?.relatedGroup?.conceptGroup || [];
            for (const group of conceptGroups) {
              if (group?.tty === "DF" && group?.conceptProperties?.[0]?.name) {
                rxRoute = extractRoute(String(group.conceptProperties[0].name));
                break;
              }
            }
          }
        } catch (e) {
          // Route fetch failed, use extracted route from name
          rxRoute = extractRoute(rxName);
        }
        if (!rxRoute) {
          rxRoute = extractRoute(rxName);
        }

        // Enhanced Ingredient match (40% weight) - with synonym equivalence
        const inputIngredient = normalize(normalized.ingredient);
        const rxIngredient = extractIngredient(rxName);
        let ingredientMatch = 0;
        if (inputIngredient === rxIngredient) {
          ingredientMatch = 1;
        } else if (allNames.some(n => extractIngredient(n) === inputIngredient)) {
          ingredientMatch = 0.5; // Partial match via synonym
        } else {
          // Fuzzy match: check if ingredient is contained in synonym or vice versa
          const fuzzyMatch = allNames.some(n => {
            const ing = extractIngredient(n);
            return ing && (ing.includes(inputIngredient) || inputIngredient.includes(ing));
          });
          if (fuzzyMatch) {
            ingredientMatch = 0.3; // Weak fuzzy match
          }
        }

        // Enhanced Strength match (20% weight) - with unit normalization
        let strengthMatch = 0;
        if (normalized.strength) {
          const inputStrength = normalized.strength;
          const rxStrength = extractStrength(rxName);
          
          // Use normalized comparison function
          strengthMatch = compareStrengths(inputStrength, rxStrength);
          
          // If no match found, check if both are missing
          if (strengthMatch === 0 && !inputStrength && !rxStrength) {
            strengthMatch = 1; // Both missing strength
          }
        } else {
          strengthMatch = 1; // Input has no strength requirement
        }

        // Enhanced Form match (15% weight) - with LLM token mapping for equivalents
        let formMatch = 0;
        if (normalized.form) {
          const inputForm = extractForm(normalized.form.toLowerCase());
          const rxForm = extractForm(rxName);
          if (inputForm && rxForm) {
            if (inputForm === rxForm) {
              formMatch = 1;
            } else {
              // Check for equivalent forms with expanded mapping
              const equivalents: Record<string, string[]> = {
                tablet: ["tablet", "tab", "oral tablet"],
                capsule: ["capsule", "cap", "oral capsule"],
                suspension: ["suspension", "susp", "oral suspension"],
                solution: ["solution", "sol", "oral solution"],
                cream: ["cream", "topical cream"],
                ointment: ["ointment", "topical ointment"],
                gel: ["gel", "topical gel"],
                lotion: ["lotion", "topical lotion"],
                injection: ["injection", "injectable", "inject"],
                spray: ["spray", "nasal spray", "oral spray"],
                patch: ["patch", "transdermal patch"],
              };
              const inputEquiv = equivalents[inputForm] || [inputForm];
              const rxEquiv = equivalents[rxForm] || [rxForm];
              if (inputEquiv.some(i => rxEquiv.includes(i))) {
                formMatch = 0.5;
              }
            }
          }
        } else {
          formMatch = 1; // Input has no form requirement
        }

        // Enhanced Route match (10% weight)
        let routeMatch = 0;
        if (normalized.route) {
          const inputRoute = normalize(normalized.route);
          if (rxRoute && inputRoute === rxRoute) {
            routeMatch = 1;
          } else if (rxRoute && inputRoute.includes(rxRoute) || (rxRoute && rxRoute.includes(inputRoute))) {
            routeMatch = 0.5; // Partial route match
          }
        } else {
          routeMatch = 1; // Input has no route requirement
        }

        // Brand match (10% weight) - exact match case-insensitive
        let brandMatch = 0;
        if (normalized.brand) {
          const inputBrand = normalize(normalized.brand);
          const rxBrand = extractBrand(rxName);
          if (rxBrand && inputBrand === rxBrand) {
            brandMatch = 1;
          } else {
            // Check synonyms for brand
            const brandInSynonyms = allNames.some(n => {
              const brand = extractBrand(n);
              return brand && brand === inputBrand;
            });
            if (brandInSynonyms) {
              brandMatch = 0.5;
            }
          }
        } else {
          brandMatch = 1; // No brand specified
        }

        // RxNorm score (5% weight) - use RxNorm's own approximateTerm score
        const rxnormScore = candidate.score || 0;
        const rxnormScoreNormalized = Math.min(rxnormScore / 100, 1); // Normalize to 0-1

        // Active concept bonus (+5% if suppress = N and status = ACTIVE)
        const isActive = suppress === "N" && (status === "ACTIVE" || status === "");
        const activeBonus = isActive ? 0.05 : 0;

        // Calculate assurity using split scoring pipelines
        let baseAssurity: number;
        const scoringModel = hasBrand ? "brand" : "generic";
        
        if (scoringModel === "brand") {
          // Brand-oriented scoring: Brand(35%), Ingredient(30%), Form(15%), Strength(10%), Route(5%), RxNorm(5%)
          baseAssurity = (
            0.35 * brandMatch +
            0.30 * ingredientMatch +
            0.15 * formMatch +
            0.10 * strengthMatch +
            0.05 * routeMatch +
            0.05 * rxnormScoreNormalized
          ) * 100;
        } else {
          // Generic-oriented scoring: Ingredient(40%), Strength(25%), Form(15%), Route(10%), RxNorm(10%)
          baseAssurity = (
            0.40 * ingredientMatch +
            0.25 * strengthMatch +
            0.15 * formMatch +
            0.10 * routeMatch +
            0.10 * rxnormScoreNormalized
          ) * 100;
        }
        
        // Apply TTY-based boost/demote based on scoring model
        let ttyMultiplier = 1.0;
        if (scoringModel === "brand") {
          // Boost SBD, SBDF, SBDC candidates
          if (["SBD", "SBDF", "SBDC"].includes(tty)) {
            ttyMultiplier = 1.2;
            console.log(`Boosted ${candidate.rxcui} (${tty}) by 20% for brand scoring`);
          }
          // Demote SCD, DF, DFG candidates
          else if (["SCD", "DF", "DFG"].includes(tty)) {
            ttyMultiplier = 0.8;
            console.log(`Demoted ${candidate.rxcui} (${tty}) by 20% for brand scoring`);
          }
        } else {
          // Boost SCD, SCDF, SCDC candidates
          if (["SCD", "SCDF", "SCDC"].includes(tty)) {
            ttyMultiplier = 1.2;
            console.log(`Boosted ${candidate.rxcui} (${tty}) by 20% for generic scoring`);
          }
          // Demote SBD, SBDF, SBDC, DF, DFG candidates
          else if (["SBD", "SBDF", "SBDC", "DF", "DFG"].includes(tty)) {
            ttyMultiplier = 0.8;
            console.log(`Demoted ${candidate.rxcui} (${tty}) by 20% for generic scoring`);
          }
        }
        
        // Apply TTY multiplier and active bonus
        const assurity = Math.min((baseAssurity * ttyMultiplier) + (activeBonus * 100), 100);
        
        // Bonus Improvement: Promote candidates with high assurity regardless of raw score
        // This helps when a candidate has perfect ingredient+form+brand match but low RxNorm score
        if (assurity >= 90) {
          // Store original score for logging
          const originalScore = candidate.score;
          // Promote to at least 95, or use assurity score if it's a meaningful boost
          const promotedScore = Math.max(candidate.score, Math.min(95, assurity));
          candidate.score = promotedScore;
          console.log(`Promoted ${candidate.rxcui} from ${originalScore.toFixed(1)} to ${promotedScore.toFixed(1)} due to high assurity (${assurity.toFixed(1)}%)`);
        }

        results[candidate.rxcui] = {
          ingredientMatch,
          strengthMatch,
          formMatch,
          brandMatch,
          routeMatch,
          rxnormScore: rxnormScore,
          isActive,
          assurity,
          details: {
            ingredient: rxName,
            strength: extractStrength(rxName) || "N/A",
            form: extractForm(rxName) || "N/A",
            brand: extractBrand(rxName) || "N/A",
            route: rxRoute || "N/A",
            tty: tty || "N/A",
            suppress: suppress || "N/A",
            status: status || "N/A",
          },
        };
      } catch (e) {
        console.error(`Error verifying candidate ${candidate.rxcui}:`, e);
      }
    }

    // TTY Verification Layer: If top candidate doesn't match expected TTY, try to find related one
    if (Object.keys(results).length > 0) {
      setStep("Step 3.5: TTY verification layer...");
      const sortedCandidates = candidates
        .map(c => ({ candidate: c, verification: results[c.rxcui] }))
        .filter(v => v.verification)
        .sort((a, b) => (b.verification?.assurity || 0) - (a.verification?.assurity || 0));
      
      if (sortedCandidates.length > 0) {
        const topCandidate = sortedCandidates[0];
        const topTTY = topCandidate.verification.details.tty.toUpperCase();
        
        // Check if top candidate matches expected TTY
        const matchesExpectedTTY = expectedTTY.some(t => topTTY === t);
        
        if (!matchesExpectedTTY && topCandidate.verification.assurity >= 70) {
          // Try to find related candidate with correct TTY
          try {
            const relatedRes = await fetch(
              `https://rxnav.nlm.nih.gov/REST/rxcui/${topCandidate.candidate.rxcui}/related.json?tty=${expectedTTY.join("+")}`
            );
            if (relatedRes.ok) {
              const relatedJson = await relatedRes.json();
              const conceptGroups = relatedJson?.relatedGroup?.conceptGroup || [];
              
              for (const group of conceptGroups) {
                const groupTTY = group?.tty?.toUpperCase();
                if (expectedTTY.includes(groupTTY)) {
                  const concepts = group?.conceptProperties || [];
                  if (concepts.length > 0) {
                    const relatedRxcui = String(concepts[0]?.rxcui || "");
                    if (relatedRxcui && !results[relatedRxcui]) {
                      // Verify the related candidate
                      const relatedCandidate: RxCuiCandidate = {
                        rxcui: relatedRxcui,
                        name: String(concepts[0]?.name || ""),
                        score: topCandidate.candidate.score * 0.95, // Slightly lower than original
                        source: "approximate",
                      };
                      // Verify the related candidate inline (avoid recursion)
                      try {
                        const relatedProps = await getRxcuiProps(relatedRxcui);
                        if (relatedProps) {
                          const relatedRxName = String(relatedProps.name || "");
                          const relatedTty = String(relatedProps.tty || "").toUpperCase();
                          
                          // Quick verification: check if name similarity is good
                          const nameSimilarity = calculateStringSimilarity(normalized.normalized, relatedRxName);
                          
                          // If similarity is high enough, add it to results with calculated assurity
                          if (nameSimilarity >= 70) {
                            // Use a simplified assurity calculation for TTY-matched candidates
                            const ttyMatchedAssurity = Math.min(
                              topCandidate.verification.assurity * 0.95 + 10, // Slight boost for TTY match
                              100
                            );
                            
                            // Create a verification result for the TTY-matched candidate
                            results[relatedRxcui] = {
                              ...topCandidate.verification,
                              assurity: ttyMatchedAssurity,
                              details: {
                                ...topCandidate.verification.details,
                                ingredient: relatedRxName,
                                tty: relatedTty,
                              },
                            };
                            
                            console.log(`TTY verification: Found TTY-matched candidate ${relatedRxcui} (${groupTTY}) for expected TTY ${expectedTTY.join("/")} with assurity ${ttyMatchedAssurity.toFixed(1)}%`);
                          }
                        }
                      } catch (e) {
                        console.warn(`Error verifying TTY-matched candidate ${relatedRxcui}:`, e);
                      }
                    }
                  }
                  break;
                }
              }
            }
          } catch (e) {
            console.warn(`TTY verification failed for ${topCandidate.candidate.rxcui}:`, e);
          }
        }
      }
    }

    return results;
  }, [calculateStringSimilarity]);

  // Step 4: Semantic Verification (LLM Entailment Check)
  const step4SemanticVerification = useCallback(async (
    input: string,
    topCandidates: Array<{ rxcui: string; name: string; verification: VerificationResult }>
  ): Promise<Record<string, VerificationResult>> => {
    setStep("Step 4: Semantic verification with LLM entailment check...");
    const updatedResults: Record<string, VerificationResult> = {};

    for (const candidate of topCandidates.slice(0, 3)) { // Top 3 candidates for semantic check
      try {
        const props = await getRxcuiProps(candidate.rxcui);
        if (!props) continue;

        const rxnormName = String(props.name || "");
        
        // Run LLM entailment check
        const entailmentPrompt = medicationEntailmentPrompt(input, rxnormName);
        const { parsed: entailmentResult } = await callOpenAIRaw("gpt-4o", entailmentPrompt);
        const entailment = entailmentResult as any;

        // Update verification result with semantic entailment
        updatedResults[candidate.rxcui] = {
          ...candidate.verification,
          semanticEntailment: {
            entails: entailment.entails || false,
            confidence: entailment.confidence || 0,
            reasoning: entailment.reasoning || "",
          },
        };

        // If semantic entailment confidence is high, boost assurity slightly
        if (entailment.entails && entailment.confidence >= 90) {
          updatedResults[candidate.rxcui].assurity = Math.min(
            100,
            updatedResults[candidate.rxcui].assurity + 3
          );
        } else if (!entailment.entails || entailment.confidence < 50) {
          // Penalize if entailment fails or low confidence
          updatedResults[candidate.rxcui].assurity = Math.max(
            0,
            updatedResults[candidate.rxcui].assurity - 5
          );
        }
      } catch (e) {
        console.warn(`Semantic verification failed for ${candidate.rxcui}:`, e);
        updatedResults[candidate.rxcui] = candidate.verification;
      }
    }

    return updatedResults;
  }, []);

  // Step 5: Cross-Verification with OpenFDA
  const step5CrossVerifyFDA = useCallback(async (
    rxcui: string,
    brand: string | null
  ): Promise<{ fdaLinked: boolean; fdaMappingPending: boolean }> => {
    setStep("Step 5: Cross-verification with OpenFDA...");
    
    try {
      // Check if RxCUI is linked in FDA database
      const fdaRes = await fetch(
        `https://api.fda.gov/drug/ndc.json?search=openfda.rxcui="${rxcui}"&limit=1`
      );
      
      if (fdaRes.ok) {
        const fdaJson = await fdaRes.json();
        const resultCount = fdaJson?.meta?.results?.total || 0;
        
        if (resultCount > 0) {
          return { fdaLinked: true, fdaMappingPending: false };
        }
      }

      // Fallback: brand-name search if RxCUI search fails
      if (brand) {
        try {
          const brandRes = await fetch(
            `https://api.fda.gov/drug/ndc.json?search=brand_name="${encodeURIComponent(brand)}"&limit=1`
          );
          
          if (brandRes.ok) {
            const brandJson = await brandRes.json();
            const brandResultCount = brandJson?.meta?.results?.total || 0;
            
            if (brandResultCount > 0) {
              return { fdaLinked: false, fdaMappingPending: true };
            }
          }
        } catch (e) {
          console.warn("FDA brand search failed:", e);
        }
      }

      return { fdaLinked: false, fdaMappingPending: false };
    } catch (e) {
      console.warn("FDA cross-verification failed:", e);
      return { fdaLinked: false, fdaMappingPending: false };
    }
  }, []);

  // Step 6: Fetch and verify NDCs (SPL_SET_ID → DailyMed → openFDA → RxNorm chain)
  const step4FetchNDCs = useCallback(async (rxcui: string): Promise<{ ndcs: NDCInfo[]; dailyMedRaw?: any; fdaSplRaw?: any }> => {
    setStep("Step 4: Fetching and verifying NDCs using SPL_SET_ID from DailyMed, openFDA, and RxNorm...");
    const ndcMap = new Map<string, { info: any; source: string; spl_set_id?: string }>(); // Track NDC with source priority and SPL_SET_ID
    const results: NDCInfo[] = [];

    // Step 0: Identify SPL_SET_ID from RxNorm properties
    let splSetId: string | null = null;
    try {
      const propsRes = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/properties.json`);
      if (propsRes.ok) {
        const propsJson = await propsRes.json();
        console.log("RxNorm properties JSON for RxCUI", rxcui, ":", JSON.stringify(propsJson, null, 2));
        const properties = propsJson?.properties || {};
        
        // Check for SPL_SET_ID in properties
        // RxNorm may return it as a property with propName="SPL_SET_ID"
        if (properties.SPL_SET_ID) {
          splSetId = properties.SPL_SET_ID;
          console.log("Found SPL_SET_ID from properties.SPL_SET_ID:", splSetId);
        } else if (propsJson?.properties?.propName === "SPL_SET_ID") {
          splSetId = propsJson.properties.propValue;
          console.log("Found SPL_SET_ID from properties.propValue:", splSetId);
        }
        
        // If properties has a properties array, search for SPL_SET_ID
        if (!splSetId && Array.isArray(propsJson?.properties)) {
          const splProp = propsJson.properties.find((p: any) => 
            p.propName === "SPL_SET_ID" || p.prop_name === "SPL_SET_ID"
          );
          if (splProp) {
            splSetId = splProp.propValue || splProp.prop_value;
            console.log("Found SPL_SET_ID from properties array:", splSetId);
          }
        }
        
        // Check property array structure (RxNorm format)
        if (!splSetId && propsJson?.properties?.property) {
          const props = Array.isArray(propsJson.properties.property) 
            ? propsJson.properties.property 
            : [propsJson.properties.property];
          for (const prop of props) {
            if (prop.propName === "SPL_SET_ID" && prop.propValue) {
              splSetId = prop.propValue;
              console.log("Found SPL_SET_ID from property array:", splSetId);
              break;
            }
          }
        }
        
        // Prefer SBD TTY if multiple SPL_SET_IDs exist
        if (!splSetId && propsJson?.properties) {
          const tty = properties.tty;
          if (tty === "SBD" && properties.spl_set_id) {
            splSetId = properties.spl_set_id;
            console.log("Found SPL_SET_ID from SBD TTY:", splSetId);
          }
        }
      } else {
        console.warn("Failed to fetch RxNorm properties. Status:", propsRes.status);
      }
      
      // Fallback: Try to get from openFDA search if not found in properties
      if (!splSetId) {
        console.log("SPL_SET_ID not found in RxNorm, trying openFDA fallback...");
        try {
          const fdaSearchRes = await fetch(`https://api.fda.gov/drug/ndc.json?search=openfda.rxcui:"${rxcui}"&limit=1`);
          if (fdaSearchRes.ok) {
            const fdaSearchJson = await fdaSearchRes.json();
            const firstResult = fdaSearchJson?.results?.[0];
            if (firstResult?.openfda?.spl_set_id) {
              splSetId = Array.isArray(firstResult.openfda.spl_set_id) 
                ? firstResult.openfda.spl_set_id[0] 
                : firstResult.openfda.spl_set_id;
              console.log("Found SPL_SET_ID from openFDA fallback:", splSetId);
            }
          }
        } catch (e) {
          console.warn("Error fetching SPL Set ID from openFDA:", e);
        }
      }
    } catch (e) {
      console.error("Error fetching properties for SPL Set ID:", e);
    }
    
    console.log("Final SPL_SET_ID for RxCUI", rxcui, ":", splSetId);

    // 4.2 Verified NDC Retrieval Chain
    
    // Step 1: DailyMed (primary source) - if SPL Set ID available
    let dailyMedRawData: any = null;
    if (splSetId) {
      try {
        // Use Next.js API route to proxy the request (avoids CORS issues)
        const dailyMedUrl = `/api/dailymed?spl_set_id=${encodeURIComponent(splSetId)}`;
        console.log("Fetching DailyMed via proxy:", dailyMedUrl);
        const dailyMedRes = await fetch(dailyMedUrl);
        console.log("DailyMed response status:", dailyMedRes.status, dailyMedRes.statusText);
        
        if (dailyMedRes.ok) {
          const dailyMedJson = await dailyMedRes.json();
          console.log("DailyMed JSON received:", dailyMedJson);
          console.log("DailyMed SPL Set ID from data.setid:", dailyMedJson?.data?.setid);
          dailyMedRawData = dailyMedJson; // Store raw data for display
          
          // Parse the actual DailyMed structure
          // Structure: data.products[] -> each product has packaging[] array
          const products = dailyMedJson?.data?.products || [];
          
          for (const product of products) {
            const productName = product.product_name;
            const productNameGeneric = product.product_name_generic;
            const productCode = product.product_code;
            const activeIngredients = product.active_ingredients || [];
            
            // Each product has packaging array
            const packaging = product.packaging || [];
            
            for (const pkg of packaging) {
              const packageNdc = pkg.ndc || pkg.package_ndc;
              const packageDescriptions = pkg.package_descriptions || [];
              const packageDescription = packageDescriptions.length > 0 
                ? packageDescriptions.join(", ") 
                : "N/A";
              
              if (packageNdc) {
                const normalized = normalizeNDC(packageNdc);
                if (!ndcMap.has(normalized)) {
                  // Extract labeler from title if available
                  const title = dailyMedJson?.data?.title || "";
                  const labelerMatch = title.match(/\[([^\]]+)\]/);
                  const labelerName = labelerMatch ? labelerMatch[1] : null;
                  
                  ndcMap.set(normalized, {
                    info: {
                      labeler_name: labelerName || "Unknown",
                      brand_name: productName,
                      package_description: packageDescription,
                      product_ndc: productCode,
                      product_type: "HUMAN PRESCRIPTION DRUG", // DailyMed default
                      route: "ORAL", // Can be extracted from product if available
                      dosage_form: "TABLET", // Can be extracted if available
                      strength: activeIngredients.map((ai: any) => 
                        `${ai.strength || ""} ${ai.name || ""}`.trim()
                      ).join(", "),
                      finished: true, // DailyMed typically has active products
                    },
                    source: "DailyMed",
                    spl_set_id: splSetId,
                  });
                }
              }
            }
          }
        } else {
          const errorText = await dailyMedRes.text();
          console.error("DailyMed fetch failed:", dailyMedRes.status, errorText);
        }
      } catch (e) {
        console.error("Error fetching DailyMed NDCs:", e);
        console.error("Error details:", e instanceof Error ? e.message : String(e));
        console.error("Stack:", e instanceof Error ? e.stack : "N/A");
      }
    } else {
      console.warn("No SPL Set ID found for RxCUI:", rxcui);
    }

    // Step 2: openFDA (SPL_SET_ID search) - validate/supplement DailyMed
    let fdaSplRawData: any = null;
    if (splSetId) {
      try {
        const fdaRes = await fetch(`https://api.fda.gov/drug/ndc.json?search=openfda.spl_set_id="${splSetId}"&limit=200`);
        if (fdaRes.ok) {
          const fdaJson = await fdaRes.json();
          fdaSplRawData = fdaJson; // Store raw FDA data for display
          const fdaResults = fdaJson?.results || [];
          
          for (const r of fdaResults) {
            // Check packaging NDCs
            if (r.packaging) {
              for (const p of r.packaging) {
                const pkgNdc = p.package_ndc;
                if (pkgNdc) {
                  const normalized = normalizeNDC(pkgNdc);
                  // Only add if not already in map (DailyMed takes priority)
                  if (!ndcMap.has(normalized)) {
                    ndcMap.set(normalized, {
                      info: {
                        labeler_name: r.labeler_name,
                        brand_name: r.brand_name,
                        marketing_status: r.marketing_status,
                        package_description: p.description || r.package_description || "N/A",
                        marketing_start: r.marketing_start_date,
                        marketing_end: r.marketing_end_date,
                        application_number: r.application_number,
                        finished: r.finished,
                        dosage_form: r.dosage_form,
                        route: r.route,
                        product_type: r.product_type,
                        strength: r.active_ingredient?.[0]?.strength || r.strength,
                      },
                      source: "FDA (SPL)",
                      spl_set_id: splSetId,
                    });
                  }
                }
              }
            }
            
            // Also check product_ndc
            const productNdc = r.product_ndc;
            if (productNdc) {
              const normalized = normalizeNDC(productNdc);
              if (!ndcMap.has(normalized)) {
                ndcMap.set(normalized, {
                  info: {
                    labeler_name: r.labeler_name,
                    brand_name: r.brand_name,
                    marketing_status: r.marketing_status,
                    package_description: r.package_description || "N/A",
                    marketing_start: r.marketing_start_date,
                    marketing_end: r.marketing_end_date,
                    application_number: r.application_number,
                    finished: r.finished,
                    dosage_form: r.dosage_form,
                    route: r.route,
                    product_type: r.product_type,
                    strength: r.active_ingredient?.[0]?.strength || r.strength,
                  },
                  source: "FDA (SPL)",
                  spl_set_id: splSetId,
                });
              }
            }
          }
        }
      } catch (e) {
        console.warn("Error fetching openFDA NDCs by SPL Set ID:", e);
      }
    }

    // Step 3: openFDA (RxCUI-based fallback) - for generics and equivalents
    try {
      const fdaRxcuiRes = await fetch(`https://api.fda.gov/drug/ndc.json?search=openfda.rxcui:"${rxcui}"&limit=200`);
      if (fdaRxcuiRes.ok) {
        const fdaRxcuiJson = await fdaRxcuiRes.json();
        const fdaRxcuiResults = fdaRxcuiJson?.results || [];
        
        for (const r of fdaRxcuiResults) {
          // Check packaging NDCs
          if (r.packaging) {
            for (const p of r.packaging) {
              const pkgNdc = p.package_ndc;
              if (pkgNdc) {
                const normalized = normalizeNDC(pkgNdc);
                // Only add if not already in map (DailyMed and FDA SPL take priority)
                if (!ndcMap.has(normalized)) {
                  const fdaSplSetId = r.openfda?.spl_set_id 
                    ? (Array.isArray(r.openfda.spl_set_id) ? r.openfda.spl_set_id[0] : r.openfda.spl_set_id)
                    : undefined;
                  
                  ndcMap.set(normalized, {
                    info: {
                      labeler_name: r.labeler_name,
                      brand_name: r.brand_name,
                      marketing_status: r.marketing_status,
                      package_description: p.description || r.package_description || "N/A",
                      marketing_start: r.marketing_start_date,
                      marketing_end: r.marketing_end_date,
                      application_number: r.application_number,
                      finished: r.finished,
                      dosage_form: r.dosage_form,
                      route: r.route,
                      product_type: r.product_type,
                      strength: r.active_ingredient?.[0]?.strength || r.strength,
                    },
                    source: "FDA (RxCUI)",
                    spl_set_id: fdaSplSetId,
                  });
                }
              }
            }
          }
          
          // Also check product_ndc
          const productNdc = r.product_ndc;
          if (productNdc) {
            const normalized = normalizeNDC(productNdc);
            if (!ndcMap.has(normalized)) {
              const fdaSplSetId = r.openfda?.spl_set_id 
                ? (Array.isArray(r.openfda.spl_set_id) ? r.openfda.spl_set_id[0] : r.openfda.spl_set_id)
                : undefined;
              
              ndcMap.set(normalized, {
                info: {
                  labeler_name: r.labeler_name,
                  brand_name: r.brand_name,
                  marketing_status: r.marketing_status,
                  package_description: r.package_description || "N/A",
                  marketing_start: r.marketing_start_date,
                  marketing_end: r.marketing_end_date,
                  application_number: r.application_number,
                  finished: r.finished,
                  dosage_form: r.dosage_form,
                  route: r.route,
                  product_type: r.product_type,
                  strength: r.active_ingredient?.[0]?.strength || r.strength,
                },
                source: "FDA (RxCUI)",
                spl_set_id: fdaSplSetId,
              });
            }
          }
        }
      }
    } catch (e) {
      console.warn("Error fetching openFDA NDCs by RxCUI:", e);
    }

    // Step 4: RxNorm fallback (final safety net)
    try {
      const rxNormRes = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/ndcs.json`);
      if (rxNormRes.ok) {
        const rxNormJson = await rxNormRes.json();
        const rxNormNdcs = rxNormJson?.ndcGroup?.ndcList?.ndc || rxNormJson?.ndcGroup?.ndc || [];
        
        for (const ndc of rxNormNdcs) {
          const normalized = normalizeNDC(ndc);
          // Only add if not already in map (all other sources take priority)
          if (!ndcMap.has(normalized)) {
            // Try to get basic info from RxNorm ndcstatus
            try {
              const statusRes = await fetch(`https://rxnav.nlm.nih.gov/REST/ndcstatus.json?ndc=${normalized}`);
              if (statusRes.ok) {
                const statusJson = await statusRes.json();
                const ndcStatus = statusJson?.ndcStatus;
                if (ndcStatus) {
                  ndcMap.set(normalized, {
                    info: {
                      labeler_name: ndcStatus.labelerName,
                      package_description: "N/A",
                      marketing_status: ndcStatus.status === "ACTIVE" ? "Active" : "Inactive",
                    },
                    source: "RxNorm",
                  });
                }
              }
            } catch (e) {
              // If status check fails, still add with minimal info
              ndcMap.set(normalized, {
                info: {
                  package_description: "N/A",
                },
                source: "RxNorm",
              });
            }
          }
        }
      }
    } catch (e) {
      console.warn("Error fetching RxNorm NDCs:", e);
    }

    // 4.3 Validate and Classify NDCs
    for (const [ndc, { info, source, spl_set_id }] of ndcMap.entries()) {
      // Determine if active: finished=true AND (no marketing_end_date OR marketing_end_date in future)
      // Inactive: finished=false OR marketing_end_date in past
      let isActive = false;
      
      if (info) {
        // Get current date for comparison
        const now = new Date();
        
        // Parse marketing_end_date if it exists
        const end = info.marketing_end ? new Date(info.marketing_end) : null;
        
        // Check finished status
        // DailyMed source is assumed to be finished (active products)
        const finished = info.finished === true || 
                         info.finished === "true" || 
                         info.finished === "Finished" || 
                         source === "DailyMed";
        
        // Active if: finished=true AND (no end date OR end date in future)
        // Only mark as active if finished=true
        if (finished) {
          // If no end date, it's active (ongoing approval)
          // If end date exists, check if it's in the future
          isActive = !end || end > now;
        } else {
          // If not finished, it's inactive
          isActive = false;
        }
        
        // Special case: RxNorm status check (override if status is explicitly "Active")
        if (source === "RxNorm" && info.marketing_status === "Active") {
          isActive = true;
        }
      } else {
        // If no info available, default to active (optimistic)
        isActive = true;
      }

      results.push({
        ndc,
        normalizedNdc: normalizeNDC(ndc),
        active: isActive,
        fdaInfo: info ? {
          ...info,
          source, // Track which source: "DailyMed", "FDA (SPL)", "FDA (RxCUI)", "RxNorm"
          spl_set_id, // Include SPL Set ID if available
        } : null,
      });
    }

    return {
      ndcs: results,
      dailyMedRaw: dailyMedRawData || undefined,
      fdaSplRaw: fdaSplRawData || undefined,
    };
  }, []);

  // Helper: Process a single RxCUI into a FinalResultComponent
  const processRxCuiToComponent = useCallback(async (
    rxcui: string,
    input: string,
    normalized: NormalizedData,
    verification: VerificationResult | null,
    ndcs: NDCInfo[]
  ): Promise<FinalResultComponent | null> => {
    if (!verification) return null;

    // Group NDCs by manufacturer (labeler_name)
    const groupedNDCs: GroupedNDCs = {};
    
    ndcs.forEach((ndcInfo) => {
      const manufacturer = ndcInfo.fdaInfo?.labeler_name || "Unknown Manufacturer";
      const brandName = ndcInfo.fdaInfo?.brand_name;
      
      if (!groupedNDCs[manufacturer]) {
        groupedNDCs[manufacturer] = {
          brand_name: brandName,
          active: [],
          inactive: [],
        };
      }
      
      // Extract package description and count
      const packageDesc = ndcInfo.fdaInfo?.package_description || "N/A";
      const countMatch = packageDesc.match(/(\d+)\s*(TAB|CAP|BOTTLE|VIAL|ML|MG)/i);
      const count = countMatch ? countMatch[0] : undefined;
      
      const ndcEntry = {
        ndc: ndcInfo.normalizedNdc,
        package: packageDesc,
        start: ndcInfo.fdaInfo?.marketing_start,
        end: ndcInfo.fdaInfo?.marketing_end,
        application_number: ndcInfo.fdaInfo?.application_number,
        strength: ndcInfo.fdaInfo?.strength,
        count,
        source: ndcInfo.fdaInfo?.source || "RxNorm", // Preserve source information
        product_type: ndcInfo.fdaInfo?.product_type,
        route: ndcInfo.fdaInfo?.route,
        dosage_form: ndcInfo.fdaInfo?.dosage_form,
        product_ndc: ndcInfo.fdaInfo?.product_ndc,
        spl_set_id: ndcInfo.fdaInfo?.spl_set_id,
      };
      
      if (ndcInfo.active) {
        groupedNDCs[manufacturer].active.push(ndcEntry);
      } else {
        // Remove optional fields for inactive
        const { strength, count, ...inactiveEntry } = ndcEntry;
        groupedNDCs[manufacturer].inactive.push(inactiveEntry);
      }
    });

    // Count total active/inactive for assurity adjustment
    const totalActive = ndcs.filter(n => n.active).length;
    const totalInactive = ndcs.filter(n => !n.active).length;

    // Get canonical RxNorm name and TTY
    const props = await getRxcuiProps(rxcui);
    const rxnormName = props?.name || "";
    const tty = props?.tty || null;

    // Adjust assurity based on NDC status
    let adjustedAssurity = verification.assurity;
    if (totalActive > 0) {
      adjustedAssurity = Math.min(100, adjustedAssurity + 5);
    } else if (totalInactive > 0 && totalActive === 0) {
      adjustedAssurity = Math.max(0, adjustedAssurity - 10);
    }

    // Determine match status
    let matchStatus = "Exact match";
    if (verification.brandMatch < 1 && normalized.brand) {
      matchStatus = "Brand equivalent";
    } else if (verification.ingredientMatch < 1) {
      matchStatus = "Partial match";
    } else if (verification.strengthMatch < 1 || verification.formMatch < 1) {
      matchStatus = "Partial match";
    }

    return {
      input,
      normalized: normalized.normalized,
      rxcui,
      rxnorm_name: rxnormName,
      tty,
      brand: normalized.brand,
      assurity_score: Math.round(adjustedAssurity),
      match_status: matchStatus,
      ndcs: groupedNDCs,
    };
  }, []);

  // Step 5: Final output (Enhanced for both SCD and SBD)
  const step5FinalOutput = useCallback(async (
    input: string,
    normalized: NormalizedData,
    candidates: RxCuiCandidate[],
    verifications: Record<string, VerificationResult>,
    ndcs: Record<string, NDCInfo[]>,
    setDailyMedDataFn?: (fn: (prev: Record<string, any>) => Record<string, any>) => void
  ): Promise<FinalResult> => {
    setStep("Step 5: Computing final output for SCD and SBD...");

    // 1️⃣ Select the best candidate (highest assurity)
    const candidatesWithVerification = candidates
      .map(c => ({
        candidate: c,
        verification: verifications[c.rxcui],
      }))
      .filter(v => v.verification)
      .sort((a, b) => (b.verification?.assurity || 0) - (a.verification?.assurity || 0));

    const MIN_CONFIDENCE_THRESHOLD = 70;
    const validCandidates = candidatesWithVerification.filter(
      v => (v.verification?.assurity || 0) >= MIN_CONFIDENCE_THRESHOLD
    );

    if (validCandidates.length === 0 && candidatesWithVerification.length === 0) {
      throw new Error("No valid candidate found");
    }

    const bestCandidate = validCandidates.length > 0 
      ? validCandidates[0] 
      : candidatesWithVerification[0];

    if (!bestCandidate) {
      throw new Error("No valid candidate found");
    }

    const baseRxCui = bestCandidate.candidate.rxcui;

    // 2️⃣ Enhanced Related Expansion using allrelated.json
    let scdRxCui: string | null = null;
    let sbdRxCui: string | null = null;
    let ingredientRxCui: string | null = null;
    let doseFormRxCui: string | null = null;

    try {
      // Use allrelated.json for comprehensive related concept retrieval
      const allRelatedRes = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${baseRxCui}/allrelated.json`);
      if (allRelatedRes.ok) {
        const allRelatedJson = await allRelatedRes.json();
        const conceptGroups = allRelatedJson?.allRelatedGroup?.conceptGroup || [];
        
        for (const group of conceptGroups) {
          const tty = group?.tty;
          const concepts = group?.conceptProperties || [];
          
          if (tty === "SCD" && concepts.length > 0 && !scdRxCui) {
            scdRxCui = String(concepts[0]?.rxcui || "");
          } else if (tty === "SBD" && concepts.length > 0 && !sbdRxCui) {
            sbdRxCui = String(concepts[0]?.rxcui || "");
          } else if (tty === "IN" && concepts.length > 0 && !ingredientRxCui) {
            ingredientRxCui = String(concepts[0]?.rxcui || "");
          } else if (tty === "DF" && concepts.length > 0 && !doseFormRxCui) {
            doseFormRxCui = String(concepts[0]?.rxcui || "");
          }
        }
      }
      
      // Fallback to related.json if allrelated.json fails
      if (!scdRxCui && !sbdRxCui) {
        const relatedRes = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${baseRxCui}/related.json?tty=SCD+SBD`);
        if (relatedRes.ok) {
          const relatedJson = await relatedRes.json();
          const conceptGroups = relatedJson?.relatedGroup?.conceptGroup || [];
          
          for (const group of conceptGroups) {
            const tty = group?.tty;
            const concepts = group?.conceptProperties || [];
            
            if (tty === "SCD" && concepts.length > 0 && !scdRxCui) {
              scdRxCui = String(concepts[0]?.rxcui || "");
            } else if (tty === "SBD" && concepts.length > 0 && !sbdRxCui) {
              sbdRxCui = String(concepts[0]?.rxcui || "");
            }
          }
        }
      }
    } catch (e) {
      console.warn("Error fetching related concepts:", e);
    }

    // 3️⃣ Process SCD (Semantic Clinical Drug - generic)
    let scdComponent: FinalResultComponent | null = null;
    if (scdRxCui) {
      // Verify SCD if not already verified
      let scdVerification = verifications[scdRxCui];
      if (!scdVerification) {
        // Create a temporary candidate for verification
        const scdCandidate: RxCuiCandidate = {
          rxcui: scdRxCui,
          name: "",
          score: 100,
          source: "exact",
        };
        const scdVerifications = await step3Verify(normalized, [scdCandidate]);
        scdVerification = scdVerifications[scdRxCui] || bestCandidate.verification;
      }
      
      // Fetch NDCs for SCD if not already fetched
      // COMMENTED OUT: SCD NDC fetching disabled - only keeping SBD NDC searches
      // let scdNDCs = ndcs[scdRxCui] || [];
      // if (scdNDCs.length === 0) {
      //   // Fetch NDCs for SCD
      //   const scdResult = await step4FetchNDCs(scdRxCui);
      //   scdNDCs = scdResult.ndcs;
      //   // Store DailyMed and FDA raw data if available
      //   if (scdResult.dailyMedRaw && setDailyMedDataFn) {
      //     setDailyMedDataFn(prev => ({
      //       ...prev,
      //       [scdRxCui]: scdResult.dailyMedRaw,
      //     }));
      //   }
      //   if (scdResult.fdaSplRaw) {
      //     setFdaSplData(prev => ({
      //       ...prev,
      //       [scdRxCui]: scdResult.fdaSplRaw,
      //     }));
      //   }
      // }
      // Use empty array for SCD NDCs (NDC fetching disabled)
      const scdNDCs: NDCInfo[] = [];
      scdComponent = await processRxCuiToComponent(
        scdRxCui,
        input,
        normalized,
        scdVerification,
        scdNDCs
      );
    }

    // 4️⃣ Process SBD (Semantic Branded Drug - branded) with DailyMed + openFDA verification
    let sbdComponent: FinalResultComponent | null = null;
    if (sbdRxCui) {
      // Verify SBD if not already verified
      let sbdVerification = verifications[sbdRxCui];
      if (!sbdVerification) {
        // Create a temporary candidate for verification
        const sbdCandidate: RxCuiCandidate = {
          rxcui: sbdRxCui,
          name: "",
          score: 100,
          source: "exact",
        };
        const sbdVerifications = await step3Verify(normalized, [sbdCandidate]);
        sbdVerification = sbdVerifications[sbdRxCui] || bestCandidate.verification;
      }
      
      // Fetch NDCs for SBD using enhanced DailyMed + openFDA chain
      let sbdNDCs = ndcs[sbdRxCui] || [];
      if (sbdNDCs.length === 0) {
        // Fetch NDCs for SBD (this will use DailyMed → openFDA → RxNorm chain)
        const sbdResult = await step4FetchNDCs(sbdRxCui);
        sbdNDCs = sbdResult.ndcs;
        // Store DailyMed and FDA raw data if available
        if (sbdResult.dailyMedRaw && setDailyMedDataFn) {
          setDailyMedDataFn(prev => ({
            ...prev,
            [sbdRxCui]: sbdResult.dailyMedRaw,
          }));
        }
        if (sbdResult.fdaSplRaw) {
          setFdaSplData(prev => ({
            ...prev,
            [sbdRxCui]: sbdResult.fdaSplRaw,
          }));
        }
      }
      
      // Process SBD component with enhanced verification
      sbdComponent = await processRxCuiToComponent(
        sbdRxCui,
        input,
        normalized,
        sbdVerification,
        sbdNDCs
      );
      
      // Adjust assurity based on DailyMed/FDA verification
      if (sbdComponent && sbdNDCs.length > 0) {
        const dailyMedNDCs = sbdNDCs.filter(n => n.fdaInfo?.source === "DailyMed");
        const fdaSplNDCs = sbdNDCs.filter(n => n.fdaInfo?.source === "FDA (SPL)");
        const fdaRxcuiNDCs = sbdNDCs.filter(n => n.fdaInfo?.source === "FDA (RxCUI)");
        const activeDailyMedFDA = sbdNDCs.filter(n => 
          (n.fdaInfo?.source === "DailyMed" || 
           n.fdaInfo?.source === "FDA (SPL)" || 
           n.fdaInfo?.source === "FDA (RxCUI)") && n.active
        );
        
        // Enhanced assurity adjustment for verified DailyMed/FDA NDCs
        if (activeDailyMedFDA.length > 0) {
          sbdComponent.assurity_score = Math.min(100, sbdComponent.assurity_score + 5);
        }
        
        // Determine match status with DailyMed verification
        if (sbdComponent.match_status === "Exact match" && activeDailyMedFDA.length > 0) {
          // Already exact match with verified NDCs - keep as is
        } else if (dailyMedNDCs.length > 0 || fdaSplNDCs.length > 0 || fdaRxcuiNDCs.length > 0) {
          // Has verified DailyMed/FDA NDCs - can upgrade to "Exact match" if all fields match
          if (sbdVerification.ingredientMatch === 1 && 
              sbdVerification.strengthMatch === 1 && 
              sbdVerification.formMatch === 1 && 
              sbdVerification.brandMatch >= 0.5) {
            sbdComponent.match_status = "Exact match";
          }
        }
      }
    }

    // 5️⃣ Return both components
    return {
      scd: scdComponent,
      sbd: sbdComponent,
    };
  }, [processRxCuiToComponent, step4FetchNDCs, step3Verify]);

  // Optional: LLM-assisted comparison
  const step6LLMComparison = useCallback(async (
    input: string,
    rxnormName: string
  ): Promise<number> => {
    setStep("Step 6: LLM-assisted comparison...");
    try {
      const prompt = medicationComparisonPrompt(input, rxnormName);
      const { parsed } = await callOpenAIRaw("gpt-4o", prompt);
      const result = parsed as any;
      return result.confidence || 0;
    } catch (e) {
      console.error("LLM comparison failed:", e);
      return 0;
    }
  }, []);

  const handleRun = useCallback(async () => {
    const input = med.trim();
    if (!input) return;

    setLoading(true);
    setError(null);
    setStep("");
    setNormalizedData(null);
    setCandidates([]);
    setVerificationResults({});
    setNdcResults({});
    setFinalResult(null);
    setLlmComparison(null);
    setDailyMedData({});
    setFdaSplData({});

    try {
      // Step 1: Normalize
      const normalized = await step1Normalize(input);
      setNormalizedData(normalized);

      // Step 2: Fetch candidates
      // Step 2: Enhanced tiered RxNorm query with synonym expansion
      const cands = await step2FetchCandidates(normalized.normalized, normalized);
      setCandidates(cands);

      if (cands.length === 0) {
        throw new Error("No RxNorm candidates found");
      }

      // Step 3: Enhanced cross-verification with improved weighting
      let verifications = await step3Verify(normalized, cands);
      setVerificationResults(verifications);

      // Step 4: Semantic verification (LLM entailment check) for top candidates
      const topCandidates = cands
        .slice(0, 3)
        .map(c => ({
          rxcui: c.rxcui,
          name: c.name,
          verification: verifications[c.rxcui],
        }))
        .filter(c => c.verification);
      
      if (topCandidates.length > 0) {
        const semanticUpdates = await step4SemanticVerification(med, topCandidates);
        // Merge semantic updates back into verifications
        verifications = { ...verifications, ...semanticUpdates };
        setVerificationResults(verifications);
      }

      // Step 5: Cross-verification with OpenFDA (for best candidate)
      const bestCandidate = cands
        .map(c => ({ candidate: c, verification: verifications[c.rxcui] }))
        .filter(v => v.verification)
        .sort((a, b) => (b.verification?.assurity || 0) - (a.verification?.assurity || 0))[0];
      
      if (bestCandidate) {
        const fdaVerification = await step5CrossVerifyFDA(
          bestCandidate.candidate.rxcui,
          normalized.brand
        );
        console.log("FDA Cross-Verification:", fdaVerification);
      }

      // Step 6: Fetch NDCs for top candidate
      const topCandidate = cands
        .map(c => ({ candidate: c, verification: verifications[c.rxcui] }))
        .filter(v => v.verification)
        .sort((a, b) => (b.verification?.assurity || 0) - (a.verification?.assurity || 0))[0];

      let ndcData: Record<string, NDCInfo[]> = {};
      if (topCandidate) {
        const result = await step4FetchNDCs(topCandidate.candidate.rxcui);
        ndcData[topCandidate.candidate.rxcui] = result.ndcs;
        setNdcResults(ndcData);
        // Store DailyMed and FDA raw data if available
        if (result.dailyMedRaw) {
          setDailyMedData(prev => ({
            ...prev,
            [topCandidate.candidate.rxcui]: result.dailyMedRaw,
          }));
        }
        if (result.fdaSplRaw) {
          setFdaSplData(prev => ({
            ...prev,
            [topCandidate.candidate.rxcui]: result.fdaSplRaw,
          }));
        }
      }

      // Step 7: Final output (returns both SCD and SBD)
      const final = await step5FinalOutput(input, normalized, cands, verifications, ndcData, setDailyMedData);
      setFinalResult(final);

      // Step 8: Optional LLM comparison for both SCD and SBD
      const llmComparisons: Record<string, number> = {};
      
      if (final.scd?.rxnorm_name) {
        const scdLlmConf = await step6LLMComparison(input, final.scd.rxnorm_name);
        llmComparisons.scd = scdLlmConf;
        const scdFinalConf = (0.6 * final.scd.assurity_score + 0.4 * scdLlmConf);
        setFinalResult(prev => prev && prev.scd ? {
          ...prev,
          scd: { ...prev.scd, llm_confidence: scdLlmConf, final_confidence: Math.round(scdFinalConf) }
        } : prev);
      }
      
      if (final.sbd?.rxnorm_name) {
        const sbdLlmConf = await step6LLMComparison(input, final.sbd.rxnorm_name);
        llmComparisons.sbd = sbdLlmConf;
        const sbdFinalConf = (0.6 * final.sbd.assurity_score + 0.4 * sbdLlmConf);
        setFinalResult(prev => prev && prev.sbd ? {
          ...prev,
          sbd: { ...prev.sbd, llm_confidence: sbdLlmConf, final_confidence: Math.round(sbdFinalConf) }
        } : prev);
      }
      
      if (Object.keys(llmComparisons).length > 0) {
        setLlmComparison(llmComparisons);
      }

      setStep("Complete!");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setStep("Error");
    } finally {
      setLoading(false);
    }
  }, [med, step1Normalize, step2FetchCandidates, step3Verify, step4SemanticVerification, step4FetchNDCs, step5CrossVerifyFDA, step5FinalOutput, step6LLMComparison]);

  return (
    <main className="mx-auto max-w-7xl p-4 sm:p-6">
      <div className="rounded-xl bg-white/80 backdrop-blur border px-4 sm:px-6 py-5 shadow-sm">
        <h1 className="text-xl sm:text-2xl font-bold text-blue-700">Test Medication Tools 2</h1>
        <p className="text-xs sm:text-sm text-gray-600 mt-1">
          Advanced medication resolution with weighted scoring and NDC verification.
        </p>
      </div>

      <section className="mt-4 flex items-stretch gap-2">
        <input
          value={med}
          onChange={(e) => setMed(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleRun()}
          placeholder='e.g., "10 MG amlodipine Oral Tablet [Norvasc]"'
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

      {step && (
        <section className="mt-4">
          <div className="text-sm text-blue-700 font-medium">{step}</div>
        </section>
      )}

      {error && (
        <section className="mt-4">
          <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded p-2">{error}</div>
        </section>
      )}

      {/* Step 1 Results */}
      {normalizedData && (
        <section className="mt-6 bg-white/80 backdrop-blur rounded-xl border shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Step 1: LLM Normalization</h2>
          <div className="space-y-2 text-xs">
            <div><span className="font-medium">Ingredient:</span> <span className="font-mono">{normalizedData.ingredient}</span></div>
            <div><span className="font-medium">Strength:</span> <span className="font-mono">{normalizedData.strength || "N/A"}</span></div>
            <div><span className="font-medium">Form:</span> <span className="font-mono">{normalizedData.form || "N/A"}</span></div>
            <div><span className="font-medium">Brand:</span> <span className="font-mono">{normalizedData.brand || "N/A"}</span></div>
            <div><span className="font-medium">Normalized:</span> <span className="font-mono text-blue-700">{normalizedData.normalized}</span></div>
          </div>
        </section>
      )}

      {/* Step 2 Results */}
      {candidates.length > 0 && (
        <section className="mt-6 bg-white/80 backdrop-blur rounded-xl border shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Step 2: RxNorm Candidates</h2>
          <div className="space-y-2">
            {candidates.map((c) => (
              <div key={c.rxcui} className="border rounded p-2 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-gray-900">{c.rxcui}</span>
                  <span className="text-gray-600">Score: {c.score}</span>
                </div>
                <div className="text-gray-700 mt-1">{c.name}</div>
                <div className="text-[11px] text-gray-500 mt-1">Source: {c.source}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Step 3 Results */}
      {Object.keys(verificationResults).length > 0 && (
        <section className="mt-6 bg-white/80 backdrop-blur rounded-xl border shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Step 3: Cross-Verification Results</h2>
          <div className="space-y-3">
            {Object.entries(verificationResults)
              .sort((a, b) => b[1].assurity - a[1].assurity)
              .map(([rxcui, result]) => (
                <div key={rxcui} className="border rounded p-3 bg-gray-50">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-mono text-sm font-semibold">{rxcui}</span>
                    <span className="text-sm font-bold text-blue-700">Assurity: {Math.round(result.assurity)}%</span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs mt-2">
                    <div>
                      <span className="font-medium">Ingredient:</span> {result.ingredientMatch === 1 ? "✅ Exact" : result.ingredientMatch === 0.5 ? "⚠️ Partial" : "❌ No match"} ({Math.round(result.ingredientMatch * 100)}%)
                    </div>
                    <div>
                      <span className="font-medium">Strength:</span> {result.strengthMatch === 1 ? "✅ Exact" : result.strengthMatch === 0.5 ? "⚠️ Partial" : "❌ No match"} ({Math.round(result.strengthMatch * 100)}%)
                    </div>
                    <div>
                      <span className="font-medium">Form:</span> {result.formMatch === 1 ? "✅ Exact" : result.formMatch === 0.5 ? "⚠️ Partial" : "❌ No match"} ({Math.round(result.formMatch * 100)}%)
                    </div>
                    <div>
                      <span className="font-medium">Brand:</span> {result.brandMatch === 1 ? "✅ Exact" : result.brandMatch === 0.5 ? "⚠️ Equivalent" : "❌ No match"} ({Math.round(result.brandMatch * 100)}%)
                    </div>
                  </div>
                  <div className="mt-2 text-[11px] text-gray-600">
                    <div>RxNorm Name: {result.details.ingredient}</div>
                    <div>Strength: {result.details.strength} | Form: {result.details.form} | Brand: {result.details.brand}</div>
                  </div>
                </div>
              ))}
          </div>
        </section>
      )}

      {/* DailyMed vs FDA Comparison Section */}
      {(Object.keys(dailyMedData).length > 0 || Object.keys(fdaSplData).length > 0) && (
        <section className="mt-6 bg-gradient-to-r from-purple-50 to-blue-50 border-2 border-purple-300 rounded-xl shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">
            📊 DailyMed vs FDA Comparison (SPL Set ID Search)
          </h2>
          
          {/* Get all unique RxCUIs from both sources */}
          {Array.from(new Set([...Object.keys(dailyMedData), ...Object.keys(fdaSplData)])).map((rxcui) => {
            const dailyMed = dailyMedData[rxcui];
            const fda = fdaSplData[rxcui];
            const splSetId = dailyMed?.data?.setid || fda?.results?.[0]?.openfda?.spl_set_id?.[0] || "N/A";
            
            const dailyMedUrl = splSetId !== "N/A" 
              ? `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/${splSetId}/packaging.json`
              : null;
            const fdaUrl = splSetId !== "N/A"
              ? `https://api.fda.gov/drug/ndc.json?search=openfda.spl_set_id="${splSetId}"`
              : null;
            
            return (
              <div key={rxcui} className="mb-6 last:mb-0">
                <div className="bg-yellow-50 border border-yellow-300 rounded p-2 mb-3">
                  <div className="text-xs font-semibold text-gray-900 mb-1">
                    RxCUI: <span className="font-mono bg-white px-1 rounded">{rxcui}</span>
                  </div>
                  {splSetId !== "N/A" ? (
                    <div className="text-xs font-semibold text-gray-900">
                      SPL Set ID: <span className="font-mono bg-yellow-100 px-2 py-1 rounded text-purple-900 font-bold">{splSetId}</span>
                    </div>
                  ) : (
                    <div className="text-xs text-red-600">⚠️ SPL Set ID: Not found</div>
                  )}
                </div>
                
                {/* Side-by-side comparison */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* DailyMed Column */}
                  <div className="bg-purple-50 border-2 border-purple-300 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-xs font-semibold text-purple-900">📋 DailyMed</h3>
                      {dailyMedUrl && (
                        <a href={dailyMedUrl} target="_blank" rel="noopener noreferrer" className="text-[9px] text-blue-600 hover:underline">View API</a>
                      )}
                    </div>
                    {dailyMed ? (
                      <div className="space-y-2 text-[11px]">
                        {dailyMed.metadata && (
                          <div className="bg-white rounded p-2 border border-purple-200">
                            <div className="font-medium text-purple-800 mb-1">Metadata</div>
                            <div className="text-[10px] text-gray-600">
                              <div>Published: {dailyMed.metadata.db_published_date || "N/A"}</div>
                            </div>
                          </div>
                        )}
                        {dailyMed.data && (
                          <div className="bg-white rounded p-2 border border-purple-200">
                            <div className="font-medium text-purple-800 mb-1">Product Info</div>
                            <div className="text-[10px] space-y-1">
                              <div><span className="font-medium">Title:</span> {dailyMed.data.title || "N/A"}</div>
                              <div><span className="font-medium">Version:</span> {dailyMed.data.spl_version || "N/A"}</div>
                              <div><span className="font-medium">Published:</span> {dailyMed.data.published_date || "N/A"}</div>
                              <div className="bg-purple-100 rounded p-1 mt-1">
                                <span className="font-semibold">SPL Set ID:</span> 
                                <span className="font-mono text-purple-900 font-bold ml-1 text-xs">{dailyMed.data.setid || "N/A"}</span>
                              </div>
                            </div>
                            
                            {/* Products */}
                            {dailyMed.data.products && dailyMed.data.products.length > 0 && (
                              <div className="mt-2">
                                <div className="font-medium text-purple-800 mb-1">Products ({dailyMed.data.products.length}):</div>
                                <div className="space-y-2 max-h-96 overflow-y-auto">
                                  {dailyMed.data.products.map((product: any, idx: number) => {
                                    // Check if this is SCD (generic) - product_name equals product_name_generic
                                    const isSCD = product.product_name && product.product_name_generic && 
                                                product.product_name.toLowerCase() === product.product_name_generic.toLowerCase();
                                    return (
                                    <div key={idx} className="bg-purple-100 rounded p-2 border border-purple-200">
                                      <div className="font-semibold text-[10px] text-purple-900 mb-1">
                                        <span className="font-bold">{isSCD ? "Name:" : "Brand:"}</span> {product.product_name || "N/A"} <span className="text-gray-600">({product.product_code || "N/A"})</span>
                                      </div>
                                      <div className="text-[9px] text-gray-700 space-y-0.5">
                                        <div className="bg-purple-200 rounded px-1 py-0.5 mb-1">
                                          <span className="font-semibold text-[9px]">SPL Set ID:</span> 
                                          <span className="font-mono text-purple-900 font-bold ml-1 text-[9px]">{dailyMed.data.setid || "N/A"}</span>
                                        </div>
                                        <div><span className="font-medium">Generic:</span> {product.product_name_generic || "N/A"}</div>
                                        <div><span className="font-medium">Brand Name:</span> {product.product_name || "N/A"}</div>
                                        {product.active_ingredients && product.active_ingredients.length > 0 && (
                                          <div>
                                            <span className="font-medium">Ingredients:</span>
                                            <ul className="list-disc list-inside ml-1 mt-0.5">
                                              {product.active_ingredients.map((ai: any, aiIdx: number) => (
                                                <li key={aiIdx}>{ai.strength || ""} {ai.name || ""}</li>
                                              ))}
                                            </ul>
                                          </div>
                                        )}
                                        {product.packaging && product.packaging.length > 0 && (
                                          <div>
                                            <span className="font-medium">NDCs ({product.packaging.length}):</span>
                                            <div className="ml-1 mt-0.5 space-y-0.5">
                                              {product.packaging.map((pkg: any, pkgIdx: number) => (
                                                <div key={pkgIdx} className="font-mono text-purple-900">
                                                  {pkg.ndc || "N/A"}
                                                  {pkg.package_descriptions && pkg.package_descriptions.length > 0 && (
                                                    <span className="text-gray-600 ml-1">
                                                      ({pkg.package_descriptions.join(", ")})
                                                    </span>
                                                  )}
                                                </div>
                                              ))}
                                            </div>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                    );
                                  })}
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-[11px] text-gray-500">No DailyMed data available</div>
                    )}
                  </div>
                  
                  {/* FDA Column */}
                  <div className="bg-blue-50 border-2 border-blue-300 rounded-lg p-3">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-xs font-semibold text-blue-900">🏥 openFDA</h3>
                      {fdaUrl && (
                        <a href={fdaUrl} target="_blank" rel="noopener noreferrer" className="text-[9px] text-blue-600 hover:underline">View API</a>
                      )}
                    </div>
                    {fda ? (
                      <div className="space-y-2 text-[11px]">
                        {fda.meta && (
                          <div className="bg-white rounded p-2 border border-blue-200">
                            <div className="font-medium text-blue-800 mb-1">Metadata</div>
                            <div className="text-[10px] text-gray-600">
                              <div>Total Results: {fda.meta.results?.total || 0}</div>
                              <div>Last Updated: {fda.meta.last_updated || "N/A"}</div>
                            </div>
                          </div>
                        )}
                        {fda.results && fda.results.length > 0 ? (
                          <div className="bg-white rounded p-2 border border-blue-200">
                            <div className="font-medium text-blue-800 mb-1">Products ({fda.results.length}):</div>
                            <div className="space-y-2 max-h-96 overflow-y-auto">
                              {fda.results.map((result: any, idx: number) => {
                                // Check if this is SCD (generic) - brand_name equals generic_name
                                const isSCD = result.brand_name && result.generic_name && 
                                            result.brand_name.toLowerCase() === result.generic_name.toLowerCase();
                                return (
                                <div key={idx} className="bg-blue-100 rounded p-2 border border-blue-200">
                                  <div className="font-semibold text-[10px] text-blue-900 mb-1">
                                    <span className="font-bold">{isSCD ? "Name:" : "Brand:"}</span> {result.brand_name || "N/A"} <span className="text-gray-600">({result.product_ndc || "N/A"})</span>
                                  </div>
                                  <div className="text-[9px] text-gray-700 space-y-0.5">
                                    <div className="bg-blue-200 rounded px-1 py-0.5 mb-1">
                                      <span className="font-semibold text-[9px]">SPL Set ID:</span> 
                                      <span className="font-mono text-blue-900 font-bold ml-1 text-[9px]">
                                        {result.openfda?.spl_set_id 
                                          ? (Array.isArray(result.openfda.spl_set_id) 
                                              ? result.openfda.spl_set_id[0] 
                                              : result.openfda.spl_set_id)
                                          : "N/A"}
                                      </span>
                                    </div>
                                    <div><span className="font-medium">Generic:</span> {result.generic_name || "N/A"}</div>
                                    <div><span className="font-medium">Brand Name:</span> {result.brand_name || "N/A"}</div>
                                    <div><span className="font-medium">Labeler:</span> {result.labeler_name || "N/A"}</div>
                                    <div><span className="font-medium">Type:</span> {result.product_type || "N/A"}</div>
                                    <div><span className="font-medium">Form:</span> {result.dosage_form || "N/A"}</div>
                                    <div><span className="font-medium">Route:</span> {Array.isArray(result.route) ? result.route.join(", ") : result.route || "N/A"}</div>
                                    {result.active_ingredients && result.active_ingredients.length > 0 && (
                                      <div>
                                        <span className="font-medium">Ingredients:</span>
                                        <ul className="list-disc list-inside ml-1 mt-0.5">
                                          {result.active_ingredients.map((ai: any, aiIdx: number) => (
                                            <li key={aiIdx}>{ai.strength || ""} {ai.name || ""}</li>
                                          ))}
                                        </ul>
                                      </div>
                                    )}
                                    {result.packaging && result.packaging.length > 0 && (
                                      <div>
                                        <span className="font-medium">NDCs ({result.packaging.length}):</span>
                                        <div className="ml-1 mt-0.5 space-y-0.5">
                                          {result.packaging.map((pkg: any, pkgIdx: number) => (
                                            <div key={pkgIdx} className="font-mono text-blue-900">
                                              {pkg.package_ndc || "N/A"}
                                              {pkg.description && (
                                                <span className="text-gray-600 ml-1">({pkg.description})</span>
                                              )}
                                              {pkg.marketing_start_date && (
                                                <div className="text-[8px] text-gray-500 ml-1">
                                                  Start: {pkg.marketing_start_date}
                                                  {pkg.marketing_end_date && ` | End: ${pkg.marketing_end_date}`}
                                                </div>
                                              )}
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    )}
                                    {result.marketing_start_date && (
                                      <div className="text-[9px] text-gray-600">
                                        <span className="font-medium">Marketing:</span> {result.marketing_start_date}
                                        {result.marketing_end_date && ` - ${result.marketing_end_date}`}
                                      </div>
                                    )}
                                    {result.application_number && (
                                      <div className="text-[9px] text-gray-600">
                                        <span className="font-medium">App #:</span> {result.application_number}
                                      </div>
                                    )}
                                    {result.openfda?.rxcui && (
                                      <div className="text-[9px] text-gray-600">
                                        <span className="font-medium">RxCUIs:</span> {Array.isArray(result.openfda.rxcui) ? result.openfda.rxcui.join(", ") : result.openfda.rxcui}
                                      </div>
                                    )}
                                  </div>
                                </div>
                                );
                              })}
                            </div>
                          </div>
                        ) : (
                          <div className="text-[11px] text-gray-500">No FDA results found</div>
                        )}
                      </div>
                    ) : (
                      <div className="text-[11px] text-gray-500">No FDA data available</div>
                    )}
                  </div>
                </div>
                
                {/* Comparison Summary */}
                {dailyMed && fda && (
                  <div className="mt-3 bg-yellow-50 border border-yellow-200 rounded p-2">
                    <div className="text-xs font-semibold text-yellow-900 mb-1">📊 Comparison Summary</div>
                    <div className="text-[10px] text-gray-700 space-y-0.5">
                      <div>
                        <span className="font-medium">DailyMed Products:</span> {dailyMed.data?.products?.length || 0} | 
                        <span className="font-medium ml-2">FDA Products:</span> {fda.results?.length || 0}
                      </div>
                      <div>
                        <span className="font-medium">DailyMed Total NDCs:</span> {
                          dailyMed.data?.products?.reduce((sum: number, p: any) => sum + (p.packaging?.length || 0), 0) || 0
                        } | 
                        <span className="font-medium ml-2">FDA Total NDCs:</span> {
                          fda.results?.reduce((sum: number, r: any) => sum + (r.packaging?.length || 0), 0) || 0
                        }
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {/* Step 4 Results */}
      {Object.keys(ndcResults).length > 0 && (
        <section className="mt-6 bg-white/80 backdrop-blur rounded-xl border shadow-sm p-4">
          <h2 className="text-sm font-semibold text-gray-900 mb-3">Step 4: NDC Verification</h2>
          {Object.entries(ndcResults).map(([rxcui, ndcs]) => {
            const activeNDCs = ndcs.filter(n => n.active);
            const inactiveNDCs = ndcs.filter(n => !n.active);
            return (
              <div key={rxcui} className="space-y-3">
                <div className="text-xs text-gray-600 mb-2">RxCUI: <span className="font-mono">{rxcui}</span></div>
                {ndcs.length > 0 ? (
                  <div className="space-y-2">
                    {activeNDCs.length > 0 && (
                      <div>
                        <div className="text-xs font-medium text-green-700 mb-1">
                          Active NDCs ({activeNDCs.length}):
                        </div>
                        <div className="bg-green-50 border border-green-200 rounded p-2 max-h-40 overflow-y-auto">
                          <div className="font-mono text-[11px] text-gray-800 break-all">
                            {activeNDCs.map((n, idx) => (
                              <span key={n.ndc} className="inline-block mr-2 mb-1">
                                {n.ndc}{idx < activeNDCs.length - 1 ? "," : ""}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                    {inactiveNDCs.length > 0 && (
                      <div>
                        <div className="text-xs font-medium text-red-700 mb-1">
                          Inactive NDCs ({inactiveNDCs.length}):
                        </div>
                        <div className="bg-red-50 border border-red-200 rounded p-2 max-h-40 overflow-y-auto">
                          <div className="font-mono text-[11px] text-gray-800 break-all">
                            {inactiveNDCs.map((n, idx) => (
                              <span key={n.ndc} className="inline-block mr-2 mb-1">
                                {n.ndc}{idx < inactiveNDCs.length - 1 ? "," : ""}
                              </span>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-gray-500">No NDCs found</div>
                )}
              </div>
            );
          })}
        </section>
      )}

      {/* Step 5 & 6: Final Results - SCD and SBD */}
      {finalResult && (
        <section className="mt-6 space-y-6">
          <h2 className="text-lg font-semibold text-blue-900">Final Output</h2>
          
          {/* SCD Component (Semantic Clinical Drug - Generic) */}
          {finalResult.scd && (
            <div className="bg-green-50 border-2 border-green-300 rounded-xl shadow-sm p-4">
              <h3 className="text-sm font-semibold text-green-900 mb-3">
                SCD (Semantic Clinical Drug - Generic)
                {finalResult.scd.tty && <span className="text-gray-600 font-normal ml-2">TTY: {finalResult.scd.tty}</span>}
              </h3>
              <div className="space-y-2 text-xs">
                <div><span className="font-medium">Input:</span> <span className="font-mono">{finalResult.scd.input}</span></div>
                <div><span className="font-medium">Normalized:</span> <span className="font-mono">{finalResult.scd.normalized}</span></div>
                <div><span className="font-medium">RxCUI:</span> <span className="font-mono text-green-700">{finalResult.scd.rxcui}</span></div>
                <div><span className="font-medium">RxNorm Name:</span> <span className="font-mono">{finalResult.scd.rxnorm_name}</span></div>
                {finalResult.scd.brand && (
                  <div><span className="font-medium">Brand:</span> <span className="font-mono">{finalResult.scd.brand}</span></div>
                )}
                <div className="mt-3">
                  <span className="font-medium">Assurity Score:</span>{" "}
                  <span className="font-bold text-lg text-green-700">{finalResult.scd.assurity_score}%</span>
                </div>
                {finalResult.scd.llm_confidence !== undefined && (
                  <div>
                    <span className="font-medium">LLM Confidence:</span>{" "}
                    <span className="font-bold text-green-700">{finalResult.scd.llm_confidence}%</span>
                  </div>
                )}
                {finalResult.scd.final_confidence !== undefined && (
                  <div className="mt-2">
                    <span className="font-medium">Final Confidence:</span>{" "}
                    <span className="font-bold text-xl text-green-800">{finalResult.scd.final_confidence}%</span>
                    <div className="text-[11px] text-gray-600 mt-1">
                      (0.6 × {finalResult.scd.assurity_score}% + 0.4 × {finalResult.scd.llm_confidence}%)
                    </div>
                  </div>
                )}
                <div><span className="font-medium">Match Status:</span> <span className="text-green-700">{finalResult.scd.match_status}</span></div>
                <div className="mt-3">
                  <div className="font-medium mb-3">NDCs by Source (DailyMed vs FDA):</div>
                  {Object.keys(finalResult.scd.ndcs).length > 0 ? (
                    <div className="space-y-4">
                      {Object.entries(finalResult.scd.ndcs).map(([manufacturer, group]) => {
                        // Separate NDCs by source
                        const dailyMedActive = group.active.filter(n => n.source === "DailyMed");
                        const fdaSplActive = group.active.filter(n => n.source === "FDA (SPL)");
                        const fdaRxcuiActive = group.active.filter(n => n.source === "FDA (RxCUI)");
                        const fdaActive = [...fdaSplActive, ...fdaRxcuiActive]; // Combine FDA sources
                        const rxNormActive = group.active.filter(n => n.source === "RxNorm" || !n.source);
                        const dailyMedInactive = group.inactive.filter(n => n.source === "DailyMed");
                        const fdaSplInactive = group.inactive.filter(n => n.source === "FDA (SPL)");
                        const fdaRxcuiInactive = group.inactive.filter(n => n.source === "FDA (RxCUI)");
                        const fdaInactive = [...fdaSplInactive, ...fdaRxcuiInactive]; // Combine FDA sources
                        const rxNormInactive = group.inactive.filter(n => n.source === "RxNorm" || !n.source);
                        
                        const hasDailyMed = dailyMedActive.length > 0 || dailyMedInactive.length > 0;
                        const hasFDA = fdaActive.length > 0 || fdaInactive.length > 0;
                        const hasRxNorm = rxNormActive.length > 0 || rxNormInactive.length > 0;
                        
                        return (
                          <div key={manufacturer} className="border rounded-lg p-3 bg-white">
                            <div className="font-semibold text-sm text-gray-900 mb-3">
                              {manufacturer}
                              {group.brand_name && (
                                <span className="text-gray-600 font-normal ml-2">({group.brand_name})</span>
                              )}
                            </div>
                            
                            {/* Side-by-side DailyMed and FDA */}
                            {(hasDailyMed || hasFDA) && (
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                                {/* DailyMed Column */}
                                {hasDailyMed && (
                                  <div className="border-2 border-purple-300 rounded-lg p-3 bg-purple-50">
                                    <div className="font-semibold text-xs text-purple-900 mb-2">
                                      📋 DailyMed
                                    </div>
                                    {dailyMedActive.length > 0 && (
                                      <div className="mb-2">
                                        <div className="text-xs font-medium text-green-700 mb-1">
                                          Active ({dailyMedActive.length}):
                                        </div>
                                        <div className="bg-green-50 border border-green-200 rounded p-2 max-h-48 overflow-y-auto">
                                          <div className="space-y-1">
                                            {dailyMedActive.map((ndcInfo, idx) => (
                                              <div key={idx} className="text-[11px] border-b border-green-200 pb-2 last:border-0">
                                                <div className="font-mono text-gray-800 font-semibold">{ndcInfo.ndc}</div>
                                                <div className="text-gray-600 mt-0.5 text-[10px]">{ndcInfo.package}</div>
                                                {ndcInfo.product_ndc && (
                                                  <div className="text-gray-600 text-[10px]">Product NDC: {ndcInfo.product_ndc}</div>
                                                )}
                                                {ndcInfo.strength && (
                                                  <div className="text-gray-600 text-[10px]">Strength: {ndcInfo.strength}</div>
                                                )}
                                                {ndcInfo.count && (
                                                  <div className="text-gray-600 text-[10px]">Count: {ndcInfo.count}</div>
                                                )}
                                                {ndcInfo.product_type && (
                                                  <div className="text-gray-600 text-[10px]">Type: {ndcInfo.product_type}</div>
                                                )}
                                                {ndcInfo.route && (
                                                  <div className="text-gray-600 text-[10px]">Route: {ndcInfo.route}</div>
                                                )}
                                                {ndcInfo.dosage_form && (
                                                  <div className="text-gray-600 text-[10px]">Form: {ndcInfo.dosage_form}</div>
                                                )}
                                                {ndcInfo.spl_set_id && (
                                                  <div className="text-purple-600 text-[9px] mt-1 font-mono">SPL: {ndcInfo.spl_set_id.slice(0, 8)}...</div>
                                                )}
                                                {ndcInfo.start && (
                                                  <div className="text-gray-500 text-[9px] mt-1">
                                                    {ndcInfo.start}{ndcInfo.end ? ` - ${ndcInfo.end}` : ""}
                                                  </div>
                                                )}
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                    {dailyMedInactive.length > 0 && (
                                      <div>
                                        <div className="text-xs font-medium text-red-700 mb-1">
                                          Inactive ({dailyMedInactive.length}):
                                        </div>
                                        <div className="bg-red-50 border border-red-200 rounded p-2 max-h-32 overflow-y-auto">
                                          <div className="space-y-1">
                                            {dailyMedInactive.map((ndcInfo, idx) => (
                                              <div key={idx} className="text-[11px] border-b border-red-200 pb-1 last:border-0">
                                                <div className="font-mono text-gray-800">{ndcInfo.ndc}</div>
                                                <div className="text-gray-600 text-[10px]">{ndcInfo.package}</div>
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}
                                
                                {/* FDA Column */}
                                {hasFDA && (
                                  <div className="border-2 border-blue-300 rounded-lg p-3 bg-blue-50">
                                    <div className="font-semibold text-xs text-blue-900 mb-2">
                                      🏥 openFDA
                                    </div>
                                    {fdaActive.length > 0 && (
                                      <div className="mb-2">
                                        <div className="text-xs font-medium text-green-700 mb-1">
                                          Active ({fdaActive.length}):
                                        </div>
                                        <div className="bg-green-50 border border-green-200 rounded p-2 max-h-48 overflow-y-auto">
                                          <div className="space-y-1">
                                            {fdaActive.map((ndcInfo, idx) => (
                                              <div key={idx} className="text-[11px] border-b border-green-200 pb-2 last:border-0">
                                                <div className="flex items-center gap-2">
                                                  <div className="font-mono text-gray-800 font-semibold">{ndcInfo.ndc}</div>
                                                  {ndcInfo.source && (
                                                    <span className="text-[9px] text-blue-600 bg-blue-100 px-1 rounded">
                                                      {ndcInfo.source}
                                                    </span>
                                                  )}
                                                </div>
                                                <div className="text-gray-600 mt-0.5 text-[10px]">{ndcInfo.package}</div>
                                                {ndcInfo.product_ndc && (
                                                  <div className="text-gray-600 text-[10px]">Product NDC: {ndcInfo.product_ndc}</div>
                                                )}
                                                {ndcInfo.strength && (
                                                  <div className="text-gray-600 text-[10px]">Strength: {ndcInfo.strength}</div>
                                                )}
                                                {ndcInfo.count && (
                                                  <div className="text-gray-600 text-[10px]">Count: {ndcInfo.count}</div>
                                                )}
                                                {ndcInfo.product_type && (
                                                  <div className="text-gray-600 text-[10px]">Type: {ndcInfo.product_type}</div>
                                                )}
                                                {ndcInfo.route && (
                                                  <div className="text-gray-600 text-[10px]">Route: {ndcInfo.route}</div>
                                                )}
                                                {ndcInfo.dosage_form && (
                                                  <div className="text-gray-600 text-[10px]">Form: {ndcInfo.dosage_form}</div>
                                                )}
                                                {ndcInfo.application_number && (
                                                  <div className="text-gray-600 text-[10px]">App #: {ndcInfo.application_number}</div>
                                                )}
                                                {ndcInfo.spl_set_id && (
                                                  <div className="text-blue-600 text-[9px] mt-1 font-mono">SPL: {ndcInfo.spl_set_id.slice(0, 8)}...</div>
                                                )}
                                                {ndcInfo.start && (
                                                  <div className="text-gray-500 text-[9px] mt-1">
                                                    {ndcInfo.start}{ndcInfo.end ? ` - ${ndcInfo.end}` : ""}
                                                  </div>
                                                )}
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                    {fdaInactive.length > 0 && (
                                      <div>
                                        <div className="text-xs font-medium text-red-700 mb-1">
                                          Inactive ({fdaInactive.length}):
                                        </div>
                                        <div className="bg-red-50 border border-red-200 rounded p-2 max-h-32 overflow-y-auto">
                                          <div className="space-y-1">
                                            {fdaInactive.map((ndcInfo, idx) => (
                                              <div key={idx} className="text-[11px] border-b border-red-200 pb-1 last:border-0">
                                                <div className="font-mono text-gray-800">{ndcInfo.ndc}</div>
                                                <div className="text-gray-600 text-[10px]">{ndcInfo.package}</div>
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                            
                            {/* RxNorm (if exists) */}
                            {hasRxNorm && (
                              <div className="border rounded-lg p-3 bg-gray-50">
                                <div className="font-semibold text-xs text-gray-700 mb-2">
                                  🔄 RxNorm Fallback
                                </div>
                                {rxNormActive.length > 0 && (
                                  <div className="mb-2">
                                    <div className="text-xs font-medium text-green-700 mb-1">
                                      Active ({rxNormActive.length}):
                                    </div>
                                    <div className="bg-green-50 border border-green-200 rounded p-2 max-h-40 overflow-y-auto">
                                      <div className="font-mono text-[11px] text-gray-800 break-all">
                                        {rxNormActive.map((n, idx) => (
                                          <span key={idx} className="inline-block mr-2 mb-1">{n.ndc}{idx < rxNormActive.length - 1 ? "," : ""}</span>
                                        ))}
                                      </div>
                                    </div>
                                  </div>
                                )}
                                {rxNormInactive.length > 0 && (
                                  <div>
                                    <div className="text-xs font-medium text-red-700 mb-1">
                                      Inactive ({rxNormInactive.length}):
                                    </div>
                                    <div className="bg-red-50 border border-red-200 rounded p-2 max-h-32 overflow-y-auto">
                                      <div className="font-mono text-[11px] text-gray-800 break-all">
                                        {rxNormInactive.map((n, idx) => (
                                          <span key={idx} className="inline-block mr-2 mb-1">{n.ndc}{idx < rxNormInactive.length - 1 ? "," : ""}</span>
                                        ))}
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-500">No NDCs found</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* SBD Component (Semantic Branded Drug - Branded) */}
          {finalResult.sbd && (
            <div className="bg-blue-50 border-2 border-blue-300 rounded-xl shadow-sm p-4">
              <h3 className="text-sm font-semibold text-blue-900 mb-3">
                SBD (Semantic Branded Drug - Branded)
                {finalResult.sbd.tty && <span className="text-gray-600 font-normal ml-2">TTY: {finalResult.sbd.tty}</span>}
              </h3>
              <div className="space-y-2 text-xs">
                <div><span className="font-medium">Input:</span> <span className="font-mono">{finalResult.sbd.input}</span></div>
                <div><span className="font-medium">Normalized:</span> <span className="font-mono">{finalResult.sbd.normalized}</span></div>
                <div><span className="font-medium">RxCUI:</span> <span className="font-mono text-blue-700">{finalResult.sbd.rxcui}</span></div>
                <div><span className="font-medium">RxNorm Name:</span> <span className="font-mono">{finalResult.sbd.rxnorm_name}</span></div>
                {finalResult.sbd.brand && (
                  <div><span className="font-medium">Brand:</span> <span className="font-mono">{finalResult.sbd.brand}</span></div>
                )}
                <div className="mt-3">
                  <span className="font-medium">Assurity Score:</span>{" "}
                  <span className="font-bold text-lg text-blue-700">{finalResult.sbd.assurity_score}%</span>
                </div>
                {finalResult.sbd.llm_confidence !== undefined && (
                  <div>
                    <span className="font-medium">LLM Confidence:</span>{" "}
                    <span className="font-bold text-blue-700">{finalResult.sbd.llm_confidence}%</span>
                  </div>
                )}
                {finalResult.sbd.final_confidence !== undefined && (
                  <div className="mt-2">
                    <span className="font-medium">Final Confidence:</span>{" "}
                    <span className="font-bold text-xl text-blue-800">{finalResult.sbd.final_confidence}%</span>
                    <div className="text-[11px] text-gray-600 mt-1">
                      (0.6 × {finalResult.sbd.assurity_score}% + 0.4 × {finalResult.sbd.llm_confidence}%)
                    </div>
                  </div>
                )}
                <div><span className="font-medium">Match Status:</span> <span className="text-blue-700">{finalResult.sbd.match_status}</span></div>
                <div className="mt-3">
                  <div className="font-medium mb-3">NDCs by Source (DailyMed vs FDA):</div>
                  {Object.keys(finalResult.sbd.ndcs).length > 0 ? (
                    <div className="space-y-4">
                      {Object.entries(finalResult.sbd.ndcs).map(([manufacturer, group]) => {
                        // Separate NDCs by source
                        const dailyMedActive = group.active.filter(n => n.source === "DailyMed");
                        const fdaSplActive = group.active.filter(n => n.source === "FDA (SPL)");
                        const fdaRxcuiActive = group.active.filter(n => n.source === "FDA (RxCUI)");
                        const fdaActive = [...fdaSplActive, ...fdaRxcuiActive]; // Combine FDA sources
                        const rxNormActive = group.active.filter(n => n.source === "RxNorm" || !n.source);
                        const dailyMedInactive = group.inactive.filter(n => n.source === "DailyMed");
                        const fdaSplInactive = group.inactive.filter(n => n.source === "FDA (SPL)");
                        const fdaRxcuiInactive = group.inactive.filter(n => n.source === "FDA (RxCUI)");
                        const fdaInactive = [...fdaSplInactive, ...fdaRxcuiInactive]; // Combine FDA sources
                        const rxNormInactive = group.inactive.filter(n => n.source === "RxNorm" || !n.source);
                        
                        const hasDailyMed = dailyMedActive.length > 0 || dailyMedInactive.length > 0;
                        const hasFDA = fdaActive.length > 0 || fdaInactive.length > 0;
                        const hasRxNorm = rxNormActive.length > 0 || rxNormInactive.length > 0;
                        
                        return (
                          <div key={manufacturer} className="border rounded-lg p-3 bg-white">
                            <div className="font-semibold text-sm text-gray-900 mb-3">
                              {manufacturer}
                              {group.brand_name && (
                                <span className="text-gray-600 font-normal ml-2">({group.brand_name})</span>
                              )}
                            </div>
                            
                            {/* Side-by-side DailyMed and FDA */}
                            {(hasDailyMed || hasFDA) && (
                              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                                {/* DailyMed Column */}
                                {hasDailyMed && (
                                  <div className="border-2 border-purple-300 rounded-lg p-3 bg-purple-50">
                                    <div className="font-semibold text-xs text-purple-900 mb-2">
                                      📋 DailyMed
                                    </div>
                                    {dailyMedActive.length > 0 && (
                                      <div className="mb-2">
                                        <div className="text-xs font-medium text-green-700 mb-1">
                                          Active ({dailyMedActive.length}):
                                        </div>
                                        <div className="bg-green-50 border border-green-200 rounded p-2 max-h-48 overflow-y-auto">
                                          <div className="space-y-1">
                                            {dailyMedActive.map((ndcInfo, idx) => (
                                              <div key={idx} className="text-[11px] border-b border-green-200 pb-2 last:border-0">
                                                <div className="font-mono text-gray-800 font-semibold">{ndcInfo.ndc}</div>
                                                <div className="text-gray-600 mt-0.5 text-[10px]">{ndcInfo.package}</div>
                                                {ndcInfo.product_ndc && (
                                                  <div className="text-gray-600 text-[10px]">Product NDC: {ndcInfo.product_ndc}</div>
                                                )}
                                                {ndcInfo.strength && (
                                                  <div className="text-gray-600 text-[10px]">Strength: {ndcInfo.strength}</div>
                                                )}
                                                {ndcInfo.count && (
                                                  <div className="text-gray-600 text-[10px]">Count: {ndcInfo.count}</div>
                                                )}
                                                {ndcInfo.product_type && (
                                                  <div className="text-gray-600 text-[10px]">Type: {ndcInfo.product_type}</div>
                                                )}
                                                {ndcInfo.route && (
                                                  <div className="text-gray-600 text-[10px]">Route: {ndcInfo.route}</div>
                                                )}
                                                {ndcInfo.dosage_form && (
                                                  <div className="text-gray-600 text-[10px]">Form: {ndcInfo.dosage_form}</div>
                                                )}
                                                {ndcInfo.spl_set_id && (
                                                  <div className="text-purple-600 text-[9px] mt-1 font-mono">SPL: {ndcInfo.spl_set_id.slice(0, 8)}...</div>
                                                )}
                                                {ndcInfo.start && (
                                                  <div className="text-gray-500 text-[9px] mt-1">
                                                    {ndcInfo.start}{ndcInfo.end ? ` - ${ndcInfo.end}` : ""}
                                                  </div>
                                                )}
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                    {dailyMedInactive.length > 0 && (
                                      <div>
                                        <div className="text-xs font-medium text-red-700 mb-1">
                                          Inactive ({dailyMedInactive.length}):
                                        </div>
                                        <div className="bg-red-50 border border-red-200 rounded p-2 max-h-32 overflow-y-auto">
                                          <div className="space-y-1">
                                            {dailyMedInactive.map((ndcInfo, idx) => (
                                              <div key={idx} className="text-[11px] border-b border-red-200 pb-1 last:border-0">
                                                <div className="font-mono text-gray-800">{ndcInfo.ndc}</div>
                                                <div className="text-gray-600 text-[10px]">{ndcInfo.package}</div>
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}
                                
                                {/* FDA Column */}
                                {hasFDA && (
                                  <div className="border-2 border-blue-300 rounded-lg p-3 bg-blue-50">
                                    <div className="font-semibold text-xs text-blue-900 mb-2">
                                      🏥 openFDA
                                    </div>
                                    {fdaActive.length > 0 && (
                                      <div className="mb-2">
                                        <div className="text-xs font-medium text-green-700 mb-1">
                                          Active ({fdaActive.length}):
                                        </div>
                                        <div className="bg-green-50 border border-green-200 rounded p-2 max-h-48 overflow-y-auto">
                                          <div className="space-y-1">
                                            {fdaActive.map((ndcInfo, idx) => (
                                              <div key={idx} className="text-[11px] border-b border-green-200 pb-2 last:border-0">
                                                <div className="flex items-center gap-2">
                                                  <div className="font-mono text-gray-800 font-semibold">{ndcInfo.ndc}</div>
                                                  {ndcInfo.source && (
                                                    <span className="text-[9px] text-blue-600 bg-blue-100 px-1 rounded">
                                                      {ndcInfo.source}
                                                    </span>
                                                  )}
                                                </div>
                                                <div className="text-gray-600 mt-0.5 text-[10px]">{ndcInfo.package}</div>
                                                {ndcInfo.product_ndc && (
                                                  <div className="text-gray-600 text-[10px]">Product NDC: {ndcInfo.product_ndc}</div>
                                                )}
                                                {ndcInfo.strength && (
                                                  <div className="text-gray-600 text-[10px]">Strength: {ndcInfo.strength}</div>
                                                )}
                                                {ndcInfo.count && (
                                                  <div className="text-gray-600 text-[10px]">Count: {ndcInfo.count}</div>
                                                )}
                                                {ndcInfo.product_type && (
                                                  <div className="text-gray-600 text-[10px]">Type: {ndcInfo.product_type}</div>
                                                )}
                                                {ndcInfo.route && (
                                                  <div className="text-gray-600 text-[10px]">Route: {ndcInfo.route}</div>
                                                )}
                                                {ndcInfo.dosage_form && (
                                                  <div className="text-gray-600 text-[10px]">Form: {ndcInfo.dosage_form}</div>
                                                )}
                                                {ndcInfo.application_number && (
                                                  <div className="text-gray-600 text-[10px]">App #: {ndcInfo.application_number}</div>
                                                )}
                                                {ndcInfo.spl_set_id && (
                                                  <div className="text-blue-600 text-[9px] mt-1 font-mono">SPL: {ndcInfo.spl_set_id.slice(0, 8)}...</div>
                                                )}
                                                {ndcInfo.start && (
                                                  <div className="text-gray-500 text-[9px] mt-1">
                                                    {ndcInfo.start}{ndcInfo.end ? ` - ${ndcInfo.end}` : ""}
                                                  </div>
                                                )}
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                    {fdaInactive.length > 0 && (
                                      <div>
                                        <div className="text-xs font-medium text-red-700 mb-1">
                                          Inactive ({fdaInactive.length}):
                                        </div>
                                        <div className="bg-red-50 border border-red-200 rounded p-2 max-h-32 overflow-y-auto">
                                          <div className="space-y-1">
                                            {fdaInactive.map((ndcInfo, idx) => (
                                              <div key={idx} className="text-[11px] border-b border-red-200 pb-1 last:border-0">
                                                <div className="font-mono text-gray-800">{ndcInfo.ndc}</div>
                                                <div className="text-gray-600 text-[10px]">{ndcInfo.package}</div>
                                              </div>
                                            ))}
                                          </div>
                                        </div>
                                      </div>
                                    )}
                                  </div>
                                )}
                              </div>
                            )}
                            
                            {/* RxNorm (if exists) */}
                            {hasRxNorm && (
                              <div className="border rounded-lg p-3 bg-gray-50">
                                <div className="font-semibold text-xs text-gray-700 mb-2">
                                  🔄 RxNorm Fallback
                                </div>
                                {rxNormActive.length > 0 && (
                                  <div className="mb-2">
                                    <div className="text-xs font-medium text-green-700 mb-1">
                                      Active ({rxNormActive.length}):
                                    </div>
                                    <div className="bg-green-50 border border-green-200 rounded p-2 max-h-40 overflow-y-auto">
                                      <div className="font-mono text-[11px] text-gray-800 break-all">
                                        {rxNormActive.map((n, idx) => (
                                          <span key={idx} className="inline-block mr-2 mb-1">{n.ndc}{idx < rxNormActive.length - 1 ? "," : ""}</span>
                                        ))}
                                      </div>
                                    </div>
                                  </div>
                                )}
                                {rxNormInactive.length > 0 && (
                                  <div>
                                    <div className="text-xs font-medium text-red-700 mb-1">
                                      Inactive ({rxNormInactive.length}):
                                    </div>
                                    <div className="bg-red-50 border border-red-200 rounded p-2 max-h-32 overflow-y-auto">
                                      <div className="font-mono text-[11px] text-gray-800 break-all">
                                        {rxNormInactive.map((n, idx) => (
                                          <span key={idx} className="inline-block mr-2 mb-1">{n.ndc}{idx < rxNormInactive.length - 1 ? "," : ""}</span>
                                        ))}
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="text-xs text-gray-500">No NDCs found</div>
                  )}
                </div>
              </div>
            </div>
          )}

          {!finalResult.scd && !finalResult.sbd && (
            <div className="text-sm text-gray-500">No SCD or SBD results available</div>
          )}
        </section>
      )}
    </main>
  );
}
