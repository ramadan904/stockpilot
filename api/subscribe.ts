// Vercel serverless function: verify an owner-signed alert subscription and forward it to the pilot operator.
import { handleSubscribe } from "../agent/api";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const { status, json } = await handleSubscribe(body);
  return Response.json(json, { status });
}
