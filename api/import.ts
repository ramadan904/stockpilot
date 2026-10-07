// Vercel serverless function. Reading a statement screenshot needs ANTHROPIC_API_KEY in the project's environment;
// pasted holdings are parsed without it.
import { handleImport } from "../agent/api";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const { status, json } = await handleImport(body);
  return Response.json(json, { status });
}
