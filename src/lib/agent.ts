import { queryOpenAI, queryGemini } from "./api";
import { medicationPrompt } from "./prompts";

// =======================
// 📋 Type Definitions
// =======================
type Drug = {
  drug_name: string;
  drug_class?: string;
  strength?: string;
  dosage_form?: string;
  route?: string;
  rxcui?: string;
};

type AIResponse = {
  diagnosis?: string;
  recommended_drugs?: Drug[];
};

// =======================
// 🧠 Utility Functions
// =======================
function normalizeName(name: string) {
  return name.trim().toLowerCase();
}

function toKey(drug: Drug) {
  return normalizeName(drug.drug_name || "");
}

function safeParse(obj: unknown): AIResponse {
  if (obj && typeof obj === "object") return obj as AIResponse;
  try {
    return JSON.parse(String(obj));
  } catch {
    return {};
  }
}

function mergeConsensus(a: Drug[] = [], b: Drug[] = [], c: Drug[] = []): Drug[] {
  const map = new Map<string, { count: number; sample: Drug }>();

  const add = (list?: Drug[]) => {
    (list || []).forEach((d) => {
      const k = toKey(d);
      if (!k) return;
      const prev = map.get(k);
      if (prev) prev.count += 1;
      else map.set(k, { count: 1, sample: d });
    });
  };

  add(a);
  add(b);
  add(c);

  const consensus: Drug[] = [];
  map.forEach(({ count, sample }) => {
    if (count >= 2) consensus.push(sample);
  });
  return consensus;
}

// =======================
// ⚙️ Core Agent Logic
// =======================
export async function runAgentFlow(condition: string) {
  // 🚨 Input guard
  if (!condition || !condition.trim()) {
    return {
      diagnosis: "invalid_input",
      recommended_drugs: [],
    };
  }

  // 🧠 Build contextual prompt
  const prompt = medicationPrompt(condition.trim()) + `\n\nNow, list medications for: ${condition.trim()}.`;

  console.log("🧾 Running agent flow for:", condition);

  // ⚙️ Run all models concurrently
  const [gpt4oRes, gpt5Res, geminiRes] = await Promise.all([
    queryOpenAI(`${prompt}\n\n[MODEL:gpt-4o]`).catch((e: unknown) => ({ error: String(e) })),
    runGPT5(`${prompt}\n\n[MODEL:gpt-5]`).catch((e: unknown) => ({ error: String(e) })),
    queryGemini(`${prompt}\n\n[MODEL:gemini]`).catch((e: unknown) => ({ error: String(e) })),
  ]);

  // 🧩 Parse safely
  const r4o = safeParse(gpt4oRes);
  const r5 = safeParse(gpt5Res);
  const rg = safeParse(geminiRes);

  // 🧬 Merge consensus across models
  const merged: AIResponse = {
    diagnosis: r5.diagnosis || r4o.diagnosis || rg.diagnosis || condition,
    recommended_drugs: mergeConsensus(
      r4o.recommended_drugs,
      r5.recommended_drugs,
      rg.recommended_drugs
    ),
  };

  // 🔁 If consensus empty, fallback to best available result
  if (!merged.recommended_drugs?.length) {
    merged.recommended_drugs =
      r5.recommended_drugs?.length
        ? r5.recommended_drugs
        : r4o.recommended_drugs?.length
        ? r4o.recommended_drugs
        : rg.recommended_drugs ?? [];
  }

  // ✅ Final verification pass (via GPT-5)
  const verifierPrompt = `
You are a clinical AI verifier. Given three model outputs already merged, return ONLY valid JSON in this schema:
{
  "diagnosis": string,
  "recommended_drugs": [
    {
      "drug_name": string,
      "drug_class"?: string,
      "strength"?: string,
      "dosage_form"?: string,
      "route"?: string
    }
  ]
}
Ensure U.S.-appropriate names/units, no RxCUI/brands, no notes.
Input data to verify:
${JSON.stringify(merged, null, 2)}
`;

  const verified = await runGPT5(verifierPrompt).catch((e) => {
    console.warn("⚠️ GPT-5 verification failed:", e);
    return merged;
  });

  const final = safeParse(verified);

  console.log("✅ Agent flow completed for:", condition);
  return final;
}

// =======================
// 🔍 Parallel Model Results
// =======================
export type AgentOutputs = {
  gpt4o: AIResponse;
  gpt5: AIResponse;
  gemini: AIResponse;
};

export async function runAgentAll(condition: string): Promise<AgentOutputs> {
  const prompt = medicationPrompt(condition);

  const [gpt4oRes, gpt5Res, geminiRes] = await Promise.all([
    queryOpenAI(`${prompt}\n\n[MODEL:gpt-4o]`).catch((e: unknown) => ({ error: String(e) })),
    runGPT5(prompt).catch((e: unknown) => ({ error: String(e) })),
    queryGemini(prompt).catch((e: unknown) => ({ error: String(e) })),
  ]);

  return {
    gpt4o: safeParse(gpt4oRes),
    gpt5: safeParse(gpt5Res),
    gemini: safeParse(geminiRes),
  };
}

// =======================
// 🧩 GPT-5 Direct Wrapper
// =======================
// GPT-5 requires no temperature or JSON enforcement; this ensures compatibility.
async function runGPT5(prompt: string): Promise<AIResponse> {
  const OPENAI_KEY = process.env.NEXT_PUBLIC_OPENAI_API_KEY;
  if (!OPENAI_KEY) throw new Error("OpenAI API key missing for GPT-5");

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-5",
        messages: [{ role: "user", content: prompt }],
        // GPT-5 ignores temperature overrides, so omit it.
      }),
    });

    const raw = await res.text();
    console.log("🔍 GPT-5 raw:", raw.slice(0, 400)); // shorten log

    let data: any = {};
    try {
      data = JSON.parse(raw);
    } catch {
      console.error("⚠️ GPT-5 returned non-JSON HTTP body:", raw);
      return { diagnosis: "parse_error", recommended_drugs: [] };
    }

    // Handle HTTP errors
    if (!res.ok) {
      const msg = data?.error?.message || raw || res.statusText;
      throw new Error(`GPT-5 error ${res.status}: ${msg}`);
    }

    // Extract assistant content
    const content = data?.choices?.[0]?.message?.content ?? "{}";

    // Try parsing the model’s JSON content
    try {
      const parsed = JSON.parse(content);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "recommended_drugs" in parsed
      ) {
        return parsed as AIResponse;
      }
      // fallback if structure is weird
      return { diagnosis: "", recommended_drugs: [] };
    } catch {
      console.warn("⚠️ GPT-5 returned non-JSON content, attempting fallback");
      // Attempt to extract JSON fragment between braces
      const start = content.indexOf("{");
      const end = content.lastIndexOf("}");
      if (start !== -1 && end > start) {
        try {
          return JSON.parse(content.slice(start, end + 1)) as AIResponse;
        } catch {
          /* ignore */
        }
      }
      return { diagnosis: "", recommended_drugs: [] };
    }
  } catch (err: any) {
    console.error("❌ GPT-5 call failed:", err);
    return { diagnosis: "gpt5_error", recommended_drugs: [] };
  }
}
