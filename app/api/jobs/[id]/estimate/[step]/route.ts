import { isValidId, STEP_IDS, type StepId } from "@/lib/jobs";
import { estimateStep } from "@/lib/pipeline";

/** Estimativa de tokens de uma etapa (sem chamar a IA). */
export async function GET(_req: Request, ctx: RouteContext<"/api/jobs/[id]/estimate/[step]">) {
  const { id, step } = await ctx.params;
  if (!isValidId(id) || !(STEP_IDS as readonly string[]).includes(step)) {
    return Response.json({ error: "inválido" }, { status: 400 });
  }
  const est = await estimateStep(id, step as StepId);
  if (!est) return Response.json({ tokens: null, calls: 0 });
  return Response.json(est);
}
