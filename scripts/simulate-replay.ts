import { createHmac, randomUUID } from "node:crypto";

const ENDPOINT = process.env.WEBHOOK_URL || "http://localhost:3000/api/webhooks";
const RAW_SECRET = process.env.WEBHOOK_SECRET || "local_dev_secret_key_12345";
const SECRET = RAW_SECRET.trim().replace(/^["']|["']$/g, "");

interface StageResult {
  stage: string;
  requestId: string | number;
  statusCode: number;
  statusText: string;
  details: string;
}

function generateSignature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

async function runAttackSuite(): Promise<void> {
  const summary: StageResult[] = [];
  let isSuiteSuccessful = true;

  const eventId = `evt_${randomUUID()}`;
  const validPayload = JSON.stringify({
    id: eventId,
    type: "payment_intent.succeeded",
    amount: 50000,
    timestamp: Date.now(),
  });
  const validSignature = generateSignature(validPayload, SECRET);

  console.log("================================================================");
  console.log(" nextjs-webhook-engine-lite : Multi-Stage Verification Suite   ");
  console.log("================================================================");
  console.log(`Target Endpoint : ${ENDPOINT}`);
  console.log(`Target Event ID : ${eventId}\n`);

  // ---------------------------------------------------------------------------
  // Stage 1: Concurrency Clash (5 Parallel Dispatches)
  // ---------------------------------------------------------------------------
  console.log("[Stage 1] Dispatching 5 concurrent requests (Lock Contention)...");

  const concurrentRequests = Array.from({ length: 5 }, (_, i) =>
    fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-signature-256": validSignature,
      },
      body: validPayload,
    }).then(async (res): Promise<StageResult> => {
      const text = await res.text();
      return {
        stage: "1. Concurrency Clash",
        requestId: i + 1,
        statusCode: res.status,
        statusText: res.statusText,
        details: text,
      };
    })
  );

  const stage1Results = await Promise.all(concurrentRequests);
  summary.push(...stage1Results);

  const count200 = stage1Results.filter((r) => r.statusCode === 200).length;
  const count202 = stage1Results.filter((r) => r.statusCode === 202).length;

  if (count200 === 1 && count202 === 4) {
    console.log(`  ✓ Passed: Exactly 1x 200 OK and 4x 202 Accepted.\n`);
  } else {
    console.error(
      `  ✗ Failed: Expected 1x 200 and 4x 202. Received: ${count200}x 200, ${count202}x 202.\n`
    );
    isSuiteSuccessful = false;
  }

  // ---------------------------------------------------------------------------
  // Stage 2: Retention Replay (Duplicate Delivery of Completed Event)
  // ---------------------------------------------------------------------------
  console.log("[Stage 2] Dispatching replay of completed event...");

  const replayRes = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-signature-256": validSignature,
    },
    body: validPayload,
  });

  const replayText = await replayRes.text();
  summary.push({
    stage: "2. Retention Replay",
    requestId: "Replay-1",
    statusCode: replayRes.status,
    statusText: replayRes.statusText,
    details: replayText,
  });

  let replayBody: Record<string, unknown> = {};
  try {
    replayBody = JSON.parse(replayText);
  } catch {
    // Handled by validation assertion below
  }

  if (replayRes.status === 200 && replayBody.status === "already_processed") {
    console.log(`  ✓ Passed: Event recognized as completed (status: 'already_processed').\n`);
  } else {
    console.error(
      `  ✗ Failed: Expected 200 OK with status 'already_processed'. Received: ${replayRes.status}: ${replayText}\n`
    );
    isSuiteSuccessful = false;
  }

  // ---------------------------------------------------------------------------
  // Stage 3: Tampered Signature (Cryptographic Barrier Check)
  // ---------------------------------------------------------------------------
  console.log("[Stage 3] Dispatching forged signature header...");

  const forgedSignature = "0".repeat(64);
  const forgedRes = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-signature-256": forgedSignature,
    },
    body: validPayload,
  });

  const forgedText = await forgedRes.text();
  summary.push({
    stage: "3. Forged Signature",
    requestId: "Tamper-Sig",
    statusCode: forgedRes.status,
    statusText: forgedRes.statusText,
    details: forgedText,
  });

  if (forgedRes.status === 401) {
    console.log(`  ✓ Passed: Forged signature rejected with 401 Unauthorized.\n`);
  } else {
    console.error(`  ✗ Failed: Expected 401 Unauthorized. Received: ${forgedRes.status}.\n`);
    isSuiteSuccessful = false;
  }

  // ---------------------------------------------------------------------------
  // Stage 4: Payload Mutation (Digest Invalidation Check)
  // ---------------------------------------------------------------------------
  console.log("[Stage 4] Dispatching tampered payload with original signature...");

  const mutatedPayload = JSON.stringify({
    id: eventId,
    type: "payment_intent.succeeded",
    amount: 999999999, // Altered payload
    timestamp: Date.now(),
  });

  const mutatedRes = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-signature-256": validSignature,
    },
    body: mutatedPayload,
  });

  const mutatedText = await mutatedRes.text();
  summary.push({
    stage: "4. Mutated Payload",
    requestId: "Tamper-Body",
    statusCode: mutatedRes.status,
    statusText: mutatedRes.statusText,
    details: mutatedText,
  });

  if (mutatedRes.status === 401) {
    console.log(`  ✓ Passed: Mutated body rejected with 401 Unauthorized.\n`);
  } else {
    console.error(`  ✗ Failed: Expected 401 Unauthorized. Received: ${mutatedRes.status}.\n`);
    isSuiteSuccessful = false;
  }

  // ---------------------------------------------------------------------------
  // Matrix Evaluation & Safe Exit Handling
  // ---------------------------------------------------------------------------
  console.log("========================= Execution Summary =========================");
  console.table(summary);

  if (!isSuiteSuccessful) {
    console.error("\nRESULT: FAILED — Security or concurrency assertions violated.");
    // Avoids process.exit(1) libuv socket tearing on Windows
    process.exitCode = 1;
    return;
  }

  console.log("\nRESULT: ALL PASS — Edge security and distributed locking verified.");
}

runAttackSuite().catch((error) => {
  console.error("Fatal suite runner crash:", error);
  process.exitCode = 1;
});