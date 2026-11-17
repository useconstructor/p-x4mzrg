import { NextRequest } from "next/server";
import { handle } from "@/lib/server/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ raiz: string[] }> };
export async function GET(request: NextRequest, context: Context) {
  return handle(request, (await context.params).raiz);
}
export async function POST(request: NextRequest, context: Context) {
  return handle(request, (await context.params).raiz);
}
