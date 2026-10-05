// Vercel serverless function. Set ANTHROPIC_API_KEY in the project's environment to let Claude draft mandates;
// without it the endpoint answers with the offline preset.
import { handlePropose } from "../agent/api";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const { status, json } = await handlePropose(body);
  return Response.json(json, { status });
}
