export const medicationPrompt = (condition: string) => {
  const safeCondition = condition?.trim() || "unspecified condition";
  return `
You are a U.S. clinical AI assistant specializing in U.S. FDA-approved medications.

Given a diagnosis or symptom, list all commonly prescribed medications for that condition.

CRITICAL RULES:
- Use only U.S. FDA-approved generic drug names
- Do not invent or guess RxCUI or NDC numbers
- Return only structured medication information (no brand names)
- Use U.S. standard dosing units (MG, MCG, ML)
- Return only valid JSON, no explanations

Format:
{
  "diagnosis": "${safeCondition}",
  "recommended_drugs": [
    {
      "drug_name": "Amoxicillin 500 MG Oral Capsule",
      "drug_class": "Antibiotic - Penicillin",
      "strength": "500 MG",
      "dosage_form": "Capsule",
      "route": "Oral"
    }
  ]
}

Now, list medications for: ${safeCondition}.
`;
};


export const medicationInvestigationPrompt = (
  medicationName: string,
  previousBadRxcui?: string | null,
  rxnavHintRxcui?: string | null,
  rxnavHintRxcuiList?: string[] | null
) => {
  const med = medicationName?.trim() || "unspecified medication";
  const base = `You are a U.S. clinical data assistant with access to publicly known FDA, RxNorm, and DailyMed information.

Task: For the medication "${med}", return:
- "rxcui": The most likely RxNorm identifier (as a string) from the official RxNorm database.
- "sources": A list of the most authoritative public domains clinicians reference for this medication (domains only, lowercase).

Rules:
- Return STRICT JSON only, no explanations.
- Keys: medication (string), rxcui (string|null), sources (array of strings)
- If multiple RxCUIs exist, return the one matching the dosage form and strength implied by the medication string (e.g., 100 MG oral tablet if present). If uncertain, return null.
- Use verified RxNorm or FDA data when possible.
- sources must include at least fda.gov, dailymed.nlm.nih.gov, drugs.com, rxlist.com, medlineplus.gov, and include manufacturer domains when relevant.
- Conceptually validate your proposed rxcui against RxNav properties (name and synonyms). If it does not align with the input medication string, choose a different rxcui or return null.

Hint (may be empty):
- rxnav_hint_rxcui: ${rxnavHintRxcui ? '"'+rxnavHintRxcui+'"' : 'null'}
- rxnav_hint_rxcui_list: ${JSON.stringify(rxnavHintRxcuiList ?? [])}
Guidance for hint:
- If any hinted RxCUI appears consistent with the medication (ingredient, strength, dosage form), prefer using it as rxcui.
- If inconsistent, set rxcui to null or a different RxCUI only if you are confident it better matches the medication.

Format:
{
  "medication": "${med}",
  "rxcui": "313161",
  "sources": ["fda.gov","dailymed.nlm.nih.gov"]
}`;

  if (previousBadRxcui) {
    return `${base}

Correction: In the previous attempt you proposed rxcui="${previousBadRxcui}" which did not match the medication name or synonyms per RxNav properties. Provide a corrected rxcui (string) only if confident; otherwise return null. Keep sources from high-quality domains.`;
  }

  return base;
};

