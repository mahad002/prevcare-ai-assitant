import { NextResponse } from "next/server";
import { join } from "path";
import { loadCatalog, approximateMatch } from "@/lib/approxMatch";
import { loadRrfFileToConcepts } from "@/lib/rrfLoader";

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY;

// Cache for RRF concepts
let conceptsCache: Awaited<ReturnType<typeof loadRrfFileToConcepts>> | null = null;
let conceptsCacheTimestamp = 0;
const CACHE_DURATION_MS = 5 * 60 * 1000;

async function ensureCatalogLoaded() {
  const now = Date.now();
  if (conceptsCache && now - conceptsCacheTimestamp < CACHE_DURATION_MS) {
    return;
  }

  const rrfPath = join(process.cwd(), "public", "rrf", "RXNCONSO.RRF");
  const concepts = await loadRrfFileToConcepts(rrfPath);
  loadCatalog(concepts);
  conceptsCache = concepts;
  conceptsCacheTimestamp = now;
}

// Function declarations for Gemini function calling
const FUNCTION_DECLARATIONS = [
  {
    name: "find_rrf_verified_medications",
    description: "Search the RRF (RxNorm) file for medications and return fully verified RxNorm entries (SCD/SBD/SCDC/SBDC) with their RxCUIs, names, and metadata.",
    parameters: {
      type: "object",
      properties: {
        searchTerm: {
          type: "string",
          description: "Medication term to search in RxNorm (e.g., 'amoxicillin 500 MG', 'atorvastatin', 'lisinopril 10 MG Oral Tablet').",
        },
        limit: {
          type: "number",
          description: "Optional limit for number of results (default 20).",
        },
      },
      required: ["searchTerm"],
    },
  },
];

// Execute function calls directly (no HTTP overhead)
async function executeFunction(functionName: string, args: any): Promise<any> {
  if (functionName !== "find_rrf_verified_medications") {
    throw new Error(`Unknown function: ${functionName}`);
  }

  await ensureCatalogLoaded();

  const searchTerm = args.searchTerm?.trim() || "";
  const limit =
    typeof args.limit === "number" && args.limit > 0 ? Math.min(args.limit, 50) : 20;

  const matches = approximateMatch(searchTerm, limit);

  const results = matches
    .map((m) => {
      const concept = conceptsCache?.find((c) => c.rxcui === m.rxcui);
      if (!concept) return null;
      const preferred =
        concept.tty === "SCD" ||
        concept.tty === "SBD" ||
        concept.tty === "SCDC" ||
        concept.tty === "SBDC" ||
        concept.tty === "BN";

      return {
        rxcui: concept.rxcui,
        name: concept.name,
        tty: concept.tty,
        route: concept.route,
        form: concept.form,
        ingredients: concept.ingredients,
        brand: concept.brand,
        verified: preferred,
        score: m.score,
      };
    })
    .filter(Boolean);

  return {
    success: true,
    action: "find_rrf_verified_medications",
    searchTerm,
    matches: results,
    count: results.length,
  };
}

