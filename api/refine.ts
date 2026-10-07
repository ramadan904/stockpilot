// Vercel serverless function: revise a drafted mandate from a plain-English instruction.
import { handleRefine } from "../agent/api";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const { status, json } = await handleRefine(body);
  return Response.json(json, { status });
}