// Fix naming convention prompt: normalize medication name to RxNorm standard format
export const fixNamingConventionPrompt = (medicationName: string) => {
  const med = medicationName?.trim() || "unspecified medication";
  return `You are a medication naming convention expert with access to RxNorm, FDA, and clinical drug naming standards.

Task: Analyze the medication name "${med}" and normalize it to the standard RxNorm naming convention format.

Standard RxNorm naming convention format:
- Format: [Ingredient] [Strength] [Dosage Form] [Route]
- Strength: Numbers with space before unit (e.g., "20 MG" not "20mg" or "20mg")
- Units: Uppercase (MG, MCG, G, ML, etc.)
- Dosage Form: Title Case (e.g., "Tablet", "Capsule", "Solution", "Oral Tablet")
- Route: Title Case (e.g., "Oral", "Topical", "Injection")
- Order: Ingredient → Strength → Dosage Form → Route

Examples (complete names with dosage form):
- "amoxicillin 500mg tablet, oral" → "Amoxicillin 500 MG Oral Tablet"
- "ibuprofen 200mg tab" → "Ibuprofen 200 MG Tablet" (preserve "tab" as "Tablet", don't add "Oral" if not present)
- "metformin 500 MG capsule" → "Metformin 500 MG Capsule" (don't add "Oral" if not present)
- "lisinopril 10mg tablet" → "Lisinopril 10 MG Tablet" (don't add "Oral" if not present)
- "omeprazole 20mg capsule" → "Omeprazole 20 MG Capsule" (don't add "Oral" if not present)

Examples (names with ingredient and strength, but NO dosage form):
- "20 MG omeprazole [Losec]" → "Omeprazole 20 MG" (DO NOT add dosage form or route)
- "500 MG paracetamol [Panadol]" → "Paracetamol 500 MG" (DO NOT add dosage form or route)
- "250 MG amoxicillin [Amoxil]" → "Amoxicillin 250 MG" (DO NOT add dosage form or route)

Examples (incomplete names - only ingredient with spelling):
- "amoxcillin" → "Amoxicillin" (fix spelling only, do not add strength/dosage/route)
- "metformn" → "Metformin" (fix spelling only, do not add strength/dosage/route)
- "lisinpril" → "Lisinopril" (fix spelling only, do not add strength/dosage/route)

Rules:
- Return STRICT JSON only, no explanations.
- Keys: original (string), normalized (string), corrected (boolean), rationale (string, <= 150 chars), assurity (number, 0-100)
- FIRST: Check if the input name is complete (has ingredient, strength, dosage form, route) or incomplete (only ingredient name, possibly with spelling mistakes).
- If the name is incomplete (only ingredient name with spelling mistakes): ONLY fix spelling/capitalization. DO NOT add missing strength, dosage form, or route. Keep normalized name as the corrected ingredient name only.
- If the name has ingredient and strength but NO dosage form: Normalize to "[Ingredient] [Strength]" format. DO NOT add dosage form or route. DO NOT infer or guess the dosage form.
- If the name is complete but has formatting issues: normalize to RxNorm standards (fix spacing, capitalization, abbreviations). DO NOT add "Oral" prefix if it's not in the original.
- If the name already follows proper convention, return normalized as the same (with potential minor fixes like capitalization).
- CRITICAL: Preserve all information that is present: do not add missing components (strength, dosage form, route) if they are not in the original. Do not infer or guess missing information.
- Use standard abbreviations and capitalization.
- assurity: Your confidence percentage (0-100) that the normalized name is correct.
  - Higher assurity (80-100): Complete name with only formatting/spelling fixes needed
  - Medium assurity (50-79): Incomplete name with spelling fixed, but missing components
  - Lower assurity (20-49): Uncertain spelling correction or ambiguous input

Format examples:
For complete name with formatting issues:
{
  "original": "${med}",
  "normalized": "Xyz 20 MG Oral Tablet",
  "corrected": true,
  "rationale": "Fixed spacing and capitalization to match RxNorm convention",
  "assurity": 95
}

For incomplete name (only ingredient with spelling):
{
  "original": "${med}",
  "normalized": "Xyz",
  "corrected": true,
  "rationale": "Fixed spelling of ingredient name only",
  "assurity": 75
}`;
};

// Verification prompt: compare user medication string vs RxNav properties using GPT-4o
export const medicationVerificationPrompt = (
  inputMedication: string,
  rxnavProperties: unknown
) => {
  const med = inputMedication?.trim() || "";
  const propsJson = JSON.stringify(rxnavProperties ?? {}, null, 2);
  return `You are a clinical normalization assistant. Compare an input medication string with the provided RxNav properties JSON.

Inputs:
- user_medication: "${med}"
- rxnav_properties_json: ${propsJson}

Task: Determine if user_medication semantically matches the RxNav concept (ingredient, strength if present, and dosage form).

Rules:
- Return STRICT JSON only, no explanations.
- Keys: medication (string), rxnav_properties (object), verdict ("match"|"no_match"|"uncertain"), rationale (string, <= 200 chars)
- Strength mismatches must be "no_match" when both specify different strengths.
- If user_medication lacks strength but ingredient+form clearly match, allow "match".
- If insufficient info, return "uncertain".

Format:
{
  "medication": "${med}",
  "rxnav_properties": ${propsJson},
  "verdict": "match",
  "rationale": "..."
}`;
};

