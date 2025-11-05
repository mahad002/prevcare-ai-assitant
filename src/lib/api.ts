// =======================
// 🔐 Environment Variables
// =======================
const OPENAI_KEY = process.env.NEXT_PUBLIC_OPENAI_API_KEY!;
const GEMINI_KEY = process.env.NEXT_PUBLIC_GEMINI_API_KEY!;

// =======================
// 🤖 OpenAI (GPT-5 / 4o / 4-Turbo)
// =======================
export async function queryOpenAI(prompt: string) {
  if (!OPENAI_KEY) throw new Error("OpenAI API key is not configured");

  const models = ["gpt-5", "gpt-4o", "gpt-4-turbo"];

  for (const model of models) {
    try {
      // Build payload dynamically — GPT-5 does not accept custom temperature
      const payload: any = {
        model,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      };
      if (!model.startsWith("gpt-5")) payload.temperature = 0.7;

      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_KEY}`,
        },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        if (res.status === 404) {
          console.warn(`Model ${model} unavailable, trying next...`);
          continue;
        }
        const errText = await res.text();
        throw new Error(`OpenAI(${model}) error ${res.status}: ${errText}`);
      }

      const json = await res.json();
      const content = json?.choices?.[0]?.message?.content ?? "{}";

      console.log(`✅ Using OpenAI model: ${model}`);

      try {
        return JSON.parse(content);
      } catch {
        console.error("Failed to parse OpenAI JSON:", content);
        return {};
      }
    } catch (err) {
      if (model === models[models.length - 1]) throw err;
    }
  }

  throw new Error("All OpenAI models failed.");
}

// =======================
// 🌟 Gemini
// =======================
export async function queryGemini(prompt: string) {
  if (!GEMINI_KEY) throw new Error("Gemini API key is not configured");

  // Use only the requested Gemini model
  const models = ["gemini-2.5-pro"];

  // If running in the browser, use the server-side proxy to avoid CORS and key exposure
  if (typeof window !== "undefined") {
    const res = await fetch("/api/gemini", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, models }),
    });
    const text = await res.text();
    try { return JSON.parse(text); } catch { return { raw: text }; }
  }

  const extractJson = (txt: string) => {
    const start = txt.indexOf("{");
    const end = txt.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try { return JSON.parse(txt.slice(start, end + 1)); } catch {}
    }
    return { raw: txt };
  };

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" },
        }),
      });

      const raw = await res.text();
      let data: any = {};
      try { data = JSON.parse(raw); } catch {}

      if (!res.ok) {
        if (res.status === 404) {
          console.warn(`⚠️ Model ${model} not found, trying next...`);
          continue;
        }
        const msg = data?.error?.message || raw || res.statusText;
        throw new Error(`Gemini(${model}) error ${res.status}: ${msg}`);
      }

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
      console.log(`✅ Successfully using Gemini model: ${model}`);

      try {
        return JSON.parse(text);
      } catch {
        console.warn("⚠️ Gemini returned non-JSON text, attempting extraction");
        return extractJson(text);
      }
    } catch (err) {
      console.error(`Gemini(${model}) failed:`, err);
      if (model === models[models.length - 1]) {
        throw new Error(`All Gemini models failed: ${String(err)}`);
      }
    }
  }
}

// =======================
// ⚙️ Unified Query Helper
// =======================
export async function queryAI(prompt: string) {
  try {
    return await queryOpenAI(prompt);
  } catch (err) {
    console.warn("OpenAI failed, falling back to Gemini...");
    return await queryGemini(prompt);
  }
}

// =======================
// 💊 RxNorm / Drug Utilities
// =======================
export async function getRxCui(drugName: string): Promise<string | null> {
  try {
    const trimmedName = drugName.trim();
    
    // Strategy 1: Try the full drug name first (e.g., "Omeprazole 20 MG Oral Capsule")
    // This gives us the specific product RxCUI (e.g., 207212)
    const fullRes = await fetch(
      `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(trimmedName)}`
    );
    
    if (fullRes.ok) {
      const fullJson = await fullRes.json();
      const rxcui = fullJson?.idGroup?.rxnormId?.[0];
      if (rxcui) {
        console.log(`✓ Found RxCUI ${rxcui} for full name: "${trimmedName}"`);
        return rxcui;
      }
    }
    
    // Strategy 2: If full name doesn't work, try with common variations
    // Remove "Oral" prefix if present (e.g., "Omeprazole 20 MG Capsule")
    const withoutOral = trimmedName.replace(/\bOral\s+/i, '').trim();
    if (withoutOral !== trimmedName) {
      const oralRes = await fetch(
        `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(withoutOral)}`
      );
      if (oralRes.ok) {
        const oralJson = await oralRes.json();
        const rxcui = oralJson?.idGroup?.rxnormId?.[0];
        if (rxcui) {
          console.log(`✓ Found RxCUI ${rxcui} for: "${withoutOral}"`);
          return rxcui;
        }
      }
    }
    
    // Strategy 3: Fall back to generic name only (e.g., "Omeprazole")
    // This gives us the ingredient RxCUI (e.g., 7646) as last resort
    const genericName = trimmedName.split(/\s+/)[0].trim();
    if (genericName !== trimmedName) {
      const genericRes = await fetch(
        `https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(genericName)}`
      );
      if (genericRes.ok) {
        const genericJson = await genericRes.json();
        const rxcui = genericJson?.idGroup?.rxnormId?.[0];
        if (rxcui) {
          console.warn(`⚠ Using generic RxCUI ${rxcui} for "${genericName}" (full name not found)`);
          return rxcui;
        }
      }
    }

    // Strategy 4: Approximate match (handles small naming diffs like strength/unit order)
    const approxRes = await fetch(
      `https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=${encodeURIComponent(trimmedName)}&maxEntries=1`
    );
    if (approxRes.ok) {
      const approxJson = await approxRes.json();
      const candidate = approxJson?.approximateGroup?.candidate?.[0]?.rxcui;
      if (candidate) {
        console.log(`✓ Approximate RxCUI match ${candidate} for "${trimmedName}"`);
        return String(candidate);
      }
    }
    
    console.warn(`✗ No RxCUI found for: "${trimmedName}"`);
    return null;
  } catch (e) {
    console.error(`Error fetching RxCUI for "${drugName}":`, e);
    return null;
  }
}

// Fetch multiple RxCUI candidates for a given name, including properties
export async function getRxCuiCandidates(drugName: string, maxTotal: number = 8): Promise<Array<{ rxcui: string; name?: string; tty?: string }>> {
  const out: Array<{ rxcui: string; name?: string; tty?: string }> = [];
  try {
    const trimmedName = drugName.trim();
    const addWithProps = async (rx: string) => {
      try {
        const props = await getRxcuiProps(rx);
        out.push({ rxcui: rx, name: props?.name, tty: props?.tty });
      } catch {
        out.push({ rxcui: rx });
      }
    };

    // Collect from exact name search (may return multiple ids)
    const res = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui.json?name=${encodeURIComponent(trimmedName)}`);
    if (res.ok) {
      const j = await res.json();
      const ids: string[] = j?.idGroup?.rxnormId || [];
      for (const rx of ids) {
        if (out.length >= maxTotal) break;
        await addWithProps(String(rx));
      }
    }

    // If we still have room, add approximate matches
    if (out.length < maxTotal) {
      const approx = await fetch(`https://rxnav.nlm.nih.gov/REST/approximateTerm.json?term=${encodeURIComponent(trimmedName)}&maxEntries=${maxTotal}`);
      if (approx.ok) {
        const aj = await approx.json();
        const candidates: Array<{ rxcui?: string | number }> = aj?.approximateGroup?.candidate || [];
        for (const c of candidates) {
          const rx = c?.rxcui != null ? String(c.rxcui) : null;
          if (!rx) continue;
          if (out.some((e) => e.rxcui === rx)) continue;
          if (out.length >= maxTotal) break;
          await addWithProps(rx);
        }
      }
    }

    return out;
  } catch (e) {
    console.error("Error fetching RxCUI candidates:", e);
    return out;
  }
}

