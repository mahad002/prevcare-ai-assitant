import { NextResponse } from "next/server";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const splSetId = searchParams.get("spl_set_id");

    if (!splSetId) {
      return NextResponse.json({ error: "Missing spl_set_id parameter" }, { status: 400 });
    }

    const dailyMedUrl = `https://dailymed.nlm.nih.gov/dailymed/services/v2/spls/${splSetId}/packaging.json`;
    
    console.log("Proxying DailyMed request to:", dailyMedUrl);
    
    const res = await fetch(dailyMedUrl, {
      method: "GET",
      headers: {
        "Accept": "application/json",
      },
    });

    if (!res.ok) {
      const errorText = await res.text();
      console.error("DailyMed API error:", res.status, errorText);
      return NextResponse.json(
        { error: `DailyMed API error: ${res.status}`, details: errorText },
        { status: res.status }
      );
    }

    const data = await res.json();
    return NextResponse.json(data, { status: 200 });
  } catch (e: any) {
    console.error("Error proxying DailyMed request:", e);
    return NextResponse.json(
      { error: e?.message || "Internal server error" },
      { status: 500 }
    );
  }
}

