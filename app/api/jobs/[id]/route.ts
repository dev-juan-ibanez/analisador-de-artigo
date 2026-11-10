import { deleteJob, getJob, hasActiveRun, isValidId } from "@/lib/jobs";

export async function GET(_req: Request, ctx: RouteContext<"/api/jobs/[id]">) {
  const { id } = await ctx.params;
  if (!isValidId(id)) return Response.json({ error: "id inválido" }, { status: 400 });
  const job = await getJob(id);
  if (!job) return Response.json({ error: "não encontrado" }, { status: 404 });
  return Response.json(job);
}

export async function DELETE(_req: Request, ctx: RouteContext<"/api/jobs/[id]">) {
  const { id } = await ctx.params;
  if (!isValidId(id)) return Response.json({ error: "id inválido" }, { status: 400 });
  if (hasActiveRun(id)) {
    return Response.json({ error: "Há uma análise em andamento. Cancele antes de excluir." }, { status: 409 });
  }
  await deleteJob(id);
  return Response.json({ deleted: id });
}