// -----------------------
// 🚫 RxCUI Validation (temporarily disabled)
// -----------------------
export async function validateRxCui(rxcui: string): Promise<boolean> {
  try {
    const res = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/properties.json`);
    if (!res.ok) return false;
    const json = await res.json();
    console.log(`✓ RxCUI ${rxcui} valid: ${json?.properties?.name ?? rxcui}`);
    return true;
  } catch (e) {
    console.error(`Error validating RxCUI ${rxcui}:`, e);
    return false;
  }
}

export async function getRxcuiProps(rxcui: string) {
  try {
    const res = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/properties.json`);
    if (!res.ok) return null;
    const json = await res.json();
    return json?.properties || null;
  } catch (e) {
    console.error(`Error fetching RxCUI properties for ${rxcui}:`, e);
    return null;
  }
}

export async function getNDCs(rxcui: string) {
  try {
    const ndcs = new Set<string>();
    const collect = async (url: string, key: string) => {
      const res = await fetch(url);
      if (!res.ok) return;
      const j = await res.json();
      (j?.[key]?.ndcList?.ndc ?? j?.[key]?.ndc ?? []).forEach((n: string) => ndcs.add(n));
    };

    await collect(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/ndcs.json`, "ndcGroup");
    await collect(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/historicalndcs.json`, "historicalNdcConcept");

    const related = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${rxcui}/related.json?tty=SCD+SBD`);
    if (related.ok) {
      const j = await related.json();
      const relatedIds =
        j?.relatedGroup?.conceptGroup?.flatMap((g: any) => g?.conceptProperties ?? [])?.map((p: any) => p?.rxcui) || [];
      await Promise.all(
        relatedIds.slice(0, 10).map(async (rx: string) => {
          const r = await fetch(`https://rxnav.nlm.nih.gov/REST/rxcui/${rx}/ndcs.json`);
          if (r.ok) {
            const jr = await r.json();
            (jr?.ndcGroup?.ndcList?.ndc ?? []).forEach((n: string) => ndcs.add(n));
          }
        })
      );
    }

    return Array.from(ndcs);
  } catch (e) {
    console.error("Error fetching NDCs:", e);
    return [];
  }
}

