// Vercel serverless function: answers an owner's question from facts the browser read from the chain.
import { handleAsk } from "../agent/api";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const { status, json } = await handleAsk(body);
  return Response.json(json, { status });
}
