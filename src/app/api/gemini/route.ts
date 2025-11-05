import { NextResponse } from "next/server";

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY;

export async function POST(req: Request) {
  try {
    if (!GEMINI_KEY) {
      return NextResponse.json({ error: "Gemini API key is not configured" }, { status: 500 });
    }

    const body = await req.json().catch(() => ({}));
    const prompt: string = body?.prompt ?? "";
    const models: string[] = Array.isArray(body?.models) && body.models.length
      ? body.models
      : ["gemini-2.5-pro"];

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
            // try next model
            continue;
          }
          const msg = data?.error?.message || raw || res.statusText;
          return NextResponse.json({ error: `Gemini(${model}) error ${res.status}: ${msg}` }, { status: res.status });
        }

        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
        try {
          const parsed = JSON.parse(text);
          return NextResponse.json(parsed, { status: 200 });
        } catch {
          return NextResponse.json(extractJson(text), { status: 200 });
        }
      } catch (err) {
        // try next model
        continue;
      }
    }

    return NextResponse.json({ error: "All Gemini models failed" }, { status: 502 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Internal error" }, { status: 500 });
  }
}


