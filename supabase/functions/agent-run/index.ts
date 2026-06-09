// Scout agent-run — Supabase Edge Function.
// Streams Claude Sonnet 4.6 responses as Server-Sent Events to the desktop app.
// Tool calls are executed locally on the user's machine by main.js; we just
// forward each stream event verbatim so the renderer can render incrementally.
//
// Reliability notes:
//   - Retries transient Anthropic errors (429, 5xx, overloaded) with backoff.
//   - Sends a heartbeat comment every 15s to keep the SSE pipe open through
//     proxies and edge-runtime idle timers.
//   - Emits `error` SSE events instead of silently closing if mid-stream fails.

import Anthropic from "npm:@anthropic-ai/sdk@0.65.0";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const MODEL_PRIMARY  = "claude-sonnet-4-6";
const MODEL_FALLBACK = "claude-sonnet-4-5";
const MAX_TOKENS     = 16384;
const MAX_RETRIES    = 3;

function isRetryable(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  if (status === 429 || status === 408 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529) return true;
  const msg = (e as Error)?.message?.toLowerCase() ?? "";
  return msg.includes("overloaded") || msg.includes("timeout") || msg.includes("econnreset") || msg.includes("fetch failed");
}

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const body = await req.json();
    const { messages, tools, system } = body;
    const model = body.model || MODEL_PRIMARY;

    const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
    if (!apiKey) return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not set on the Supabase project — set it in the dashboard under Project Settings → Edge Functions → Secrets." }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });

    const anthropic = new Anthropic({ apiKey, maxRetries: 0 });

    // Try primary model with retries; on persistent non-retryable failure, fall back.
    let stream: AsyncIterable<unknown> | null = null;
    let lastErr: unknown = null;
    const tryModel = async (m: string) => {
      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        try {
          // deno-lint-ignore no-explicit-any
          const params: any = {
            model: m,
            max_tokens: MAX_TOKENS,
            stream: true,
            messages: messages ?? [],
            ...(system ? { system } : {}),
            ...(tools?.length ? { tools } : {}),
          };
          return await anthropic.messages.stream(params);
        } catch (e) {
          lastErr = e;
          console.error(`[agent-run] ${m} attempt ${attempt + 1} failed:`, (e as Error)?.message);
          if (!isRetryable(e) || attempt === MAX_RETRIES - 1) throw e;
          await sleep(500 * Math.pow(2, attempt));
        }
      }
      throw lastErr;
    };

    try {
      stream = await tryModel(model);
    } catch (e) {
      // Surface the error type so the client can distinguish auth vs model vs rate-limit
      const status = (e as { status?: number })?.status;
      // If it looks like a model-not-found, try the fallback once
      const msg = (e as Error)?.message?.toLowerCase() ?? "";
      const isModelErr = status === 404 || msg.includes("model") || msg.includes("not_found");
      if (isModelErr && model !== MODEL_FALLBACK) {
        console.warn(`[agent-run] primary model "${model}" rejected, trying fallback "${MODEL_FALLBACK}"`);
        try { stream = await tryModel(MODEL_FALLBACK); }
        catch (e2) {
          return new Response(JSON.stringify({ error: `Anthropic rejected both primary (${model}) and fallback (${MODEL_FALLBACK}): ${(e2 as Error).message}` }), { status: 502, headers: { ...CORS, "Content-Type": "application/json" } });
        }
      } else {
        const code = status ?? 502;
        return new Response(JSON.stringify({ error: `Anthropic: ${(e as Error).message}`, status: code }), { status: code, headers: { ...CORS, "Content-Type": "application/json" } });
      }
    }

    const encoder = new TextEncoder();
    const readable = new ReadableStream({
      async start(controller) {
        let closed = false;
        const safeEnqueue = (chunk: Uint8Array) => { if (!closed) { try { controller.enqueue(chunk); } catch { closed = true; } } };

        // Heartbeat: SSE comment line. Browsers and proxies ignore lines that
        // start with ":". Keeps the connection from being killed by edge timeouts.
        const heartbeat = setInterval(() => { safeEnqueue(encoder.encode(": ping\n\n")); }, 15000);

        try {
          for await (const event of stream!) {
            safeEnqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
          }
          safeEnqueue(encoder.encode("data: [DONE]\n\n"));
        } catch (e) {
          const msg = (e as Error)?.message ?? String(e);
          console.error("[agent-run] mid-stream failure:", msg);
          safeEnqueue(encoder.encode(`data: ${JSON.stringify({ type: "error", error: { message: msg } })}\n\n`));
          safeEnqueue(encoder.encode("data: [DONE]\n\n"));
        } finally {
          clearInterval(heartbeat);
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
        }
      },
    });

    return new Response(readable, {
      headers: {
        ...CORS,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  }
});
