import { NextResponse } from "next/server";

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY;

export async function GET() {
  try {
    // Check if API key exists
    if (!GEMINI_KEY) {
      return NextResponse.json({
        success: false,
        error: "Gemini API key is not configured",
        details: {
          checkedEnvVars: ["GEMINI_API_KEY", "NEXT_PUBLIC_GEMINI_API_KEY"],
          found: false,
        },
      }, { status: 500 });
    }

    // Test with a simple prompt
    const testModels = [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-2.0-flash",
      "gemini-1.5-pro",
      "gemini-1.5-flash",
    ];

    const results: Array<{
      model: string;
      success: boolean;
      error?: string;
      response?: any;
    }> = [];

    for (const model of testModels) {
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
        
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: "Say 'Hello, API is working!' in JSON format: {\"message\": \"your response\"}" }] }],
            generationConfig: { responseMimeType: "application/json" },
          }),
        });

        const raw = await res.text();
        let data: any = {};
        try {
          data = JSON.parse(raw);
        } catch {
          data = { raw };
        }

        if (!res.ok) {
          results.push({
            model,
            success: false,
            error: data?.error?.message || `HTTP ${res.status}: ${raw.substring(0, 200)}`,
          });
          continue;
        }

        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
        results.push({
          model,
          success: true,
          response: text.substring(0, 200),
        });
      } catch (err) {
        results.push({
          model,
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const workingModels = results.filter((r) => r.success);
    const failedModels = results.filter((r) => !r.success);

    return NextResponse.json({
      success: workingModels.length > 0,
      apiKeyConfigured: true,
      apiKeyLength: GEMINI_KEY.length,
      apiKeyPrefix: GEMINI_KEY.substring(0, 10) + "...",
      workingModels: workingModels.map((r) => r.model),
      failedModels: failedModels.map((r) => ({ model: r.model, error: r.error })),
      allResults: results,
    });
  } catch (e: any) {
    return NextResponse.json({
      success: false,
      error: e?.message || "Internal error",
      stack: process.env.NODE_ENV === "development" ? e?.stack : undefined,
    }, { status: 500 });
  }
}

