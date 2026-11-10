import fs from "node:fs/promises";
import { isValidId, jobFile, PUBLIC_FILES } from "@/lib/jobs";

export async function GET(_req: Request, ctx: RouteContext<"/api/jobs/[id]/files/[name]">) {
  const { id, name } = await ctx.params;
  if (!isValidId(id) || !(PUBLIC_FILES as readonly string[]).includes(name)) {
    return Response.json({ error: "arquivo inválido" }, { status: 400 });
  }
  try {
    const content = await fs.readFile(jobFile(id, name), "utf8");
    return new Response(content, {
      headers: {
        "content-type": name.endsWith(".json")
          ? "application/json; charset=utf-8"
          : "text/markdown; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch {
    return Response.json({ error: "ainda não gerado" }, { status: 404 });
  }
}
