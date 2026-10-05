// Vercel serverless function: Claude writes the owner's report from facts the browser computed.
import { handleReport } from "../agent/api";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const { status, json } = await handleReport(body);
  return Response.json(json, { status });
}
