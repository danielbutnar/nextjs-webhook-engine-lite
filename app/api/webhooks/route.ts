import { NextRequest, NextResponse } from "next/server";
import { verifyHmacSignature } from "@/lib/hmac";
import {
  acquireWebhookLock,
  markWebhookCompleted,
  releaseWebhookLock,
} from "@/lib/idempotency";

export const runtime = "nodejs";

interface BaseWebhookPayload {
  id: string;
  type?: string;
  [key: string]: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const rawSecret = process.env.WEBHOOK_SECRET;
  const secret = rawSecret ? rawSecret.trim().replace(/^["']|["']$/g, "") : "";

  if (!secret) {
    console.error("[Webhook Error] WEBHOOK_SECRET environment variable is missing.");
    return NextResponse.json(
      { error: "Server configuration error" },
      { status: 500 }
    );
  }

  // 1. Read payload strictly once as raw text to preserve byte ordering
  const rawBody = await req.text();
  const signature = req.headers.get("x-signature-256");

  // 2. Cryptographic Security Barrier: Verify HMAC prior to parsing
  const isSignatureValid = verifyHmacSignature({
    payload: rawBody,
    signature,
    secret,
  });

  if (!isSignatureValid) {
    return NextResponse.json(
      { error: "Invalid cryptographic signature" },
      { status: 401 }
    );
  }

  // 3. Structured Payload Parsing
  let payload: BaseWebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: "Malformed JSON payload" },
      { status: 400 }
    );
  }

  const eventId = payload?.id;
  if (!eventId || typeof eventId !== "string" || eventId.trim() === "") {
    return NextResponse.json(
      { error: "Missing or invalid event identifier ('id')" },
      { status: 400 }
    );
  }

  // 4. Distributed Idempotency State Machine
  try {
    const lockStatus = await acquireWebhookLock(eventId, 60);

    if (lockStatus === "ALREADY_COMPLETED") {
      return NextResponse.json(
        { status: "already_processed" },
        { status: 200 }
      );
    }

    if (lockStatus === "IN_FLIGHT") {
      return NextResponse.json(
        { status: "concurrent_request_ignored" },
        { status: 202 }
      );
    }

    // 5. Critical Execution Boundary (Simulated Workload / Database Mutation)
    await new Promise((resolve) => setTimeout(resolve, 150));

    // 6. Pipeline Settlement: Commit done state and evict ephemeral lock
    await markWebhookCompleted(eventId);

    return NextResponse.json(
      { status: "success", eventId },
      { status: 200 }
    );
  } catch (error) {
    // Evict the ephemeral lock on unhandled failure so upstream retries are not starved
    try {
      await releaseWebhookLock(eventId);
    } catch {
      // Suppress secondary cleanup exceptions to surface the primary trace
    }

    console.error(`[Webhook Handler Error] Execution failed for event ${eventId}:`, error);
    return NextResponse.json(
      {
        error: "Internal processing error",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
}