export async function getFDAInfo(ndc: string) {
  try {
    const res = await fetch(`https://api.fda.gov/drug/ndc.json?search=product_ndc:${ndc}`);
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.results?.length) return null;
    const r = json.results[0];
    return {
      labeler_name: r.labeler_name,
      marketing_status: r.marketing_status,
      package_description: r.packaging?.[0]?.description,
      marketing_start: r.marketing_start_date,
      marketing_end: r.marketing_end_date,
      dea_schedule: r.dea_schedule,
      is_active: !r.marketing_end_date,
    };
  } catch (e) {
    console.error("Error fetching FDA info:", e);
    return null;
  }
}

export async function getNDCStatus(ndc: string) {
  try {
    const res = await fetch(`https://rxnav.nlm.nih.gov/REST/ndcstatus.json?ndc=${encodeURIComponent(ndc)}`);
    if (!res.ok) return null;
    const json = await res.json();
    return json?.ndcStatus || null;
  } catch (e) {
    console.error(`Error fetching NDC status for ${ndc}:`, e);
    return null;
  }
}

// =======================
// OpenAI + Gemini helpers
// =======================

export async function callOpenAI(model: string, prompt: string) {
  if (!OPENAI_KEY) {
    throw new Error("OpenAI API key is not configured");
  }
  const body: any = {
    model,
    messages: [{ role: "user", content: prompt }],
  };
  // response_format may not be supported on some experimental models
  if (model !== "gpt-5") body.response_format = { type: "json_object" };
  // Some models only support default temperature; omit for gpt-5
  if (model !== "gpt-5") body.temperature = 0.3;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const raw = await res.text();
  let data: any = {};
  try { data = JSON.parse(raw); } catch {}
  if (!res.ok) {
    const msg = data?.error?.message || data?.message || raw || res.statusText;
    throw new Error(`OpenAI(${model}) error ${res.status}: ${msg}`);
  }
  const text = data?.choices?.[0]?.message?.content ?? "{}";
  try { return JSON.parse(text); } catch { return {}; };
}

// Raw variant for debugging/inspection. Does not enforce response_format for models that may reject it.
export async function callOpenAIRaw(model: string, prompt: string) {
  if (!OPENAI_KEY) throw new Error("OpenAI API key is not configured");
  const useJsonFormat = model !== "gpt-5"; // some experimental models may reject response_format
  const body: any = {
    model,
    messages: [{ role: "user", content: prompt }],
  };
  if (useJsonFormat) body.response_format = { type: "json_object" };
  // Omit temperature for gpt-5 which may only support default
  if (model !== "gpt-5") body.temperature = 0.3;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${OPENAI_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const httpBody = await res.text();
  let json: any = undefined;
  try { json = JSON.parse(httpBody); } catch {}

  // Try extract model message content if present
  let parsed: any = {};
  try {
    const content = json?.choices?.[0]?.message?.content ?? "{}";
    parsed = JSON.parse(content);
  } catch {
    parsed = {};
  }

  return {
    parsed,
    http: { ok: res.ok, status: res.status, body: httpBody },
  } as const;
}

// Alias for Gemini
export const callGemini = queryGemini;
