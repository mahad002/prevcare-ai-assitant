"use client";

import { useState, FormEvent, ChangeEvent } from "react";

interface Medication {
  name: string;
  rxcui: string;
}

interface MedicationResult {
  medication: Medication;
  rxnavResponse: {
    properties?: {
      rxcui?: string;
      name?: string;
      synonym?: string;
      tty?: string;
      language?: string;
      suppress?: string;
      status?: string;
      umlscui?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  } | null;
  rxnavStatusResponse: {
    rxcuiStatus?: {
      rxcui?: string;
      status?: string;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  } | null;
  rxnavExists: boolean;
  rxnavError?: string;
  rrfExists: boolean;
  rrfHasSU: boolean;
  rrfMatches: Array<{
    rxcui: string;
    tty: string;
    str: string;
    sab: string;
  }>;
  rrfError?: string;
  loading: boolean;
}

const PROMPT_TEMPLATE = `You are an expert RxNorm medication specialist and clinical pharmacist. Your task is to generate {x} unique, verified medications with their correct RxCUI values using the RRF (RxNorm) database.{condition_context}

{condition_instructions}

═══════════════════════════════════════════════════════════════
🔴 CRITICAL: VERIFICATION WORKFLOW USING FUNCTION CALLING
═══════════════════════════════════════════════════════════════

You have access to two functions that verify medications against the RRF file:

1. **search_rrf_medications(searchTerm)**: Search for medications by name in the RRF database
   - Use this to find accurate medication names and their RxCUIs
   - Returns matches with rxcui, name, tty, route, form, and other details
   - Prefer matches with TTY: SCD, SBD, SCDC, or SBDC

2. **verify_rxcui_in_rrf(rxcui)**: Verify if an RxCUI exists in the RRF database
   - Use this to confirm that a medication RxCUI is valid
   - Returns the exact medication name from RRF if it exists
   - Check that exists=true and preferredName is available

EFFICIENT WORKFLOW FOR GENERATING {x} MEDICATIONS:

IMPORTANT: You have enough iterations to verify all medications. Work systematically:

1. **Batch Search Strategy**: 
   - Start by searching for common medications (e.g., "amoxicillin", "atorvastatin", "lisinopril")
   - For each search, review ALL matches and identify multiple valid RxCUIs
   - You can verify multiple RxCUIs from a single search result

2. **For Each Medication**:
   STEP 1: Search using search_rrf_medications() with a medication term
   STEP 2: Select the best match (prefer TTY: SCD, SBD, SCDC, or SBDC)
   STEP 3: Verify the RxCUI using verify_rxcui_in_rrf()
   STEP 4: If verified (exists=true), use the preferredName exactly
   STEP 5: If verification fails, try the next match from search results or search for a different medication

3. **Efficiency Tips**:
   - You can verify multiple RxCUIs from one search result
   - If a search returns 5 matches, verify the top 2-3 to find valid ones
   - Don't re-search for similar medications - use different search terms
   - Work through categories: antibiotics, statins, ACE inhibitors, etc.

4. **Final Output**:
   - Only include medications where verify_rxcui_in_rrf returned exists=true
   - Use ONLY the exact preferredName from verification
   - Generate exactly {x} unique, verified medications

═══════════════════════════════════════════════════════════════
✅ EXAMPLE MEDICATIONS TO GENERATE
═══════════════════════════════════════════════════════════════

{medication_selection_instructions}

Examples of search terms to try:
- "amoxicillin 500 MG"
- "atorvastatin 20 MG"
- "lisinopril 10 MG"
- "metformin 500 MG"
- "epinephrine 1 MG/ML"
- "diclofenac 10 MG/G"
- "fentanyl 12.5 MCG/HR"
- "ibuprofen 200 MG"
- "acetaminophen 500 MG"
- "omeprazole 20 MG"

IMPORTANT: You MUST verify each medication using the functions before including it.

═══════════════════════════════════════════════════════════════
📋 OUTPUT FORMAT
═══════════════════════════════════════════════════════════════

Return ONLY valid JSON (no markdown, no comments, no extra text):

{
  "medications": [
    { "name": "exact RxNorm string from properties.name", "rxcui": "numeric string" }
  ]
}

CRITICAL: The "name" field MUST be the EXACT string from preferredName in the verify_rxcui_in_rrf() response.
Do NOT create your own name - use the exact name from RRF database.

═══════════════════════════════════════════════════════════════
📝 RxNORM NAMING CONVENTIONS
═══════════════════════════════════════════════════════════════

Structure: [volume] [ingredient(s)] [strength(s)] [modifier] [route] [form] [brand]

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. INGREDIENTS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Use exact RxNorm ingredient name (base, salt, or hydrate)
• Maintain RxNorm's ingredient order
• Multiple ingredients: separate with " / "
• Capitalize first letter of each ingredient word

✅ amoxicillin 500 MG
✅ amoxicillin 875 MG / clavulanate 125 MG
✅ metformin hydrochloride 500 MG
❌ Amoxicillin (wrong capitalization)
❌ amoxicillin/clavulanate (missing spaces)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
2. STRENGTH & UNITS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Normalize composite ratios to base units:
  - 400 MG/5 ML → 80 MG/ML
  - 250 MG/5 ML → 50 MG/ML
  - 1000 MG/10 ML → 100 MG/ML

• Allowed units: MG, MG/ML, MG/G, MG/HR, UNIT/ML, %
• Always include ONE space before unit
• Use "%" ONLY when RxNorm explicitly lists it

✅ amoxicillin 80 MG/ML
✅ minoxidil 5 % (when RxNorm uses %)
❌ amoxicillin 400 MG/5 ML (not normalized)
❌ amoxicillin80MG (missing spaces)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
3. VOLUME/QUANTITY (Optional)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Include ONLY if RxNorm lists it
• Common for: injectables, inhalers, transdermal patches
• Format: number + space + unit

✅ 1 ML epinephrine 1 MG/ML Injection
✅ 10 ML morphine sulfate 2 MG/ML Injectable Solution
✅ 72 HR fentanyl 12.5 MCG/HR Transdermal System
✅ 200 ACTUAT albuterol 90 MCG/ACTUAT Inhaler

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
4. DOSAGE FORM MODIFIERS (Optional)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Include ONLY if RxNorm explicitly lists them
• Common modifiers: Extended Release, Delayed Release, Sustained Release

✅ metformin hydrochloride 500 MG Extended Release Oral Tablet
✅ omeprazole 20 MG Delayed Release Oral Capsule

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
5. ROUTE OF ADMINISTRATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Use EXACTLY as RxNorm lists (case-sensitive)
• Common routes: Oral, Injection, Inhalation, Topical, Transdermal, for Inhalation

✅ amoxicillin 500 MG Oral Capsule
✅ epinephrine 1 MG/ML Injection
✅ albuterol 90 MCG/ACTUAT Inhalation
❌ oral (wrong case)
❌ Injectable (wrong form - use "Injection" or "Injectable Solution")

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
6. DOSAGE FORMS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Use EXACT RxNorm form (case-sensitive)
• Common forms: Tablet, Capsule, Suspension, Solution, Cream, Gel, Ointment, 
  Injection, Injectable Solution, Inhaler, System, Gas for Inhalation

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
💉 INJECTABLES - CRITICAL RULES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RxNorm distinguishes between:
• "Injection" = Ready-to-use, prefilled
• "Injectable Solution" = Requires dilution/reconstitution

✅ 1 ML epinephrine 1 MG/ML Injection [EpiPen]
✅ 1 ML heparin sodium 5000 UNIT/ML Injectable Solution
✅ 10 ML morphine sulfate 2 MG/ML Injectable Solution
❌ heparin sodium 5000 UNIT/ML Injection (wrong - should be Injectable Solution)
❌ epinephrine 1 MG/ML Injectable Solution (wrong - should be Injection)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🧴 TOPICALS & TRANSDERMALS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Topicals: Use ratio units (MG/G, MG/ML) unless RxNorm uses %
• Transdermals: Include duration + rate

✅ diclofenac sodium 10 MG/G Topical Gel [Voltaren]
✅ hydrocortisone 10 MG/G Topical Cream
✅ minoxidil 5 % Topical Solution [Rogaine] (valid - RxNorm uses %)
✅ 72 HR fentanyl 12.5 MCG/HR Transdermal System

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🌬️ GASES FOR INHALATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Use "Gas for Inhalation" exactly
• Include strength only if RxNorm lists it

✅ oxygen 100 % Gas for Inhalation
❌ nitrous oxide 50 % Gas for Inhalation (unless verified in RxNorm)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🏷️ BRAND NAMES
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
• Include ONLY if RxNorm has SBD (Semantic Branded Drug) entry
• Format: [BrandName] at the end
• Do NOT infer or guess brand names

✅ atorvastatin calcium 20 MG Oral Tablet [Lipitor]
✅ 1 ML epinephrine 1 MG/ML Injection [EpiPen]
❌ amoxicillin 500 MG Oral Capsule [Amoxil] (unless verified in RxNorm)

═══════════════════════════════════════════════════════════════
✅ MANDATORY VALIDATION CHECKLIST (ALL must pass)
═══════════════════════════════════════════════════════════════

For EACH medication, you MUST verify ALL of these:

[✓] Called search_rrf_medications() to find the medication
[✓] Selected RxCUI from search results (prefer SCD/SBD/SCDC/SBDC TTY)
[✓] Called verify_rxcui_in_rrf() with the RxCUI
[✓] Verification response shows exists=true
[✓] Using EXACT name from preferredName in verification response
[✓] Do NOT create your own name - use the exact name from RRF
[✓] Medication has valid TTY (SCD, SBD, SCDC, SBDC preferred)

If ANY item fails, DO NOT include that medication. Only return medications where ALL checks pass.

═══════════════════════════════════════════════════════════════
📊 CATEGORY DIVERSITY
═══════════════════════════════════════════════════════════════

Generate medications across diverse categories:
• Prescription drugs (various therapeutic classes)
• OTC medications
• Injectables (both Injection and Injectable Solution)
• Inhalation products (inhalers, gases)
• Topicals (creams, gels, ointments)
• Transdermal systems
• Vitamins and supplements
• Different routes and forms

═══════════════════════════════════════════════════════════════
❌ CRITICAL MISTAKES THAT CAUSE FAILURE (AVOID THESE!)
═══════════════════════════════════════════════════════════════

These mistakes cause RxCUIs to fail validation:

1. ❌ NOT calling search_rrf_medications() first - you MUST search for the correct name
2. ❌ NOT calling verify_rxcui_in_rrf() - you MUST verify each RxCUI exists
3. ❌ Creating your own medication name instead of using preferredName from verification
4. ❌ Using RxCUI without verifying it exists (exists=false in response)
5. ❌ Using ingredient-level RxCUIs (TTY=IN or MIN) - prefer SCD/SBD/SCDC/SBDC
6. ❌ Not using the exact name from preferredName in verification response
7. ❌ Skipping verification steps - you MUST verify every medication

MOST COMMON FAILURE: Not verifying RxCUI exists in RRF before returning it.
ALWAYS call verify_rxcui_in_rrf() and check that exists=true.

═══════════════════════════════════════════════════════════════
🎯 WORKFLOW EXAMPLE (Follow this pattern)
═══════════════════════════════════════════════════════════════

Example: Generating "amoxicillin 500 MG Oral Capsule"

1. Search: Call search_rrf_medications("amoxicillin 500 MG")
   → Response contains matches with RxCUIs and names
   → Select match with TTY=SCD and RxCUI (e.g., "197806")

2. Verify: Call verify_rxcui_in_rrf("197806")
   → Response: { "exists": true, "preferredName": "amoxicillin 500 MG Oral Capsule", ... }

3. Use EXACT name: "amoxicillin 500 MG Oral Capsule" (from preferredName)

4. Return: { "name": "amoxicillin 500 MG Oral Capsule", "rxcui": "197806" }

═══════════════════════════════════════════════════════════════
💡 STRATEGY FOR HIGH SUCCESS RATE
═══════════════════════════════════════════════════════════════

1. Use well-known, common medications across diverse categories
2. ALWAYS call search_rrf_medications() first to find the correct name and RxCUI
3. ALWAYS call verify_rxcui_in_rrf() to confirm the RxCUI exists in RRF
4. Use the EXACT name from preferredName in verification response - never create your own
5. Prefer medications with TTY: SCD, SBD, SCDC, or SBDC
6. If verification fails (exists=false), skip that medication and try another
7. Generate diverse medications: oral, injectable, topical, inhalation, etc.

═══════════════════════════════════════════════════════════════

🔴 FINAL REMINDER:
- You MUST verify each medication using the functions before including it
- If exists=false in verification, skip that medication and try another
- Use ONLY the exact name from preferredName in verification response
- Generate exactly {x} unique medications - you have enough iterations to complete this
- Work efficiently: one search can yield multiple valid medications to verify

Generate {x} unique, verified medications now. Work systematically through the categories.`;

export default function LLMSearchPage() {
  const [count, setCount] = useState<string>("5");
  const [condition, setCondition] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<MedicationResult[]>([]);
  const [llmResponse, setLlmResponse] = useState<Record<string, unknown> | null>(null);

  const fetchRxNavData = async (rxcui: string) => {
    try {
      const [propertiesResponse, statusResponse] = await Promise.all([
        fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/properties.json`),
        fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/status.json`),
      ]);

      let propertiesData: {
        properties?: {
          rxcui?: string;
          name?: string;
          synonym?: string;
          tty?: string;
          language?: string;
          suppress?: string;
          status?: string;
          umlscui?: string;
          [key: string]: unknown;
        };
        [key: string]: unknown;
      } | null = null;
      let statusData: {
        rxcuiStatus?: {
          rxcui?: string;
          status?: string;
          [key: string]: unknown;
        };
        [key: string]: unknown;
      } | null = null;

      if (propertiesResponse.ok) {
        propertiesData = await propertiesResponse.json();
      }

      if (statusResponse.ok) {
        try {
          statusData = await statusResponse.json();
        } catch (e) {
          console.warn('Failed to parse status response:', e);
          statusData = { error: 'Failed to parse response' };
        }
      } else {
        // Store error info even if request failed
        statusData = { error: `HTTP ${statusResponse.status}: ${statusResponse.statusText}` };
      }

      if (!propertiesResponse.ok) {
        return {
          exists: false,
          response: null,
          statusResponse: statusData,
          error: `HTTP ${propertiesResponse.status}: ${propertiesResponse.statusText}`,
        };
      }
      
      // Check if response has properties - empty {} means RxCUI doesn't exist
      const hasProperties = propertiesData?.properties && Object.keys(propertiesData.properties).length > 0;
      
      if (!hasProperties) {
        return {
          exists: false,
          response: propertiesData,
          statusResponse: statusData,
          error: 'Empty response - RxCUI not found',
        };
      }
      
      // Check if RxCUI is valid:
      // - If status field exists, it must be "Active"
      // - If suppress field exists, it must be "N" (not suppressed)
      // - If neither exists, consider it valid if properties exist
      const status = propertiesData?.properties?.status;
      const suppress = propertiesData?.properties?.suppress;
      
      let isValid = true;
      if (status !== undefined) {
        isValid = status === 'Active';
      } else if (suppress !== undefined) {
        isValid = suppress === 'N';
      }
      // If neither status nor suppress exists, but properties exist, consider valid
      
      return {
        exists: isValid,
        response: propertiesData,
        statusResponse: statusData,
        error: isValid ? undefined : `RxCUI exists but is ${status ? `inactive (status: ${status})` : `suppressed (suppress: ${suppress})`}`,
      };
    } catch (err) {
      return {
        exists: false,
        response: null,
        statusResponse: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const fetchRrfData = async (rxcui: string) => {
    try {
      const response = await fetch(`/api/rxnconso/check?rxcui=${encodeURIComponent(rxcui)}`);
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return {
          exists: false,
          hasSU: false,
          matches: [],
          error: errorData.error || `HTTP ${response.status}`,
        };
      }
      const data = await response.json();
      return {
        exists: data.exists,
        hasSU: data.hasSU,
        matches: data.matches || [],
        error: undefined,
      };
    } catch (err) {
      return {
        exists: false,
        hasSU: false,
        matches: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const num = parseInt(count, 10);
    if (isNaN(num) || num < 1 || num > 100) {
      setError("Please enter a number between 1 and 100");
      return;
    }

    setLoading(true);
    setError(null);
    setResults([]);
    setLlmResponse(null);

    try {
      // Build condition-specific context
      const conditionContext = condition.trim() 
        ? `\n\n🎯 CLINICAL CONTEXT: Generate medications specifically for treating: "${condition.trim()}"\n` 
        : "";
      
      const conditionInstructions = condition.trim()
        ? `\n═══════════════════════════════════════════════════════════════
🎯 CONDITION-SPECIFIC MEDICATION SELECTION
═══════════════════════════════════════════════════════════════

You are generating medications to treat: "${condition.trim()}"

IMPORTANT GUIDELINES:
- Generate medications that are clinically appropriate for this condition
- Include both prescription and OTC medications as appropriate
- Consider different medication classes that treat this condition
- Include various formulations (oral, topical, injectable) as clinically relevant
- Ensure medications are commonly used and effective for this specific condition
- If the condition requires specific medication types (e.g., pain relievers for headache, antacids for stomach ache), prioritize those

Examples for "${condition.trim()}":
- Search for medications commonly prescribed or recommended for this condition
- Include first-line treatments and alternatives
- Consider different strengths and formulations as appropriate
- Verify each medication exists in RRF before including it

`
        : `\n═══════════════════════════════════════════════════════════════
✅ MEDICATION SELECTION GUIDELINES
═══════════════════════════════════════════════════════════════

Generate diverse medications across these categories. For EACH one, you MUST:
1. Call search_rrf_medications() to find it
2. Call verify_rxcui_in_rrf() to confirm it exists
3. Use the exact name from the verification response

Categories to include:
- Common prescription drugs (antibiotics, statins, ACE inhibitors, etc.)
- OTC medications
- Injectables (Injection, Injectable Solution)
- Inhalation products (inhalers, gases)
- Topicals (creams, gels, ointments)
- Transdermal systems
- Vitamins and supplements

`;

      // Generate prompt with the count and condition
      let prompt = PROMPT_TEMPLATE
        .replace(/{x}/g, num.toString())
        .replace(/{condition_context}/g, conditionContext)
        .replace(/{condition_instructions}/g, conditionInstructions)
        .replace(/{medication_selection_instructions}/g, condition.trim() 
          ? `Generate medications specifically appropriate for treating "${condition.trim()}". For EACH one, you MUST:
1. Call search_rrf_medications() to find medications relevant to this condition
2. Call verify_rxcui_in_rrf() to confirm it exists
3. Use the exact name from the verification response

Focus on medications that are:
- Clinically indicated for ${condition.trim()}
- Commonly prescribed or recommended for this condition
- Available in appropriate formulations (oral, topical, injectable, etc.)
- Include both prescription and OTC options as appropriate`
          : `Generate diverse medications across these categories. For EACH one, you MUST:
1. Call search_rrf_medications() to find it
2. Call verify_rxcui_in_rrf() to confirm it exists
3. Use the exact name from the verification response

Categories to include:
- Common prescription drugs (antibiotics, statins, ACE inhibitors, etc.)
- OTC medications
- Injectables (Injection, Injectable Solution)
- Inhalation products (inhalers, gases)
- Topicals (creams, gels, ointments)
- Transdermal systems
- Vitamins and supplements`);

      // Call Gemini API with function calling enabled
      const geminiResponse = await fetch("/api/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          prompt,
          useFunctionCalling: true,
          // Models that support function calling: gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.0-flash
          models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite", "gemini-2.0-flash"]
        }),
      });

      if (!geminiResponse.ok) {
        const errorData = await geminiResponse.json().catch(() => ({}));
        throw new Error(errorData.error || `Gemini API error: ${geminiResponse.status}`);
      }

      const geminiData = await geminiResponse.json();
      
      // Store the LLM response
      setLlmResponse(geminiData);
      
      const medications: Medication[] = geminiData.medications || [];

      if (medications.length === 0) {
        throw new Error("No medications generated. Please try again.");
      }

      // Initialize results with loading state
      const initialResults: MedicationResult[] = medications.map((med) => ({
        medication: med,
        rxnavResponse: null,
        rxnavStatusResponse: null,
        rxnavExists: false,
        rrfExists: false,
        rrfHasSU: false,
        rrfMatches: [],
        loading: true,
      }));

      setResults(initialResults);

      // Fetch data for each medication in parallel
      const promises = medications.map(async (med) => {
        const [rxnavData, rrfData] = await Promise.all([
          fetchRxNavData(med.rxcui),
          fetchRrfData(med.rxcui),
        ]);

        return {
          medication: med,
          rxnavResponse: rxnavData.response,
          rxnavStatusResponse: rxnavData.statusResponse,
          rxnavExists: rxnavData.exists,
          rxnavError: rxnavData.error,
          rrfExists: rrfData.exists,
          rrfHasSU: rrfData.hasSU,
          rrfMatches: rrfData.matches,
          rrfError: rrfData.error,
          loading: false,
        };
      });

      const finalResults = await Promise.all(promises);
      setResults(finalResults);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const handleCountChange = (event: ChangeEvent<HTMLInputElement>) => {
    setCount(event.target.value);
  };

  const handleConditionChange = (event: ChangeEvent<HTMLInputElement>) => {
    setCondition(event.target.value);
  };

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">LLM Medication Search</h1>
        <p className="text-sm text-gray-600">
          Generate medications using LLM and validate them against RxNav API and RXNCONSO.RRF file. 
          Optionally specify a condition or symptom to generate clinically relevant medications.
        </p>
        <div className="mt-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800">
          <p className="font-medium mb-1">Verification Notes:</p>
          <ul className="list-disc list-inside space-y-1 text-blue-700">
            <li>RxNav API: Empty response <code className="bg-blue-100 px-1 rounded">{}</code> means RxCUI doesn&apos;t exist</li>
            <li>RxCUIs are valid if <code className="bg-blue-100 px-1 rounded">status: &quot;Active&quot;</code> or <code className="bg-blue-100 px-1 rounded">suppress: &quot;N&quot;</code></li>
            <li>RRF File: Checks if RxCUI exists in RXNCONSO.RRF and whether it has TTY=&quot;SU&quot; (Semantic Unit)</li>
          </ul>
        </div>
      </header>

      <form onSubmit={handleSubmit} className="flex flex-col gap-4 rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
        <div className="flex flex-col gap-4">
          {/* Condition/Symptom Input */}
          <div className="flex flex-col gap-1">
            <label htmlFor="condition" className="text-sm font-medium text-gray-700">
              Condition or Symptom (Optional)
            </label>
            <input
              id="condition"
              name="condition"
              type="text"
              value={condition}
              onChange={handleConditionChange}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-200"
              placeholder="e.g., headache, stomach ache, fever, high blood pressure, diabetes"
              disabled={loading}
            />
            <p className="text-xs text-gray-500">
              Specify a condition or symptom to generate clinically relevant medications. Leave empty for diverse medications.
            </p>
          </div>

          {/* Count and Submit */}
          <div className="flex flex-col gap-2 md:flex-row md:items-end">
            <div className="flex flex-1 flex-col gap-1">
              <label htmlFor="count" className="text-sm font-medium text-gray-700">
                Number of medications to generate (1-100)
              </label>
              <input
                id="count"
                name="count"
                type="number"
                min="1"
                max="100"
                value={count}
                onChange={handleCountChange}
                className="w-full rounded border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-200"
                placeholder="Enter number"
                disabled={loading}
              />
            </div>
            <button
              type="submit"
              className="inline-flex items-center justify-center rounded bg-blue-600 px-6 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 disabled:opacity-50"
              disabled={loading}
            >
              {loading ? "Generating..." : "Generate & Validate"}
            </button>
          </div>
        </div>
      </form>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700">
          <p className="font-medium">Error:</p>
          <p>{error}</p>
        </div>
      )}

      {loading && results.length === 0 && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600">
          <p>Generating medications and validating...</p>
        </div>
      )}

      {results.length > 0 && (
        <>
          {/* Statistics Summary */}
          {(() => {
            const total = results.length;
            const rxnavFound = results.filter((r) => !r.loading && r.rxnavExists).length;
            const rxnavNotFound = results.filter((r) => !r.loading && !r.rxnavExists).length;
            const rrfFound = results.filter((r) => !r.loading && r.rrfExists).length;
            const rrfNotFound = results.filter((r) => !r.loading && !r.rrfExists).length;
            const rxnavPercentage = total > 0 ? ((rxnavFound / total) * 100).toFixed(1) : "0.0";
            const rrfPercentage = total > 0 ? ((rrfFound / total) * 100).toFixed(1) : "0.0";

            return (
              <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
                <h2 className="text-lg font-semibold text-gray-900 mb-4">Validation Statistics</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* RxNav API Statistics */}
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <h3 className="text-sm font-semibold text-gray-700 mb-3">RxNav API Validation</h3>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-600">Found:</span>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-green-700">{rxnavFound}</span>
                          <span className="text-xs text-gray-500">({rxnavPercentage}%)</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-600">Not Found:</span>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-red-700">{rxnavNotFound}</span>
                          <span className="text-xs text-gray-500">
                            ({((rxnavNotFound / total) * 100).toFixed(1)}%)
                          </span>
                        </div>
                      </div>
                      <div className="mt-3 pt-3 border-t border-gray-200">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-gray-700">Total:</span>
                          <span className="text-sm font-semibold text-gray-900">{total}</span>
                        </div>
                        <div className="mt-2">
                          <div className="w-full bg-gray-200 rounded-full h-2">
                            <div
                              className="bg-green-500 h-2 rounded-full transition-all"
                              style={{ width: `${rxnavPercentage}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* RRF File Statistics */}
                  <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
                    <h3 className="text-sm font-semibold text-gray-700 mb-3">RRF File Validation</h3>
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-600">Found:</span>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-green-700">{rrfFound}</span>
                          <span className="text-xs text-gray-500">({rrfPercentage}%)</span>
                        </div>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-sm text-gray-600">Not Found:</span>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium text-red-700">{rrfNotFound}</span>
                          <span className="text-xs text-gray-500">
                            ({((rrfNotFound / total) * 100).toFixed(1)}%)
                          </span>
                        </div>
                      </div>
                      <div className="mt-3 pt-3 border-t border-gray-200">
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-gray-700">Total:</span>
                          <span className="text-sm font-semibold text-gray-900">{total}</span>
                        </div>
                        <div className="mt-2">
                          <div className="w-full bg-gray-200 rounded-full h-2">
                            <div
                              className="bg-green-500 h-2 rounded-full transition-all"
                              style={{ width: `${rrfPercentage}%` }}
                            />
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })()}

          <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white shadow-sm">
            <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-700">
                  Medication
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-700">
                  RxCUI
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-700">
                  RxNav API Validation
                </th>
                <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-700">
                  RRF File Check
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200 bg-white">
              {results.map((result) => (
                <tr key={`${result.medication.rxcui}-${result.medication.name}`} className="hover:bg-gray-50">
                  <td className="whitespace-nowrap px-4 py-3 text-sm font-medium text-gray-900">
                    {result.medication.name}
                  </td>
                  <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-700">
                    {result.medication.rxcui}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700">
                    {result.loading ? (
                      <span className="text-gray-400">Loading...</span>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                              result.rxnavExists
                                ? "bg-green-100 text-green-800"
                                : "bg-red-100 text-red-800"
                            }`}
                          >
                            {result.rxnavExists ? "✓ Exists" : "✗ Not Found"}
                          </span>
                        </div>
                        {result.rxnavError && (
                          <span className="text-xs text-red-600">{result.rxnavError}</span>
                        )}
                        {result.rxnavResponse?.properties && (
                          <div className="text-xs text-gray-600 space-y-1">
                            {result.rxnavResponse.properties.name && (
                              <div>
                                <span className="font-medium">Name:</span> {result.rxnavResponse.properties.name}
                              </div>
                            )}
                            {result.rxnavResponse.properties.tty && (
                              <div>
                                <span className="font-medium">TTY:</span> {result.rxnavResponse.properties.tty}
                              </div>
                            )}
                            {result.rxnavResponse.properties.status && (
                              <div>
                                <span className="font-medium">Status:</span>{" "}
                                <span
                                  className={
                                    result.rxnavResponse.properties.status === "Active"
                                      ? "text-green-600"
                                      : "text-red-600"
                                  }
                                >
                                  {result.rxnavResponse.properties.status}
                                </span>
                              </div>
                            )}
                          </div>
                        )}
                        {result.rxnavStatusResponse && (
                          <div className="text-xs text-gray-600 space-y-1 mt-2 pt-2 border-t border-gray-200">
                            <div className="font-medium text-gray-700">Status API Response:</div>
                            {result.rxnavStatusResponse.rxcuiStatus ? (
                              <>
                                {result.rxnavStatusResponse.rxcuiStatus.rxcui && (
                                  <div>
                                    <span className="font-medium">RxCUI:</span> {result.rxnavStatusResponse.rxcuiStatus.rxcui}
                                  </div>
                                )}
                                {result.rxnavStatusResponse.rxcuiStatus.status && (
                                  <div>
                                    <span className="font-medium">Status:</span>{" "}
                                    <span
                                      className={
                                        result.rxnavStatusResponse.rxcuiStatus.status === "Active"
                                          ? "text-green-600"
                                          : "text-red-600"
                                      }
                                    >
                                      {result.rxnavStatusResponse.rxcuiStatus.status}
                                    </span>
                                  </div>
                                )}
                              </>
                            ) : (
                              <div className="text-gray-500 italic">Status response received (see full response below)</div>
                            )}
                          </div>
                        )}
                        <div className="flex flex-col gap-2 mt-2">
                          {result.rxnavResponse && (
                            <details className="text-xs">
                              <summary className="cursor-pointer text-gray-600 hover:text-gray-900">
                                View Properties API Response (properties.json)
                              </summary>
                              <pre className="mt-2 max-h-40 overflow-auto rounded bg-gray-50 p-2 text-[10px]">
                                {JSON.stringify(result.rxnavResponse, null, 2)}
                              </pre>
                            </details>
                          )}
                          <details className="text-xs">
                            <summary className="cursor-pointer text-gray-600 hover:text-gray-900">
                              View Status API Response (status.json)
                            </summary>
                            {result.rxnavStatusResponse ? (
                              <pre className="mt-2 max-h-40 overflow-auto rounded bg-gray-50 p-2 text-[10px]">
                                {JSON.stringify(result.rxnavStatusResponse, null, 2)}
                              </pre>
                            ) : (
                              <div className="mt-2 text-xs text-gray-500 italic p-2">
                                Status API response not available
                              </div>
                            )}
                          </details>
                        </div>
                        {!result.rxnavResponse?.properties && result.rxnavResponse && (
                          <div className="text-xs text-red-600">
                            Empty response - RxCUI not found in RxNav
                          </div>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700">
                    {result.loading ? (
                      <span className="text-gray-400">Loading...</span>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <div className="flex items-center gap-2">
                          <span
                            className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                              result.rrfExists
                                ? "bg-green-100 text-green-800"
                                : "bg-red-100 text-red-800"
                            }`}
                          >
                            {result.rrfExists ? "✓ Exists" : "✗ Not Found"}
                          </span>
                          {result.rrfExists && (
                            <span
                              className={`inline-flex items-center rounded-full px-2 py-1 text-xs font-medium ${
                                result.rrfHasSU
                                  ? "bg-blue-100 text-blue-800"
                                  : "bg-yellow-100 text-yellow-800"
                              }`}
                            >
                              {result.rrfHasSU ? "Has SU" : "No SU"}
                            </span>
                          )}
                        </div>
                        {result.rrfError && (
                          <span className="text-xs text-red-600">{result.rrfError}</span>
                        )}
                        {result.rrfMatches.length > 0 && (
                          <details className="text-xs">
                            <summary className="cursor-pointer text-gray-600 hover:text-gray-900">
                              View {result.rrfMatches.length} match(es)
                            </summary>
                            <div className="mt-2 space-y-1">
                              {result.rrfMatches.slice(0, 5).map((match, idx) => (
                                <div key={idx} className="rounded bg-gray-50 p-2">
                                  <div className="font-medium">{match.str}</div>
                                  <div className="text-[10px] text-gray-500">
                                    TTY: {match.tty} | SAB: {match.sab}
                                  </div>
                                </div>
                              ))}
                              {result.rrfMatches.length > 5 && (
                                <div className="text-[10px] text-gray-500">
                                  ... and {result.rrfMatches.length - 5} more
                                </div>
                              )}
                            </div>
                          </details>
                        )}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}

      {/* LLM Response Display */}
      {llmResponse && (
        <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">LLM Response</h2>
          <details className="text-sm" open={false}>
            <summary className="cursor-pointer text-gray-700 hover:text-gray-900 font-medium mb-2">
              View Raw LLM Response
            </summary>
            <pre className="mt-2 max-h-96 overflow-auto rounded bg-gray-50 p-4 text-xs border border-gray-200">
              {JSON.stringify(llmResponse, null, 2)}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

