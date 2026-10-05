// Vercel serverless function: submits an owner's signed check-in or pause, so the owner needs no gas.
import { handleRelay } from "../agent/api";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const { status, json } = await handleRelay(body);
  return Response.json(json, { status });
}
