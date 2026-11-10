import { getJob, isValidId } from "@/lib/jobs";
import { syncVault, vaultDir } from "@/lib/vault";

/** Garante o vault do Obsidian do artigo e devolve o caminho e o link para abri-lo. */
export async function GET(_req: Request, ctx: RouteContext<"/api/jobs/[id]/vault">) {
  const { id } = await ctx.params;
  if (!isValidId(id) || !(await getJob(id))) return Response.json({ error: "não encontrado" }, { status: 404 });
  await syncVault(id);
  const path = vaultDir(id);
  return Response.json({ path, uri: `obsidian://open?path=${encodeURIComponent(path)}` });
}
