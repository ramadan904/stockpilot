// Vercel serverless function: a free trial purchase in a StockPilot fund (testnets), or a holder's signed redemption,
// paid by the operator's relay so the holder needs no gas.
import { handleFund } from "../agent/api";

export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const { status, json } = await handleFund(body);
  return Response.json(json, { status });
}