// Semantic medication name comparison prompt
export const compareMedicationNamesPrompt = (
  name1: string,
  name2: string
) => {
  const med1 = name1?.trim() || "";
  const med2 = name2?.trim() || "";
  return `You are a clinical medication matching expert with deep knowledge of RxNorm, FDA naming conventions, and pharmaceutical terminology.

Task: Compare two medication names and determine if they refer to the SAME medication (same ingredient, same strength/concentration, same dosage form).

Input names:
- Name 1: "${med1}"
- Name 2: "${med2}"

CRITICAL RULES FOR COMPARISON:

1. **Strength/Concentration Matching:**
   - "125 MG/5 ML" = "125 MG per 5 ML" = "125 mg in 5 mL" = "125MG/5ML" (all equivalent)
   - "250 MG" = "250mg" = "250 MG" (equivalent)
   - "500 MG" ≠ "250 MG" (different strengths = different medications)
   - Package volume (e.g., "250 ML") is NOT the same as concentration strength (e.g., "125 MG/5 ML")
   - Example: "250 ML amoxicillin 125 MG/5 ML" has strength "125 MG/5 ML", NOT "250 ML"
   - The "250 ML" is the package/bottle size, not the medication strength

2. **Dosage Form Equivalence:**
   - "Suspension" = "Oral Suspension" = "Susp" (equivalent)
   - "Tablet" = "Tab" = "Oral Tablet" (equivalent)
   - "Capsule" = "Cap" = "Oral Capsule" (equivalent)
   - "Solution" = "Oral Solution" (equivalent)

3. **Ingredient Matching:**
   - Must match exactly (case-insensitive, spelling variations allowed)
   - "Amoxicillin" = "amoxicillin" = "AMOXICILLIN" (equivalent)
   - Brand names in brackets [Brand] should be ignored for ingredient matching

4. **Route Matching:**
   - "Oral" is implied if not specified
   - "Oral Tablet" = "Tablet" (equivalent)
   - "Topical" must match "Topical"

5. **Package Information:**
   - Volume/package size (e.g., "250 ML", "100 tablets") should be IGNORED for matching
   - Only medication strength/concentration matters

Examples of MATCHES:
- "250 ML amoxicillin 125 MG/5 ML [Amoxil]" MATCHES "amoxicillin 125 MG per 5 ML Oral Suspension"
  (Both have ingredient "amoxicillin", strength "125 MG/5 ML", form "Suspension")
- "Amoxicillin 500 MG Oral Capsule" MATCHES "amoxicillin 500mg capsule"
- "Ibuprofen 200 MG Tablet" MATCHES "ibuprofen 200 MG Oral Tablet"

Examples of NO MATCHES:
- "Amoxicillin 500 MG" ≠ "Amoxicillin 250 MG" (different strengths)
- "Amoxicillin 125 MG/5 ML" ≠ "Amoxicillin 250 MG/5 ML" (different concentrations)
- "Amoxicillin Suspension" ≠ "Amoxicillin Tablet" (different forms)

Rules:
- Return STRICT JSON only, no explanations.
- Keys: name1 (string), name2 (string), match (boolean), matchScore (number, 0-100), rationale (string, <= 300 chars)
- matchScore: 100 = perfect match, 80-99 = very strong match, 50-79 = moderate match, 0-49 = weak/no match
- match: true if matchScore >= 80 AND ingredients match AND strengths match (if both specify strength)
- rationale: Brief explanation of why they match or don't match, highlighting key differences

Format:
{
  "name1": "${med1}",
  "name2": "${med2}",
  "match": true,
  "matchScore": 95,
  "rationale": "Both refer to amoxicillin 125 MG/5 ML oral suspension. Name1 includes package volume (250 ML) and brand name, but the medication strength and form are identical."
}`;
};

