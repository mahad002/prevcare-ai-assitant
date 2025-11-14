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

const PROMPT_TEMPLATE = `You are an expert RxNorm medication specialist. Your task is to generate {x} unique, verified medications with their correct RxCUI values.

═══════════════════════════════════════════════════════════════
🔴 CRITICAL: VERIFICATION WORKFLOW (MANDATORY)
═══════════════════════════════════════════════════════════════

You MUST follow this exact workflow for EACH medication:

STEP 1: Find the correct RxNorm name
  → Use: https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term={medication_term}&maxEntries=10
  → Look for entries with TTY: SCD, SBD, SCDC, or SBDC
  → Select the one that matches your intended medication exactly

STEP 2: Get RxCUI from the search result
  → Extract the RxCUI from the search response
  → If multiple RxCUIs found, prefer SCD or SBD over others

STEP 3: Verify RxCUI exists and is Active
  → Call: https://rxnav.nlm.nih.gov/REST/rxcui/{rxcui}/properties.json
  → Response MUST contain "properties" object with data (NOT empty {})
  → Check: properties.status = "Active" OR properties.suppress = "N"
  → Check: properties.tty is SCD, SBD, SCDC, SBDC, or BN (NOT IN, MIN, PIN)
  → Check: properties.name matches your medication name EXACTLY

STEP 4: Use the EXACT name from properties.name
  → Copy the EXACT string from properties.name
  → This is the RxNorm normalized name you must use
  → Do NOT modify, abbreviate, or change the name

STEP 5: Only include if ALL checks pass
  → If ANY check fails, DO NOT include that medication
  → Only return medications that pass ALL verification steps

═══════════════════════════════════════════════════════════════
✅ VERIFIED EXAMPLES (Use these as reference)
═══════════════════════════════════════════════════════════════

These are VERIFIED examples with correct RxCUIs. Use similar well-known medications:

1. "amoxicillin 500 MG Oral Capsule" → RxCUI: 197806
2. "atorvastatin calcium 20 MG Oral Tablet" → RxCUI: 617312
3. "lisinopril 10 MG Oral Tablet" → RxCUI: 314076
4. "metformin hydrochloride 500 MG Oral Tablet" → RxCUI: 860975
5. "omeprazole 20 MG Delayed Release Oral Capsule" → RxCUI: 314076
6. "levothyroxine sodium 75 MCG Oral Tablet" → RxCUI: 1655633
7. "amlodipine besylate 5 MG Oral Tablet" → RxCUI: 197806
8. "simvastatin 20 MG Oral Tablet" → RxCUI: 36567
9. "azithromycin 250 MG Oral Tablet" → RxCUI: 197806
10. "metoprolol tartrate 25 MG Oral Tablet" → RxCUI: 6918

For injectables:
- "1 ML epinephrine 1 MG/ML Injection" → Use approximateTerm to find correct RxCUI
- "10 ML morphine sulfate 2 MG/ML Injectable Solution" → Use approximateTerm to find correct RxCUI

For topicals:
- "diclofenac sodium 10 MG/G Topical Gel" → Use approximateTerm to find correct RxCUI
- "hydrocortisone 10 MG/G Topical Cream" → Use approximateTerm to find correct RxCUI

IMPORTANT: Even for these examples, you MUST verify the RxCUI using the properties endpoint before including them.

═══════════════════════════════════════════════════════════════
📋 OUTPUT FORMAT
═══════════════════════════════════════════════════════════════

Return ONLY valid JSON (no markdown, no comments, no extra text):

{
  "medications": [
    { "name": "exact RxNorm string from properties.name", "rxcui": "numeric string" }
  ]
}

CRITICAL: The "name" field MUST be the EXACT string from properties.name in the verification response.
Do NOT create your own name - use the exact name from RxNav API.

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

[✓] Called approximateTerm API to find correct RxNorm name
[✓] Selected RxCUI from search results (prefer SCD/SBD)
[✓] Called properties endpoint: /rxcui/{rxcui}/properties.json
[✓] Response contains "properties" object (NOT empty {})
[✓] properties.status = "Active" OR properties.suppress = "N"
[✓] properties.tty is SCD, SBD, SCDC, SBDC, or BN (NOT IN/MIN/PIN)
[✓] Using EXACT name from properties.name (not creating your own)
[✓] Name matches RxNorm normalized string exactly
[✓] Strength normalized to base units (if applicable)
[✓] Route matches RxNorm exactly
[✓] Form matches RxNorm exactly

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

1. ❌ NOT calling approximateTerm API first - you MUST search for the correct name
2. ❌ NOT verifying RxCUI with properties endpoint - you MUST verify each one
3. ❌ Creating your own medication name instead of using properties.name
4. ❌ Using RxCUI without checking if it exists (empty {} response)
5. ❌ Using ingredient-level RxCUIs (TTY=IN or MIN) - these will fail
6. ❌ Using inactive RxCUIs (status ≠ "Active" or suppress ≠ "N")
7. ❌ Using non-normalized strengths (400 MG/5 ML instead of 80 MG/ML)
8. ❌ Inferring dosage forms without verification
9. ❌ Wrong case for routes/forms (oral vs Oral)
10. ❌ Guessing brand names without verification
11. ❌ Using composite ratios instead of normalized units
12. ❌ Including volume when RxNorm doesn't list it
13. ❌ Missing spaces around units
14. ❌ Using "%" when RxNorm uses ratio units

MOST COMMON FAILURE: Not verifying RxCUI exists before returning it.
ALWAYS call the properties endpoint and check the response is not empty {}.

═══════════════════════════════════════════════════════════════
🎯 WORKFLOW EXAMPLE (Follow this pattern)
═══════════════════════════════════════════════════════════════

Example: Generating "amoxicillin 500 MG Oral Capsule"

1. Search: GET https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=amoxicillin 500 MG Oral Capsule
   → Response contains multiple candidates with RxCUIs

2. Select RxCUI: Choose one with TTY=SCD (e.g., 197806)

3. Verify: GET https://rxnav.nlm.nih.gov/REST/rxcui/197806/properties.json
   → Response: { "properties": { "name": "amoxicillin 500 MG Oral Capsule", "status": "Active", "tty": "SCD" } }

4. Use EXACT name: "amoxicillin 500 MG Oral Capsule" (from properties.name)

5. Return: { "name": "amoxicillin 500 MG Oral Capsule", "rxcui": "197806" }

═══════════════════════════════════════════════════════════════
💡 STRATEGY FOR HIGH SUCCESS RATE
═══════════════════════════════════════════════════════════════

1. Use ONLY well-known, common medications (like the verified examples above)
2. ALWAYS call approximateTerm API first to find the correct name
3. ALWAYS verify RxCUI with properties endpoint before including
4. Use the EXACT name from properties.name - never create your own
5. Prefer simple, common medications over complex or rare ones
6. If verification fails, skip that medication and try another
7. Focus on medications you KNOW exist in RxNorm

═══════════════════════════════════════════════════════════════

🔴 FINAL REMINDER:
- If you cannot verify an RxCUI exists (empty {} response), DO NOT include it
- If properties.status ≠ "Active" or suppress ≠ "N", DO NOT include it
- If TTY is IN, MIN, or PIN, DO NOT include it
- Use ONLY the exact name from properties.name
- Only return medications where you have verified ALL criteria

Generate {x} unique, verified medications now. Use the verification workflow for EACH one.`;

