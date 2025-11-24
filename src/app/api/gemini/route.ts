import { NextResponse } from "next/server";
import { join } from "path";
import { readFile } from "fs/promises";
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
    name: "search_rrf_medications",
    description: "Search for medications in the RRF (RxNorm) file by medication name. Use this to find accurate medication names and their RxCUIs before generating results.",
    parameters: {
      type: "object",
      properties: {
        searchTerm: {
          type: "string",
          description: "The medication name or term to search for (e.g., 'amoxicillin 500 MG', 'atorvastatin', 'lisinopril 10 MG Oral Tablet')",
        },
      },
      required: ["searchTerm"],
    },
  },
  {
    name: "verify_rxcui_in_rrf",
    description: "Verify if an RxCUI exists in the RRF file and get its details. Use this to confirm that a medication RxCUI is valid and exists in the RRF database before including it in results.",
    parameters: {
      type: "object",
      properties: {
        rxcui: {
          type: "string",
          description: "The RxCUI (RxNorm Concept Unique Identifier) to verify (e.g., '197806', '617312')",
        },
      },
      required: ["rxcui"],
    },
  },
];

// Execute function calls directly (no HTTP overhead)
async function executeFunction(functionName: string, args: any): Promise<any> {
  if (functionName === "search_rrf_medications") {
    await ensureCatalogLoaded();
    const matches = approximateMatch(args.searchTerm?.trim() || "", 20);
    
    // Get full concept data from cache
    const fullMatches = matches.map((m) => {
      const concept = conceptsCache?.find((c) => c.rxcui === m.rxcui);
      return {
        rxcui: m.rxcui,
        name: m.name,
        tty: m.tty,
        score: m.score,
        route: concept?.route,
        form: concept?.form,
        ingredients: concept?.ingredients,
        brand: concept?.brand,
      };
    });
    
    return {
      success: true,
      action: "search",
      searchTerm: args.searchTerm,
      matches: fullMatches,
      count: matches.length,
    };
  } else if (functionName === "verify_rxcui_in_rrf") {
    const rxcui = String(args.rxcui || "").trim();
    if (!rxcui) {
      return {
        success: false,
        error: "rxcui is required",
        exists: false,
      };
    }

    const rrfPath = join(process.cwd(), "public", "rrf", "RXNCONSO.RRF");
    const content = await readFile(rrfPath, "utf-8");
    const lines = content.split(/\r?\n/);

    const matches: Array<{
      rxcui: string;
      tty: string;
      str: string;
      sab: string;
    }> = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      const parts = line.trim().split("|");
      if (parts.length < 15) continue;

      const lineRxcui = parts[0]?.trim();
      if (lineRxcui === rxcui) {
        const tty = parts[12]?.trim() || "";
        const str = parts[14]?.trim() || "";
        const sab = parts[11]?.trim() || "";

        if (sab === "RXNORM") {
          matches.push({
            rxcui: lineRxcui,
            tty,
            str,
            sab,
          });
        }
      }
    }

    const hasSU = matches.some((m) => m.tty === "SU");
    const preferredMatches = matches.filter(
      (m) => m.tty === "SCD" || m.tty === "SBD" || m.tty === "SCDC" || m.tty === "SBDC"
    );

    return {
      success: true,
      action: "verify_rxcui",
      rxcui,
      exists: matches.length > 0,
      hasSU,
      matches: preferredMatches.length > 0 ? preferredMatches : matches,
      count: matches.length,
      preferredName:
        preferredMatches.length > 0
          ? preferredMatches[0].str
          : matches.length > 0
          ? matches[0].str
          : null,
    };
  } else {
    throw new Error(`Unknown function: ${functionName}`);
  }
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
        // Calculate max iterations based on prompt - estimate 2 function calls per medication
        // Extract medication count from prompt if possible
        const medicationCountMatch = prompt.match(/generate\s+(\d+)|{x}|(\d+)\s+unique.*medications/i);
        const estimatedCount = medicationCountMatch 
          ? parseInt(medicationCountMatch[1] || medicationCountMatch[2] || "5", 10)
          : 5;
        // Each medication needs ~2 function calls (search + verify), add buffer
        const maxIterations = Math.max(10, estimatedCount * 3); // At least 10, or 3x the count
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


