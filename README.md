# Analisador de Artigo Científico

Ferramenta **local** de apoio à revisão de artigos científicos em português (com Resumo, Abstract e Resumen).
Você envia o arquivo, avança **uma etapa por vez** e, no fim, recebe um relatório com a visão geral do artigo e as
**correções seção a seção, parágrafo a parágrafo** — ou a declaração de que o artigo está bom.

> ## ⚠️ Atua em conjunto com o professor, não no lugar dele
> Este sistema é um **assistente de triagem e de apoio**. Ele **não substitui** a leitura, o julgamento e a correção do
> professor/orientador, e **não deve ser usado como decisão final** sobre nota, aprovação ou conduta do aluno.
> - A IA **pode errar**: apontar problema que não existe, deixar passar um que existe, ou sugerir correção inadequada.
> - **Plágio**: o sistema só **indica trechos para você pesquisar**. Ele não consulta bases de comparação e **nunca** afirma que houve plágio.
> - **Indícios de IA** são probabilísticos (detectores erram, principalmente com escrita de não nativos). Não são prova de autoria.
> - **Referências**: a existência de cada obra é **verificada manualmente por você** (o sistema lista, cruza e gera os links).
> - Cabe ao professor conferir cada achado, aceitar ou descartar, e decidir.

## Como funciona

1. **Envie** o artigo (arraste para a página): `.docx`, `.doc`, `.odt`, `.rtf` ou `.pdf`.
2. O sistema **converte para Markdown e extrai citações/referências (sem IA)**. Você confere as referências manualmente.
3. Clique em **Próximo** para iniciar cada etapa de análise. **Nada roda sozinho**; só uma etapa por vez, e só avança quando você clica.
4. Cada etapa mostra a **porcentagem real** de andamento (acompanha o texto que a IA vai escrevendo), as palavras geradas, os **tokens usados** e pode ser **cancelada**. O que já foi analisado fica guardado: dá para **retomar de onde parou**. Atualizar a página (F5) **não reinicia** nada.
5. O **relatório final** traz o veredito, os pontos fortes, os problemas gerais e as correções por seção e parágrafo (`¶n`).
   Use o botão **Texto numerado** para achar cada parágrafo no seu documento e marcar em vermelho.

### Etapas e agentes

| # | Etapa | Quem faz | O que faz |
|---|-------|----------|-----------|
| — | Conversão para Markdown | Código (**sem IA**): pandoc, pdftotext, LibreOffice | Extrai o texto, promove títulos em negrito a títulos, numera os parágrafos (¶) por seção. |
| 1 | Citações e referências | Código (**sem IA**) — `lib/citations.ts` | Lista citações e referências, cruza texto × lista (autor-data e numérico; ABNT, APA, Vancouver), aponta *ausentes* e *nunca citadas* e gera links (DOI, Scholar, Crossref, OpenAlex) para a **checagem manual**. |
| 2 | Resumos (PT · EN · ES) | Agente `revisor-resumos` | Corrige o Resumo, o Abstract e o Resumen no idioma de cada um, avalia a estrutura, as palavras-chave e a consistência entre as três versões. |
| 3 | Português | Agente `revisor-texto` (**leitura integrada**) | Lê cada trecho **uma única vez** e devolve, de uma vez: erros de português, análise por seção, suspeitas de plágio, síntese e sinais de IA. Esta etapa mostra os achados de português. |
| 4 | Estrutura | Agente `analista-estrutura` | Avalia a divisão em seções (ausentes, ordem, proporção, títulos) só pelo esqueleto e pelo início de cada seção. |
| 5 | Seção a seção | Resultado da leitura integrada (**custo extra zero**) | Mostra a análise de cada seção: função, lógica, afirmações sem suporte, método, coerência. |
| 6 | Trechos suspeitos | Resultado da leitura integrada (**custo extra zero**) + links por código | Lista trechos com sinais de cópia/paráfrase para **você pesquisar**, com frase de busca e links (Google, Scholar, Livros). |
| 7 | Geral e indícios de IA | Agente `revisor-geral` | Avalia o artigo (contribuição, cadeia objetivo→conclusão, rigor) e os indícios de IA a partir das **sínteses e sinais já colhidos** — não relê o texto. |
| 8 | Relatório final | Agente `redator-relatorio` + **código** | O agente escreve a parte narrativa (veredito, pontos fortes, problemas gerais, plano). As **tabelas de correções por seção e parágrafo** vêm direto dos dados guardados, montadas pelo código (sem custo e sem endereços inventados). |

Os agentes ficam em [`.claude/agents/`](.claude/agents) e rodam pelo **Claude Code** instalado na sua máquina.

### Base científica

Em [`knowledge/`](knowledge) estão as rubricas que cada agente segue (IMRaD e guias EQUATOR — CONSORT, PRISMA, STROBE etc.;
português acadêmico; padrões de texto gerado por IA; verificação de citações; resumo trilíngue). Para **ajustar** como os agentes avaliam,
edite esses arquivos e os agentes. Não há *fine-tuning*; o ajuste é por rubrica e instruções.

## O que você precisa