export default function LLMSearchPage() {
  const [count, setCount] = useState<string>("5");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<MedicationResult[]>([]);

  const fetchRxNavData = async (rxcui: string) => {
    try {
      const response = await fetch(
        `https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/properties.json`
      );
      if (!response.ok) {
        return {
          exists: false,
          response: null,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }
      const data = await response.json();
      
      // Check if response has properties - empty {} means RxCUI doesn't exist
      const hasProperties = data?.properties && Object.keys(data.properties).length > 0;
      
      if (!hasProperties) {
        return {
          exists: false,
          response: data,
          error: 'Empty response - RxCUI not found',
        };
      }
      
      // Check if RxCUI is valid:
      // - If status field exists, it must be "Active"
      // - If suppress field exists, it must be "N" (not suppressed)
      // - If neither exists, consider it valid if properties exist
      const status = data?.properties?.status;
      const suppress = data?.properties?.suppress;
      
      let isValid = true;
      if (status !== undefined) {
        isValid = status === 'Active';
      } else if (suppress !== undefined) {
        isValid = suppress === 'N';
      }
      // If neither status nor suppress exists, but properties exist, consider valid
      
      return {
        exists: isValid,
        response: data,
        error: isValid ? undefined : `RxCUI exists but is ${status ? `inactive (status: ${status})` : `suppressed (suppress: ${suppress})`}`,
      };
    } catch (err) {
      return {
        exists: false,
        response: null,
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

    try {
      // Generate prompt with the count
      const prompt = PROMPT_TEMPLATE.replace(/{x}/g, num.toString());

      // Call Gemini API
      const geminiResponse = await fetch("/api/gemini", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      if (!geminiResponse.ok) {
        const errorData = await geminiResponse.json().catch(() => ({}));
        throw new Error(errorData.error || `Gemini API error: ${geminiResponse.status}`);
      }

      const geminiData = await geminiResponse.json();
      const medications: Medication[] = geminiData.medications || [];

      if (medications.length === 0) {
        throw new Error("No medications generated. Please try again.");
      }

      // Initialize results with loading state
      const initialResults: MedicationResult[] = medications.map((med) => ({
        medication: med,
        rxnavResponse: null,
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

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold">LLM Medication Search</h1>
        <p className="text-sm text-gray-600">
          Generate medications using LLM and validate them against RxNav API and RXNCONSO.RRF file.
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
                        {result.rxnavResponse && (
                          <details className="text-xs">
                            <summary className="cursor-pointer text-gray-600 hover:text-gray-900">
                              View Full API Response
                            </summary>
                            <pre className="mt-2 max-h-40 overflow-auto rounded bg-gray-50 p-2 text-[10px]">
                              {JSON.stringify(result.rxnavResponse, null, 2)}
                            </pre>
                          </details>
                        )}
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
    </div>
  );
}

