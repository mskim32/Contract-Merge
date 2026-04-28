import { NextResponse } from "next/server";
import mammoth from "mammoth";

export async function POST(req: Request) {
  try {
    const { base64 } = await req.json();

    if (!base64) {
      return NextResponse.json({ error: "No base64 data provided" }, { status: 400 });
    }

    const buffer = Buffer.from(base64, "base64");
    const result = await mammoth.extractRawText({ buffer });
    const textLength = result.value.length;

    return NextResponse.json({ success: true, textLength });
  } catch (error: any) {
    console.error("[SCAN API] Error scanning document:", error);
    return NextResponse.json({ error: "Backend error: " + (error?.message || String(error)) }, { status: 500 });
  }
}