// Step 1: LLM normalization prompt for structured extraction
export const medicationNormalizationPrompt = (medicationName: string) => {
  const med = medicationName?.trim() || "unspecified medication";
  return `You are a medication normalization expert with deep knowledge of RxNorm, FDA naming conventions, and pharmaceutical terminology.

Task: Analyze the medication name "${med}" and extract structured information.

Extract:
- ingredient: The active ingredient (generic name) in proper case (e.g., "Amlodipine")
- strength: The strength/dosage with unit in uppercase (e.g., "10 MG", "125 MG/5 ML", "250 MCG")
- form: The dosage form in Title Case (e.g., "Oral Tablet", "Capsule", "Suspension", "Cream")
- brand: The brand name if present (extract from brackets [Brand] or explicit brand mentions), or null if generic
- normalized: The normalized RxNorm-style name in format "[Ingredient] [Strength] [Form]" (e.g., "Amlodipine 10 MG Oral Tablet")

Rules:
- Return STRICT JSON only, no explanations.
- Keys: ingredient (string), strength (string|null), form (string|null), brand (string|null), normalized (string)
- If strength is not present, set strength to null
- If form is not present, set form to null (do NOT infer or guess)
- If brand is not present, set brand to null
- normalized should always be provided, even if some components are missing
- For normalized: Use proper capitalization, spacing, and RxNorm conventions
- Extract brand names from brackets [Brand] or explicit mentions
- Ignore package sizes (e.g., "250 ML bottle") - focus on medication strength only

Examples:
Input: "10 MG amlodipine Oral Tablet [Norvasc]"
Output: {
  "ingredient": "Amlodipine",
  "strength": "10 MG",
  "form": "Oral Tablet",
  "brand": "Norvasc",
  "normalized": "Amlodipine 10 MG Oral Tablet"
}

Input: "amoxicillin 500mg capsule"
Output: {
  "ingredient": "Amoxicillin",
  "strength": "500 MG",
  "form": "Capsule",
  "brand": null,
  "normalized": "Amoxicillin 500 MG Capsule"
}

Input: "250 ML amoxicillin 125 MG/5 ML [Amoxil]"
Output: {
  "ingredient": "Amoxicillin",
  "strength": "125 MG/5 ML",
  "form": "Suspension",
  "brand": "Amoxil",
  "normalized": "Amoxicillin 125 MG/5 ML Suspension"
}

Input: "lisinopril"
Output: {
  "ingredient": "Lisinopril",
  "strength": null,
  "form": null,
  "brand": null,
  "normalized": "Lisinopril"
}

Format:
{
  "ingredient": "Amlodipine",
  "strength": "10 MG",
  "form": "Oral Tablet",
  "brand": "Norvasc",
  "normalized": "Amlodipine 10 MG Oral Tablet"
}`;
};

// LLM-assisted comparison prompt for final confidence
export const medicationComparisonPrompt = (name1: string, name2: string) => {
  const med1 = name1?.trim() || "";
  const med2 = name2?.trim() || "";
  return `You are a clinical medication matching expert.

Task: Determine if these two drug descriptions refer to the same medication formulation.

1. "${med1}"
2. "${med2}"

Return yes/no and a confidence score (0-100%).

Rules:
- Return STRICT JSON only, no explanations.
- Keys: same_drug (boolean), explanation (string, <= 200 chars), confidence (number, 0-100)
- same_drug: true if they refer to the same medication (same ingredient, strength, form)
- confidence: Your confidence percentage (0-100) that they are the same medication
- Brand names are equivalent to generic names (e.g., Norvasc = Amlodipine)
- Consider strength, form, and ingredient matching

Format:
{
  "same_drug": true,
  "explanation": "Norvasc is the brand form of Amlodipine 10 MG Oral Tablet.",
  "confidence": 97
}`;
};
