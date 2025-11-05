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
