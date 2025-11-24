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

const PROMPT_TEMPLATE = `You are an expert RxNorm medication specialist and clinical pharmacist. Your job is to return {x} unique medications with correct RxCUIs, fully verified against the RRF (RxNorm) database.{condition_context}

{condition_instructions}

TOOLS YOU CAN CALL
- find_rrf_verified_medications(searchTerm, limit?): returns up to 20 fully verified RxNorm entries (SCD/SBD/SCDC/SBDC/BN) with their exact names, RxCUIs, routes, and forms. The "name" field is already the normalized string you must return.

MINIMAL WORKFLOW FOR {x} MEDICATIONS
1. Plan a diverse, clinically appropriate set of medications (or the ones matched to the condition below).

2. Call find_rrf_verified_medications() with a broad search term and capture multiple promising hits from the response. Queue them up by clinical category.
3. Select the best entries from the queued results (only use matches where \`verified=true\`) and copy their exact \`name\` + \`rxcui\` into your final list.
4. Only perform another search if you still need more medications after exhausting the current queue.

EFFICIENCY REMINDERS
- One search can yield several valid medications—exhaust those results before calling the tool again.
- Prefer well-known RxNorm concepts to avoid ambiguous or inactive entries.
- Stop immediately once you have {x} valid medications.

CLINICAL TARGETS
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

IMPORTANT: Only include medications taken directly from find_rrf_verified_medications() results where \`verified=true\`. Do not fabricate names or RxCUIs.

═══════════════════════════════════════════════════════════════
📋 OUTPUT FORMAT
═══════════════════════════════════════════════════════════════

Return ONLY valid JSON (no markdown, no comments, no extra text):

{
  "medications": [
    { "name": "exact RxNorm string from properties.name", "rxcui": "numeric string" }
  ]
}

CRITICAL: The "name" field MUST be the EXACT \`name\` returned by find_rrf_verified_medications(). Do NOT edit, abbreviate, or reformat it. Keep RxNorm strength/route/form exactly as provided.

Do not include any medication unless the match indicates \`verified=true\`, the TTY is SCD/SBD/SCDC/SBDC/BN, and it is not already in your list.

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

1. ❌ Not calling find_rrf_verified_medications() before picking meds.
2. ❌ Ignoring \`verified=false\` entries or selecting TTY=IN/MIN/PIN.
3. ❌ Editing the RxNorm string instead of copying the exact \`name\`.
4. ❌ Reusing the same RxCUI more than once.
5. ❌ Continuing to search after you have {x} medications.

MOST COMMON FAILURE: Not using the exact name/RxCUI from the tool output.

═══════════════════════════════════════════════════════════════
🎯 WORKFLOW EXAMPLE (Follow this pattern)
═══════════════════════════════════════════════════════════════

Example: Generating "amoxicillin 500 MG Oral Capsule"

1. Search: Call find_rrf_verified_medications("amoxicillin 500 MG")
   → Response contains verified matches (e.g., RxCUI 197806, name "amoxicillin 500 MG Oral Capsule")

2. Use EXACT name: "amoxicillin 500 MG Oral Capsule" and RxCUI "197806".

3. Return: { "name": "amoxicillin 500 MG Oral Capsule", "rxcui": "197806" }

═══════════════════════════════════════════════════════════════
💡 STRATEGY FOR HIGH SUCCESS RATE
═══════════════════════════════════════════════════════════════

1. Use well-known, common medications across diverse categories.
2. Use find_rrf_verified_medications() to fetch batches of viable options.
3. Copy the exact \`name\` + \`rxcui\` from a verified entry—never rewrite it.
4. Prefer TTY SCD/SBD/SCDC/SBDC (BN for brands when applicable).
5. Keep categories and routes diverse (unless the condition dictates otherwise).
6. Stop searching once you have {x} high-quality medications.

═══════════════════════════════════════════════════════════════

🔴 FINAL REMINDER:
- Use find_rrf_verified_medications() to gather all data (name + RxCUI). No other verification step is needed.
- Only include entries marked verified=true and copy their names exactly.
- Generate exactly {x} unique medications—stop searching when you reach that number.
- Work efficiently: reuse matches from a single search before calling the tool again.

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
`
        : `\n═══════════════════════════════════════════════════════════════
✅ MEDICATION SELECTION GUIDELINES
═══════════════════════════════════════════════════════════════

Generate diverse medications across these categories. For EACH one:
1. Call find_rrf_verified_medications() with a relevant search term.
2. Review the returned matches and pick entries marked verified=true.
3. Use the exact RxNorm name provided in the match.

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
      const prompt = PROMPT_TEMPLATE
        .replace(/{x}/g, num.toString())
        .replace(/{condition_context}/g, conditionContext)
        .replace(/{condition_instructions}/g, conditionInstructions)
        .replace(/{medication_selection_instructions}/g, condition.trim() 
          ? `Generate medications specifically appropriate for treating "${condition.trim()}". For EACH one, you MUST:
1. Call find_rrf_verified_medications() with condition-relevant search terms.
2. Select entries marked verified=true that match the clinical need.
3. Use the exact RxNorm name returned by the function.

Focus on medications that are:
- Clinically indicated for ${condition.trim()}
- Commonly prescribed or recommended for this condition
- Available in appropriate formulations (oral, topical, injectable, etc.)
- Include both prescription and OTC options as appropriate`
          : `Generate diverse medications across these categories. For EACH one, you MUST:
1. Call find_rrf_verified_medications() to fetch candidates.
2. Choose entries marked verified=true across different categories.
3. Use the exact RxNorm name returned by the function.

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