| Requisito | Para quê | Instalação (macOS) |
|-----------|----------|--------------------|
| **Node.js 20+** (testado com 24) e npm | Rodar o app (Next.js 16) | `brew install node` |
| **pandoc** | Converter `.docx`/`.odt`/`.rtf` | `brew install pandoc` |
| **poppler** (`pdftotext`) | Converter `.pdf` com texto | `brew install poppler` |
| **LibreOffice** *(opcional)* | Converter `.doc` antigo (ou salve como `.docx`) | `brew install --cask libreoffice` |
| **Claude Code** (CLI `claude`) **logado** | Executar os agentes de IA | veja a [documentação do Claude Code](https://docs.claude.com/claude-code) e rode `claude` uma vez para entrar |

> PDFs escaneados (sem texto selecionável) precisam de OCR antes; o sistema avisa quando não consegue extrair texto.
> Em Linux/Windows os pacotes equivalentes servem (apt/choco); o projeto foi testado no macOS.

## Instalação

```bash
git clone <url-do-repositorio>
cd analisador-de-artigo
npm install
npm run dev
```

Abra <http://localhost:3000>. Nenhuma chave de API é guardada no projeto: o acesso à IA é o do seu Claude Code.

## Uso

1. Na página **Novo**, arraste o artigo (ou clique para escolher).
2. Em **Citações e referências**, confira manualmente cada obra (✔ existe / ✖ suspeita; as marcações ficam salvas no navegador).
3. Clique em **Próximo → Iniciar: …** para rodar cada etapa. Acompanhe a porcentagem; use **Cancelar** se necessário.
4. Se cancelar ou der erro (por exemplo, limite de uso do Claude), clique em **Retomar de onde parou**. **Refazer do zero** descarta o cache da etapa.
5. No **Relatório**, use *Copiar*, *.md* ou *Imprimir / PDF*. Em **Texto numerado**, localize o ¶ citado.
6. **Histórico** lista os artigos enviados (abrir e excluir).

## Economia de tokens

O custo é **mostrado antes de rodar**: cada botão de iniciar traz a estimativa (`≈ N mil tokens`), já descontando o que está guardado, e durante a etapa aparece o uso real (sem leituras de cache).

- **Modo enxuto**: cada chamada de IA roda sem plugins, skills, servidores MCP nem ferramentas do seu Claude Code (~860 tokens de base, em vez de ~10 mil). Se não funcionar no seu ambiente, volta sozinho ao modo padrão (`CLAUDE_LEAN=0` força o padrão).
- **Cada trecho do artigo é lido uma única vez** (leitura integrada, guardada em `leitura.json`): Português, Seções e Plágio saem da mesma chamada; Seções e Plágio custam zero. Estrutura recebe só esqueleto + início das seções; Geral trabalha sobre as sínteses; o Relatório monta as tabelas por código e o agente escreve só a narrativa.
- **Rubricas compactas** (`knowledge/compact/`) embutidas na mensagem, e saídas dos agentes com limite de achados.
- **Agrupamento**: seções pequenas viram uma só chamada (~14 mil caracteres).
- **Cache por trecho**: retomar não paga de novo o que já foi analisado (invalidado se você editar um agente ou rubrica).
- **Modo simulação** (sem gastar nada, para testar a interface): crie o arquivo `data/MOCK` (opcional: nele, o atraso em ms por chamada).
- Variáveis: `CLAUDE_MODEL` (ex.: `sonnet`, `opus`, `haiku`), `CLAUDE_MODEL_<AGENTE>` para escolher um modelo por agente (ex.: `CLAUDE_MODEL_REVISOR_PORTUGUES=haiku`, que pesa menos na sua cota — avalie a qualidade antes de adotar), `CLAUDE_MAX_PARALLEL` (padrão 3), `CLAUDE_LEAN=0`.

## Privacidade

Arquivos, textos convertidos e resultados ficam **na sua máquina**, em `data/jobs/` (ignorado pelo git). Sem banco de dados.
**Atenção:** nas etapas de IA, o texto do artigo é enviado ao serviço do Claude (Anthropic) pelo Claude Code. Trabalhos de alunos contêm
dados pessoais; confirme se isso é compatível com a política da sua instituição e com a LGPD antes de usar.

## Estrutura do projeto

```
app/                 interface (Next.js App Router) e rotas /api/jobs
lib/convert.ts       conversão para Markdown (sem IA)
lib/citations.ts     extração e cruzamento de citações (sem IA)
lib/numbering.ts     numeração de parágrafos (¶) por seção
lib/pipeline.ts      etapas, progresso, cancelamento e cache
lib/agents.ts        execução dos agentes pelo Claude Code
.claude/agents/      definição de cada agente
knowledge/           rubricas científicas completas (documentação)
knowledge/compact/   versões compactas usadas nas chamadas de IA
data/                resultados locais (não versionado)
```

## Limitações conhecidas

- Citações autor-data são detectadas por padrões; autores institucionais e formatos incomuns podem gerar falsos "ausentes".
- Conversão de PDF pode perder tabelas e colunas; prefira `.docx`.
- Abstract/Resumen só são revisados na etapa **Resumos** (não nas demais).
- O relatório depende da qualidade das etapas anteriores: confira-as antes de confiar na conclusão.

## Licença

[MIT](LICENSE) © 2026 dev.juan.ibanez
