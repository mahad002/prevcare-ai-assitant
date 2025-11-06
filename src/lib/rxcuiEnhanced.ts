/**
 * Enhanced RxCUI lookup with multiple strategies and detailed failure tracking
 */

import { callOpenAIRaw } from './api';
import { compareMedicationNamesPrompt } from './prompts';

export type RxCuiLookupResult = {
  rxcui: string | null; // Most specific RxCUI found
  groupRxCui: string | null; // Ingredient-level RxCUI (group)
  strategy: string;
  searchTerm: string;
  apiResponse: any;
  error?: string;
  attempts: Array<{
    strategy: string;
    searchTerm: string;
    success: boolean;
    rxcui?: string;
    error?: string;
    apiResponse?: any;
  }>;
};

/**
 * Enhanced RxCUI lookup that tries multiple strategies and formats
 */
export async function getRxCuiEnhanced(
  originalName: string,
  normalizedName?: string | null
): Promise<RxCuiLookupResult> {
  const attempts: RxCuiLookupResult['attempts'] = [];
  const searchTerms: string[] = [];

  // Collect all possible search terms
  const baseName = normalizedName || originalName;
  const trimmed = baseName.trim();

  // Strategy 1: Use normalized/input name as-is
  searchTerms.push(trimmed);

  // Strategy 2: Remove brand names in brackets [Brand]
  const withoutBrand = trimmed.replace(/\s*\[[^\]]+\]\s*$/, '').trim();
  if (withoutBrand !== trimmed) {
    searchTerms.push(withoutBrand);
  }

  // Strategy 3: Reorder to RxNorm format if needed
  // Original format might be: "500 MG paracetamol [Panadol]"
  // RxNorm format: "Paracetamol 500 MG Oral Tablet"
  const reordered = tryReorderToRxNormFormat(trimmed);
  if (reordered && reordered !== trimmed && reordered !== withoutBrand) {
    searchTerms.push(reordered);
  }

  // Strategy 4: Remove "Oral" if present
  const withoutOral = trimmed.replace(/\bOral\s+/i, '').trim();
  if (withoutOral !== trimmed && !searchTerms.includes(withoutOral)) {
    searchTerms.push(withoutOral);
  }

  // Strategy 5: Extract ingredient only (first word before numbers)
  const ingredientOnly = extractIngredient(trimmed);
  if (ingredientOnly && ingredientOnly !== trimmed && !searchTerms.includes(ingredientOnly)) {
    searchTerms.push(ingredientOnly);
  }

  // Strategy 6: Try with common dosage forms
  const withDosageForms = tryAddDosageForms(trimmed);
  for (const form of withDosageForms) {
    if (!searchTerms.includes(form)) {
      searchTerms.push(form);
    }
  }

  let groupRxCui: string | null = null; // Ingredient-level RxCUI
  let bestSpecificRxCui: string | null = null; // Most specific RxCUI found
  let bestStrategy = '';
  let bestSearchTerm = '';
  let bestApiResponse: any = null;
  let bestScore = 0;

  // Try each search term
  for (const searchTerm of searchTerms) {
    try {
      // Try exact match
      const exactRes = await fetch(
        `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(searchTerm)}`
      );
      
      let exactApiResponse: any = null;
      if (exactRes.ok) {
        exactApiResponse = await exactRes.json();
        const exactRxCui = exactApiResponse?.idGroup?.rxnormId?.[0];
        if (exactRxCui) {
          const rxcuiStr = String(exactRxCui);
          
          // Check if this is ingredient-level (we'll verify with properties later)
          // For now, store as potential group RxCUI
          if (!groupRxCui) {
            groupRxCui = rxcuiStr;
          }

          // Also try approximateTerm to find more specific matches
          // This is important because exact match might return ingredient-level (e.g., 723)
          // but approximateTerm might have the specific product (e.g., 313797 for "amoxicillin 125 MG/5 ML")
          try {
            const approxRes = await fetch(
              `https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=${encodeURIComponent(searchTerm)}&maxEntries=20`
            );
            
            if (approxRes.ok) {
              const approxJson = await approxRes.json();
              const candidates = approxJson?.approximateGroup?.candidate || [];
              
              // Find the best match from approximateTerm
              // Algorithm:
              // 1. Filter out ingredient-level matches (IN, MIN)
              // 2. Prioritize: RxNorm sources, TTY hierarchy (SBD > SCD > GPCK > BPCK > PIN), strength matching
              // 3. Use LLM for semantic name comparison for top candidates
              
              // Extract strength from input
              const inputStrength = extractStrength(searchTerm);
              
              // Step 1: Filter and collect valid candidates (not ingredients, with strength match if input has strength)
              const validCandidates: Array<{
                candidate: any;
                rxcui: string;
                score: number;
                name: string;
                source: string;
                tty: string | null;
                propertiesName: string | null;
                candidateStrength: { value: number; unit: string } | null;
              }> = [];
              
              for (const candidate of candidates) {
                const candidateRxCui = candidate?.rxcui ? String(candidate.rxcui) : null;
                const score = candidate?.score ? parseFloat(String(candidate.score)) : 0;
                const name = candidate?.name || '';
                const source = candidate?.source || '';
                
                if (!candidateRxCui || score <= 5) continue; // Minimum score threshold
                
                // Extract strength from candidate name
                const candidateStrength = extractStrength(name);
                
                // CRITICAL: If input has strength, candidate MUST match it exactly
                if (inputStrength) {
                  if (!candidateStrength) {
                    continue; // Skip - input has strength but candidate doesn't
                  }
                  if (!strengthsMatch(inputStrength, candidateStrength)) {
                    continue; // Skip - strengths don't match
                  }
                }
                
                // Fetch TTY and properties for this candidate
                let tty = candidate.tty;
                let propertiesName: string | null = null;
                
                try {
                  const propsRes = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${candidateRxCui}/properties.json`);
                  if (propsRes.ok) {
                    const props = await propsRes.json();
                    if (!tty) {
                      tty = props?.properties?.tty;
                    }
                    if (!propertiesName) {
                      propertiesName = props?.properties?.name || null;
                    }
                  }
                } catch (e) {
                  // Ignore errors fetching properties
                }
                
                // FILTER OUT ingredient-level matches (IN, MIN)
                if (isIngredientTTY(tty)) {
                  continue; // Skip ingredients - we want specific drug forms
                }
                
                validCandidates.push({
                  candidate,
                  rxcui: candidateRxCui,
                  score,
                  name,
                  source,
                  tty: tty || null,
                  propertiesName,
                  candidateStrength,
                });
              }
              
              // Step 2: Sort by initial priority (RxNorm source, TTY, score)
              validCandidates.sort((a, b) => {
                const aIsRxNorm = a.source === 'RXNORM';
                const bIsRxNorm = b.source === 'RXNORM';
                
                // Prefer RxNorm sources
                if (aIsRxNorm && !bIsRxNorm) return -1;
                if (!aIsRxNorm && bIsRxNorm) return 1;
                
                // Then by TTY priority
                const aTTYScore = a.tty ? (ttyPriority[a.tty] || 0) : 0;
                const bTTYScore = b.tty ? (ttyPriority[b.tty] || 0) : 0;
                if (aTTYScore !== bTTYScore) {
                  return bTTYScore - aTTYScore; // Higher TTY priority first
                }
                
                // Then by API score
                return b.score - a.score;
              });
              
              // Step 3: Use LLM to compare top candidates semantically
              // Take top 5 candidates and use LLM to find the best semantic match
              const topCandidates = validCandidates.slice(0, 5);
              let bestCandidate: any = null;
              let bestCandidateScore = 0;
              let bestLLMMatchScore = 0;
              
              for (const validCandidate of topCandidates) {
                const candidateName = validCandidate.propertiesName || validCandidate.name;
                const isRxNorm = validCandidate.source === 'RXNORM';
                
                // Calculate base preference score
                let preferenceScore = validCandidate.score;
                if (isRxNorm) {
                  preferenceScore += 20; // Big boost for RxNorm sources
                }
                
                const ttyPriorityScore = validCandidate.tty ? (ttyPriority[validCandidate.tty] || 0) : 0;
                preferenceScore += ttyPriorityScore * 3; // TTY priority (multiply by 3 for significant weight)
                
                if (inputStrength && validCandidate.candidateStrength && 
                    strengthsMatch(inputStrength, validCandidate.candidateStrength)) {
                  preferenceScore += 15; // Big boost for exact strength match
                }
                
                // Use LLM for semantic name comparison
                let llmMatchScore = 0;
                try {
                  const llmPrompt = compareMedicationNamesPrompt(searchTerm, candidateName);
                  const llmResult = await callOpenAIRaw('gpt-4o', llmPrompt);
                  const parsed = llmResult?.parsed as any;
                  
                  if (parsed && typeof parsed.matchScore === 'number') {
                    llmMatchScore = parsed.matchScore;
                    // If LLM says it's a match (matchScore >= 80), boost significantly
                    if (parsed.match === true && llmMatchScore >= 80) {
                      preferenceScore += llmMatchScore * 0.4; // Add 0-40 points based on LLM match score
                      if (llmMatchScore >= 95) {
                        preferenceScore += 20; // Extra boost for near-perfect LLM match
                      }
                    }
                  }
                } catch (e) {
                  // If LLM fails, fall back to basic name matching
                  const inputNorm = normalizeForMatch(searchTerm);
                  const candidateNorm = normalizeForMatch(candidateName);
                  
                  if (inputNorm === candidateNorm) {
                    llmMatchScore = 100;
                    preferenceScore += 30;
                  } else if (inputNorm.includes(candidateNorm) || candidateNorm.includes(inputNorm)) {
                    llmMatchScore = 80;
                    preferenceScore += 15;
                  }
                }
                
                // If this candidate is better
                if (preferenceScore > bestCandidateScore || 
                    (preferenceScore === bestCandidateScore && llmMatchScore > bestLLMMatchScore)) {
                  bestCandidate = validCandidate.candidate;
                  bestCandidate.tty = validCandidate.tty;
                  bestCandidate.propertiesName = validCandidate.propertiesName;
                  bestCandidate.llmMatchScore = llmMatchScore;
                  bestCandidateScore = preferenceScore;
                  bestLLMMatchScore = llmMatchScore;
                }
              }
              
              // If no LLM-validated candidate found, use the top candidate by priority
              if (!bestCandidate && validCandidates.length > 0) {
                const topCandidate = validCandidates[0];
                bestCandidate = topCandidate.candidate;
                bestCandidate.tty = topCandidate.tty;
                bestCandidate.propertiesName = topCandidate.propertiesName;
                bestCandidateScore = topCandidate.score;
              }
              
              // If we found a good candidate from approximateTerm, use it as the specific RxCUI
              // Keep the exact match as groupRxCui (ingredient level)
              if (bestCandidate && bestCandidateScore > 5) {
                bestSpecificRxCui = String(bestCandidate.rxcui);
                bestScore = bestCandidateScore;
                bestStrategy = `approximate: ${searchTerm}`;
                bestSearchTerm = searchTerm;
                bestApiResponse = {
                  exact: exactApiResponse,
                  approximate: approxJson,
                  selectedCandidate: bestCandidate,
                };
                
                attempts.push({
                  strategy: 'exact',
                  searchTerm,
                  success: true,
                  rxcui: rxcuiStr,
                  apiResponse: exactApiResponse,
                });
                attempts.push({
                  strategy: 'approximate',
                  searchTerm,
                  success: true,
                  rxcui: bestSpecificRxCui,
                  apiResponse: approxJson,
                });
                
                // Return immediately with the best specific match
                return {
                  rxcui: bestSpecificRxCui,
                  groupRxCui: groupRxCui,
                  strategy: bestStrategy,
                  searchTerm: bestSearchTerm,
                  apiResponse: bestApiResponse,
                  attempts,
                };
              }
            }
          } catch (approxError) {
            // Continue if approximateTerm fails
          }

          // If no better match found from approximateTerm, check if exact match is ingredient-level
          // If it is, we should NOT use it as the specific RxCUI - keep looking
          if (!bestSpecificRxCui) {
            // Check if the exact match RxCUI is likely an ingredient (IN) by checking TTY
            let isIngredient = false;
            try {
              const propsRes = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcuiStr}/properties.json`);
              if (propsRes.ok) {
                const props = await propsRes.json();
                const tty = props?.properties?.tty;
                if (tty === 'IN' || tty === 'MIN') {
                  isIngredient = true;
                }
              }
            } catch (e) {
              // If we can't check, assume it might be ingredient if it's a common ingredient RxCUI
              // Common ingredient RxCUIs are typically low numbers (e.g., 723 for amoxicillin)
              // But we'll be conservative and only skip if we're sure
            }
            
            // Only use exact match as specific if it's NOT an ingredient
            // If it's an ingredient, we'll keep looking in other search terms
            if (!isIngredient) {
              bestSpecificRxCui = rxcuiStr;
              bestStrategy = `exact: ${searchTerm}`;
              bestSearchTerm = searchTerm;
              bestApiResponse = exactApiResponse;
            } else {
              // It's an ingredient - store as groupRxCui but don't use as specific
              // Continue to next search term to find a more specific match
            }
          }

          attempts.push({
            strategy: 'exact',
            searchTerm,
            success: true,
            rxcui: rxcuiStr,
            apiResponse: exactApiResponse,
          });
          
          // If we found a specific RxCUI (not ingredient), return it
          if (bestSpecificRxCui && bestSpecificRxCui !== groupRxCui) {
            return {
              rxcui: bestSpecificRxCui,
              groupRxCui: groupRxCui,
              strategy: bestStrategy,
              searchTerm: bestSearchTerm,
              apiResponse: bestApiResponse,
              attempts,
            };
          }
          
          // Otherwise continue to next search term to find a more specific match
        }
      }

      if (!exactRes.ok || !exactApiResponse) {
        attempts.push({
          strategy: 'exact',
          searchTerm,
          success: false,
          error: exactRes.ok ? 'No RxCUI in response' : `HTTP ${exactRes.status}`,
          apiResponse: exactRes.ok ? (exactApiResponse || {}) : { error: `HTTP ${exactRes.status}` },
        });
      } else {
        attempts.push({
          strategy: 'exact',
          searchTerm,
          success: false,
          apiResponse: exactApiResponse,
        });
      }
    } catch (error) {
      attempts.push({
        strategy: 'exact',
        searchTerm,
        success: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // If we found a match, return it
  if (bestSpecificRxCui) {
    return {
      rxcui: bestSpecificRxCui,
      groupRxCui: groupRxCui,
      strategy: bestStrategy,
      searchTerm: bestSearchTerm,
      apiResponse: bestApiResponse,
      attempts,
    };
  }

  // Try approximate match as last resort (only if we haven't found a match yet)
  if (!bestSpecificRxCui) {
    const baseInputStrength = extractStrength(trimmed); // Use original input strength
    
    for (const searchTerm of searchTerms.slice(0, 3)) { // Limit to first 3 to avoid too many requests
      try {
        const approxRes = await fetch(
          `https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=${encodeURIComponent(searchTerm)}&maxEntries=20`
        );
        
        if (approxRes.ok) {
          const approxJson = await approxRes.json();
          const candidates = approxJson?.approximateGroup?.candidate || [];
          
          // Use the same filtering and LLM comparison logic as above
          const validCandidates: Array<{
            candidate: any;
            rxcui: string;
            score: number;
            name: string;
            source: string;
            tty: string | null;
            propertiesName: string | null;
            candidateStrength: { value: number; unit: string } | null;
          }> = [];
          
          for (const candidate of candidates) {
            const candidateRxCui = candidate?.rxcui ? String(candidate.rxcui) : null;
            const score = candidate?.score ? parseFloat(String(candidate.score)) : 0;
            const name = candidate?.name || '';
            const source = candidate?.source || '';
            
            if (!candidateRxCui || score <= 5) continue;
            
            const candidateStrength = extractStrength(name);
            
            if (baseInputStrength) {
              if (!candidateStrength || !strengthsMatch(baseInputStrength, candidateStrength)) {
                continue;
              }
            }
            
            let tty = candidate.tty;
            let propertiesName: string | null = null;
            
            try {
              const propsRes = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${candidateRxCui}/properties.json`);
              if (propsRes.ok) {
                const props = await propsRes.json();
                if (!tty) tty = props?.properties?.tty;
                if (!propertiesName) propertiesName = props?.properties?.name || null;
              }
            } catch (e) {
              // Ignore errors
            }
            
            // Filter out ingredients
            if (isIngredientTTY(tty)) continue;
            
            validCandidates.push({
              candidate,
              rxcui: candidateRxCui,
              score,
              name,
              source,
              tty: tty || null,
              propertiesName,
              candidateStrength,
            });
          }
          
          // Sort by priority
          validCandidates.sort((a, b) => {
            const aIsRxNorm = a.source === 'RXNORM';
            const bIsRxNorm = b.source === 'RXNORM';
            if (aIsRxNorm && !bIsRxNorm) return -1;
            if (!aIsRxNorm && bIsRxNorm) return 1;
            const aTTYScore = a.tty ? (ttyPriority[a.tty] || 0) : 0;
            const bTTYScore = b.tty ? (ttyPriority[b.tty] || 0) : 0;
            if (aTTYScore !== bTTYScore) return bTTYScore - aTTYScore;
            return b.score - a.score;
          });
          
          // Use LLM for top candidates
          const topCandidates = validCandidates.slice(0, 5);
          let bestCandidate: any = null;
          let bestCandidateScore = 0;
          let bestLLMMatchScore = 0;
          
          for (const validCandidate of topCandidates) {
            const candidateName = validCandidate.propertiesName || validCandidate.name;
            const isRxNorm = validCandidate.source === 'RXNORM';
            
            let preferenceScore = validCandidate.score;
            if (isRxNorm) preferenceScore += 20;
            
            const ttyPriorityScore = validCandidate.tty ? (ttyPriority[validCandidate.tty] || 0) : 0;
            preferenceScore += ttyPriorityScore * 3;
            
            if (baseInputStrength && validCandidate.candidateStrength && 
                strengthsMatch(baseInputStrength, validCandidate.candidateStrength)) {
              preferenceScore += 15;
            }
            
            let llmMatchScore = 0;
            try {
              const llmPrompt = compareMedicationNamesPrompt(searchTerm, candidateName);
              const llmResult = await callOpenAIRaw('gpt-4o', llmPrompt);
              const parsed = llmResult?.parsed as any;
              
              if (parsed && typeof parsed.matchScore === 'number') {
                llmMatchScore = parsed.matchScore;
                if (parsed.match === true && llmMatchScore >= 80) {
                  preferenceScore += llmMatchScore * 0.4;
                  if (llmMatchScore >= 95) preferenceScore += 20;
                }
              }
            } catch (e) {
              const inputNorm = normalizeForMatch(searchTerm);
              const candidateNorm = normalizeForMatch(candidateName);
              if (inputNorm === candidateNorm) {
                llmMatchScore = 100;
                preferenceScore += 30;
              } else if (inputNorm.includes(candidateNorm) || candidateNorm.includes(inputNorm)) {
                llmMatchScore = 80;
                preferenceScore += 15;
              }
            }
            
            if (preferenceScore > bestCandidateScore || 
                (preferenceScore === bestCandidateScore && llmMatchScore > bestLLMMatchScore)) {
              bestCandidate = validCandidate.candidate;
              bestCandidate.tty = validCandidate.tty;
              bestCandidate.propertiesName = validCandidate.propertiesName;
              bestCandidate.llmMatchScore = llmMatchScore;
              bestCandidateScore = preferenceScore;
              bestLLMMatchScore = llmMatchScore;
            }
          }
          
          if (bestCandidate) {
            bestSpecificRxCui = String(bestCandidate.rxcui);
            bestScore = bestCandidateScore;
            bestStrategy = `approximate: ${searchTerm}`;
            bestSearchTerm = searchTerm;
            bestApiResponse = {
              approximate: approxJson,
              selectedCandidate: bestCandidate,
            };
          }
          
          if (bestSpecificRxCui) {
            attempts.push({
              strategy: 'approximate',
              searchTerm,
              success: true,
              rxcui: bestSpecificRxCui,
              apiResponse: approxJson,
            });
            return {
              rxcui: bestSpecificRxCui,
              groupRxCui: groupRxCui,
              strategy: bestStrategy,
              searchTerm: bestSearchTerm,
              apiResponse: bestApiResponse,
              attempts,
            };
          }
          
          attempts.push({
            strategy: 'approximate',
            searchTerm,
            success: false,
            apiResponse: approxJson,
          });
        }
      } catch (error) {
        attempts.push({
          strategy: 'approximate',
          searchTerm,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  // All attempts failed
  return {
    rxcui: null,
    groupRxCui: groupRxCui,
    strategy: 'none',
    searchTerm: trimmed,
    apiResponse: null,
    error: `No RxCUI found after ${attempts.length} attempts`,
    attempts,
  };
}

/**
 * Try to reorder medication name to RxNorm format
 * Input: "500 MG paracetamol [Panadol]"
 * Output: "Paracetamol 500 MG" (without brand)
 */
function tryReorderToRxNormFormat(name: string): string | null {
  // Remove brand name
  let cleaned = name.replace(/\s*\[[^\]]+\]\s*$/, '').trim();
  
  // Pattern: "500 MG paracetamol" -> "Paracetamol 500 MG"
  const strengthFirstPattern = /^(\d+(?:\.\d+)?)\s*(MG|MCG|G|ML|IU|ACTUATE)\s+(.+)$/i;
  const match = cleaned.match(strengthFirstPattern);
  
  if (match) {
    const [, strength, unit, ingredient] = match;
    return `${capitalizeFirst(ingredient.trim())} ${strength} ${unit.toUpperCase()}`;
  }
  
  // Pattern: "250 ML amoxicillin 125 MG/5 ML" -> "Amoxicillin 125 MG/5 ML"
  const volumeFirstPattern = /^(\d+(?:\.\d+)?)\s*(ML)\s+(.+)$/i;
  const volumeMatch = cleaned.match(volumeFirstPattern);
  
  if (volumeMatch) {
    const [, , , rest] = volumeMatch;
    // If rest contains concentration, keep it
    if (rest.includes('/')) {
      return capitalizeFirst(rest);
    }
  }
  
  return null;
}

/**
 * Extract ingredient name (first word before any numbers)
 */
function extractIngredient(name: string): string | null {
  // Remove brand
  let cleaned = name.replace(/\s*\[[^\]]+\]\s*$/, '').trim();
  
  // Find first word that's not a number/unit
  const words = cleaned.split(/\s+/);
  for (const word of words) {
    if (!/^\d+(?:\.\d+)?$/.test(word) && !/^(MG|MCG|G|ML|IU|ACTUATE)$/i.test(word)) {
      return capitalizeFirst(word);
    }
  }
  
  // Fallback: first word before any number
  const beforeNumber = cleaned.split(/\d/)[0].trim();
  if (beforeNumber) {
    return capitalizeFirst(beforeNumber);
  }
  
  return null;
}

/**
 * Try adding common dosage forms
 */
function tryAddDosageForms(name: string): string[] {
  const forms: string[] = [];
  const cleaned = name.replace(/\s*\[[^\]]+\]\s*$/, '').trim();
  
  // Check if it already has a dosage form
  const hasForm = /\b(tablet|capsule|solution|suspension|injection|cream|ointment|spray|patch|oral)\b/i.test(cleaned);
  
  if (!hasForm) {
    // Try adding common forms
    const commonForms = ['Oral Tablet', 'Oral Capsule', 'Tablet', 'Capsule'];
    for (const form of commonForms) {
      forms.push(`${cleaned} ${form}`);
    }
  }
  
  return forms;
}

/**
 * Capitalize first letter of each word
 */
function capitalizeFirst(str: string): string {
  return str
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Extract strength (value and unit) from a string.
 * Handles formats like:
 * - "250 MG" -> { value: 250, unit: "MG" }
 * - "125 MG/5 ML" -> { value: 125, unit: "MG/5 ML" }
 * - "125 MG per 5 ML" -> { value: 125, unit: "MG/5 ML" }
 * - "125 mg in 5 mL" -> { value: 125, unit: "MG/5 ML" }
 * - "0.5 MG" -> { value: 0.5, unit: "MG" }
 * - "250 ML amoxicillin 125 MG/5 ML" -> { value: 125, unit: "MG/5 ML" } (prioritize concentration over volume)
 * Returns null if no strength found
 */
function extractStrength(str: string): { value: number; unit: string } | null {
  // First try to match concentration format (prioritize this over simple strength)
  // Patterns: "125 MG/5 ML", "125 MG per 5 ML", "125 mg in 5 mL", "125MG/5ML"
  const concentrationPatterns = [
    /(\d+(?:\.\d+)?)\s*(MG|MCG|G)\s*(?:\/|per|in)\s*(\d+(?:\.\d+)?)\s*(ML|IU)/i,
    /(\d+(?:\.\d+)?)\s*(MG|MCG|G)\s*\/\s*(\d+(?:\.\d+)?)\s*(ML|IU)/i,
  ];
  
  for (const pattern of concentrationPatterns) {
    const match = str.match(pattern);
    if (match) {
      return {
        value: parseFloat(match[1]),
        unit: `${match[2].toUpperCase()}/${match[3]} ${match[4].toUpperCase()}`
      };
    }
  }
  
  // Then try simple format: "250 MG", "500 MG", etc.
  // But skip if it's just volume (ML without MG/MCG/G before it in the same context)
  const simpleMatch = str.match(/(\d+(?:\.\d+)?)\s*(MG|MCG|G|IU|ACTUATE)\b/i);
  if (simpleMatch) {
    // Check if this is part of a concentration (e.g., "125 MG/5 ML" - we want the MG part, not the ML)
    const beforeMatch = str.substring(0, simpleMatch.index || 0);
    const afterMatch = str.substring((simpleMatch.index || 0) + simpleMatch[0].length);
    
    // If we find MG/MCG/G and it's not followed by concentration format, use it
    if (['MG', 'MCG', 'G', 'IU', 'ACTUATE'].includes(simpleMatch[2].toUpperCase())) {
      // Make sure this isn't the volume part of a concentration
      if (!afterMatch.match(/^\s*(?:\/|per|in)\s*\d+/i)) {
        return {
          value: parseFloat(simpleMatch[1]),
          unit: simpleMatch[2].toUpperCase()
        };
      }
    } else {
      return {
        value: parseFloat(simpleMatch[1]),
        unit: simpleMatch[2].toUpperCase()
      };
    }
  }
  
  return null;
}

/**
 * Compare two strength objects to see if they match
 */
function strengthsMatch(
  strength1: { value: number; unit: string } | null,
  strength2: { value: number; unit: string } | null
): boolean {
  if (!strength1 || !strength2) return false;
  // Normalize units for comparison (handle variations like "MG/5 ML", "MG PER 5 ML", "MG/5ML")
  const normalizeUnit = (unit: string) => {
    return unit.toUpperCase()
      .replace(/\s+/g, '')
      .replace(/PER/gi, '/')
      .replace(/IN/gi, '/');
  };
  return strength1.value === strength2.value && normalizeUnit(strength1.unit) === normalizeUnit(strength2.unit);
}

/**
 * Normalize string for comparison (lowercase, remove special chars, normalize spaces)
 * Also normalizes medication-specific variations like "per" vs "/", "in" vs "/"
 */
function normalizeForMatch(str: string): string {
  return str.toLowerCase()
    .replace(/\s+per\s+/gi, ' / ') // "125 MG per 5 ML" -> "125 MG / 5 ML"
    .replace(/\s+in\s+/gi, ' / ') // "125 mg in 5 mL" -> "125 mg / 5 mL"
    .replace(/[^a-z0-9\s\/]/g, ' ') // Remove special chars but keep "/"
    .replace(/\s+/g, ' ') // Normalize spaces
    .replace(/\s*\/\s*/g, '/') // Normalize "/" spacing: "125 MG / 5 ML" -> "125 MG/5 ML"
    .trim();
}

/**
 * TTY priority hierarchy (higher number = more specific)
 * Priority order: SBD > SCD > GPCK > BPCK > PIN > IN
 * IN and MIN should be filtered out (not used as specific RxCUI)
 */
const ttyPriority: Record<string, number> = {
  'SBD': 20,  // Scored Branded Drug (highest priority)
  'SCD': 19,  // Scored Clinical Drug
  'GPCK': 15, // Generic Pack
  'BPCK': 14, // Brand Name Drug Pack
  'PIN': 5,   // Precise Ingredient
  'SCDF': 8,  // Scored Clinical Drug Form
  'SBDF': 7,  // Scored Branded Drug Form
  'SCDC': 6,  // Scored Clinical Drug Component
  'SBDC': 5,  // Scored Branded Drug Component
  'IN': 1,    // Ingredient (should be filtered out)
  'MIN': 1,   // Multiple Ingredient (should be filtered out)
};

/**
 * Check if TTY is ingredient-level (should be filtered out)
 */
function isIngredientTTY(tty: string | null | undefined): boolean {
  if (!tty) return false;
  return tty === 'IN' || tty === 'MIN';
}

