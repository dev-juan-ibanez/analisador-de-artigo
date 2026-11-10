# Analisador de Artigo Científico

App Next.js 16 (App Router) que usa o Claude Code local (`claude -p --agent ...`) como motor de análise. Leia `README.md`.
Next.js aqui é a v16: consulte `node_modules/next/dist/docs/` antes de usar APIs novas (ver AGENTS.md).

- Etapas SEM IA: `lib/convert.ts` (pandoc / pdftotext / LibreOffice) e `lib/citations.ts`.
- Etapas COM IA: agentes em `.claude/agents/*.md`; rubricas compactas em `knowledge/compact/` (embutidas na mensagem por `lib/agents.ts`; as de `knowledge/*.md` são a documentação completa).
- Leituras são guardadas por conteúdo em `data/store/leitura/` (por seção); `lib/leitura.ts` confere trechos/¶ e monta tabelas; `lib/vault.ts` gera o vault do Obsidian. Tudo sem IA.
- **Leitura integrada** (`revisor-texto`): cada trecho é lido UMA vez; resultado em `data/jobs/<id>/leitura.json` é reaproveitado por Português/Seções/Plágio/Geral/Relatório. Nunca crie uma etapa que releia o artigo; consuma `leitura.json`.
- Regra de ouro: **token é recurso escasso**. Nunca reenviar o artigo inteiro sem necessidade; toda etapa nova deve ter estimativa (`estimateStep`) e saída com limite.
- Uma etapa por vez, iniciada pelo usuário (botão Próximo). Cancelar/retomar: `lib/pipeline.ts` + cache em `data/jobs/<id>/cache/`.
- Numeração de parágrafos (¶) por seção: `lib/numbering.ts` é a única fonte; agentes e relatório citam seção + ¶.
- Para melhorar um agente: edite a rubrica em `knowledge/` e/ou o agente; não há fine-tuning.
- Teste sem gastar tokens: crie `data/MOCK`. Dados de uso ficam em `data/` (ignorado pelo git).
- Artigos de alunos contêm dados pessoais: nunca versionar (`.gitignore` cobre `/*.docx` etc.).