export async function POST(req: Request) {
  try {
    if (!GEMINI_KEY) {
      return NextResponse.json({ error: "Gemini API key is not configured" }, { status: 500 });
    }

    const body = await req.json().catch(() => ({}));
    const prompt: string = body?.prompt ?? "";
    const useFunctionCalling: boolean = body?.useFunctionCalling ?? true;
    // Default models to try (in order of preference)
    // Function calling supported: gemini-2.5-pro, gemini-2.5-flash, gemini-2.5-flash-lite, gemini-2.0-flash
    const models: string[] = Array.isArray(body?.models) && body.models.length
      ? body.models
      : [
          "gemini-2.5-flash",       // Fastest with function calling support
          "gemini-2.5-pro",         // Most capable with function calling
          "gemini-2.5-flash-lite",  // Lightweight option
          "gemini-2.0-flash",       // Fallback
        ];

    if (!prompt.trim()) {
      return NextResponse.json({ error: "Missing prompt" }, { status: 400 });
    }

    const extractJson = (txt: string) => {
      const start = txt.indexOf("{");
      const end = txt.lastIndexOf("}");
      if (start !== -1 && end > start) {
        try { return JSON.parse(txt.slice(start, end + 1)); } catch {}
      }
      return { raw: txt };
    };

    const errors: Array<{ model: string; error: string }> = [];

    for (const model of models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
      try {
        // Build request body
        const requestBody: any = {
          contents: [{ parts: [{ text: prompt }] }],
        };

        // Add function calling if enabled
        if (useFunctionCalling) {
          requestBody.tools = [{
            functionDeclarations: FUNCTION_DECLARATIONS,
          }];
        } else {
          requestBody.generationConfig = { responseMimeType: "application/json" };
        }

        let conversationHistory: any[] = [{ parts: [{ text: prompt }] }];
        // Estimate required iterations from requested medication count (more generous buffer for batching)
        const medicationCountMatch = prompt.match(/(\d+)\s+(?:unique|verified)?\s*medications/i);
        const estimatedCount = medicationCountMatch
          ? parseInt(medicationCountMatch[1], 10)
          : 5;
        // Allow ~4-5 function turns per medication plus extra headroom
        const maxIterations = Math.max(20, estimatedCount * 6);
        let iteration = 0;
        let lastData: any = null; // Store last response data

        while (iteration < maxIterations) {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: conversationHistory,
              ...(useFunctionCalling ? {
                tools: [{
                  functionDeclarations: FUNCTION_DECLARATIONS,
                }],
              } : {
                generationConfig: { responseMimeType: "application/json" },
              }),
            }),
          });

          const raw = await res.text();
          let data: any = {};
          try { data = JSON.parse(raw); } catch {}
          lastData = data; // Store for use outside loop

          if (!res.ok) {
            const errorMsg = data?.error?.message || raw.substring(0, 500) || res.statusText;
            const fullError = `Gemini(${model}) error ${res.status}: ${errorMsg}`;
            
            if (res.status === 404) {
              errors.push({ model, error: fullError });
              // try next model
              break;
            }
            
            // For other errors, log and try next model
            errors.push({ model, error: fullError });
            if (model === models[models.length - 1]) {
              // Last model failed, return detailed error
              return NextResponse.json({ 
                error: "All Gemini models failed",
                details: errors,
                apiKeyConfigured: !!GEMINI_KEY,
                apiKeyLength: GEMINI_KEY?.length || 0,
              }, { status: res.status });
            }
            break; // Try next model
          }

          // Check for function calls
          const candidate = data?.candidates?.[0];
          const content = candidate?.content;
          const parts = content?.parts || [];

          let hasFunctionCall = false;
          for (const part of parts) {
            if (part.functionCall) {
              hasFunctionCall = true;
              const functionCall = part.functionCall;
              
              // Execute the function
              try {
                const functionResult = await executeFunction(
                  functionCall.name,
                  functionCall.args
                );

                // Add function call and result to conversation history
                conversationHistory.push({
                  parts: [{
                    functionCall: {
                      name: functionCall.name,
                      args: functionCall.args,
                    },
                  }],
                });
                conversationHistory.push({
                  parts: [{
                    functionResponse: {
                      name: functionCall.name,
                      response: functionResult,
                    },
                  }],
                });
              } catch (error) {
                // Add error to conversation
                conversationHistory.push({
                  parts: [{
                    functionCall: {
                      name: functionCall.name,
                      args: functionCall.args,
                    },
                  }],
                });
                conversationHistory.push({
                  parts: [{
                    functionResponse: {
                      name: functionCall.name,
                      response: {
                        success: false,
                        error: error instanceof Error ? error.message : String(error),
                      },
                    },
                  }],
                });
              }
            }
          }

          if (!hasFunctionCall) {
            // No more function calls, return the final response
            const text = parts.find((p: any) => p.text)?.text ?? "{}";
            try {
              const parsed = JSON.parse(text);
              return NextResponse.json({
                ...parsed,
                _metadata: {
                  model,
                  iterations: iteration + 1,
                  functionCallsMade: conversationHistory.filter((h: any) => 
                    h.parts?.some((p: any) => p.functionCall)
                  ).length,
                },
              }, { status: 200 });
            } catch {
              return NextResponse.json(extractJson(text), { status: 200 });
            }
          }

          iteration++;
          
          // Safety check: if we're approaching the limit, warn the model
          if (iteration >= maxIterations - 2) {
            conversationHistory.push({
              parts: [{
                text: `⚠️ You are approaching the iteration limit (${maxIterations}). Please complete your medication list and return the final JSON response with all verified medications you have found so far.`,
              }],
            });
          }
        }

        // If we've exhausted iterations, return the last response
        const candidate = lastData?.candidates?.[0];
        const content = candidate?.content;
        const parts = content?.parts || [];
        const text = parts.find((p: any) => p.text)?.text ?? "{}";
        try {
          const parsed = JSON.parse(text);
          return NextResponse.json({
            ...parsed,
            _metadata: {
              model,
              iterations: maxIterations,
              maxIterationsReached: true,
              functionCallsMade: conversationHistory.filter((h: any) => 
                h.parts?.some((p: any) => p.functionCall)
              ).length,
              warning: "Reached maximum iterations, returning partial results",
            },
          }, { status: 200 });
        } catch {
          return NextResponse.json({
            ...extractJson(text),
            _metadata: {
              model,
              iterations: maxIterations,
              maxIterationsReached: true,
              warning: "Reached maximum iterations",
            },
          }, { status: 200 });
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        errors.push({ model, error: errorMsg });
        // try next model
        continue;
      }
    }

    // All models failed
    return NextResponse.json({ 
      error: "All Gemini models failed",
      details: errors,
      apiKeyConfigured: !!GEMINI_KEY,
      apiKeyLength: GEMINI_KEY?.length || 0,
      suggestion: "Check /api/gemini/test to verify your API key and available models",
    }, { status: 502 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}


