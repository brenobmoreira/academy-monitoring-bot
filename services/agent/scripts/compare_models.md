# compare_models: medir o Gemini nas duas tarefas do bot

Ferramenta de desenvolvimento, rodada uma vez, à mão, com a sua chave. Não faz parte do bot e os testes
nunca chamam a API.

Ela mede o modelo atual do bot (`gemini/gemini-3.8-flash`) com os níveis de thinking `low` e `medium`:

- **Transcrição (principal).** O `Transcriber` real do bot em cada áudio seu, 2 vezes por nível. Mede
  latência, tokens, corte por `max_tokens` e estabilidade da saída.
- **Chat.** O agente real do bot (`Bot` + `build_model`, o mesmo caminho do `LLM_MODEL`) em 5 mensagens
  sintéticas, contra uma planilha **falsa em memória**. A planilha real nunca é tocada.

E confere três números da C4b: `TRANSCRIBE_PROMPT_TOKENS = 454`, se `temperature=0` é enviado e dá texto
estável, e se `max_tokens = 600` basta (no Gemini 3.8 Flash o thinking não desliga e conta dentro do
`max_tokens`; o mínimo é `low`).

## Passo a passo

Tudo a partir de `services/agent`.

1. **Áudios.** Junte de 5 a 10 áudios seus (webm, ogg, m4a ou mp3, até 90 s) numa pasta **fora do
   repositório**. Os áudios nunca entram no repo.
2. **Estimativa, sem chave:**
   ```powershell
   uv run python scripts/compare_models.py C:\caminho\audios --dry-run
   ```
3. **Chave só nesta janela do terminal** (não vai para o histórico, nem para arquivo):
   ```powershell
   $k = Read-Host "GEMINI_API_KEY" -AsSecureString
   $env:GEMINI_API_KEY = [System.Net.NetworkCredential]::new("", $k).Password
   ```
4. **Rodar**, com a saída numa pasta fora do repositório (o script recusa uma pasta dentro de um repo git):
   ```powershell
   uv run python scripts/compare_models.py C:\caminho\audios --out C:\caminho\resultado
   Remove-Item Env:GEMINI_API_KEY
   ```

## O que sai

- **Terminal:** uma linha de métricas por execução e duas tabelas-resumo. Os áudios aparecem como `a01`,
  `a02`... e nada de conteúdo é impresso.
- **`results.md`:** resumo por modelo e nível (acertos do chat, latência média, tokens médios, custo por
  mensagem e por áudio, cortes por `max_tokens`), os três números da C4b e o detalhe de cada execução.
- **`transcripts.txt`:** as transcrições, com a chave `a01 = nome-do-arquivo` no topo. É o único arquivo
  com conteúdo. Fica só na sua pasta; não envie nem faça commit.

## Como o thinking é passado

Pelo parâmetro do LiteLLM `reasoning_effort` (`low`, `medium`, `high`). Para modelos `gemini-3*` ele vira
`thinkingConfig.thinkingLevel` (e `includeThoughts: true`). O `results.md` mostra a configuração exata que o
LiteLLM monta. O bot hoje não envia `reasoning_effort`: o modelo roda no nível padrão dele (`medium` no
3.8 Flash). Para medir exatamente isso, sem o parâmetro, use `--levels default`.

## Opções

| Opção | Efeito |
|---|---|
| `--levels low medium` | níveis de thinking (padrão `low medium`; também `high` e `default`) |
| `--runs 2` | vezes que cada áudio é transcrito, por nível |
| `--models gemini/gemini-3.8-flash` | modelos (padrão: o do bot). Outro modelo só tem custo estimado depois de entrar na tabela `PRICES` do script |
| `--skip-chat`, `--skip-transcribe` | roda só uma das partes |
| `--dry-run` | só o plano e a estimativa de custo; não pede a chave |

## Custo

O custo é estimado com o preço oficial do Gemini 3.8 Flash (fonte e data no próprio script e no
`results.md`): US$ 0,75 por milhão de tokens de entrada e US$ 3,75 de saída (com thinking) até
31/12/2026; US$ 1,50 e US$ 7,50 a partir de 01/01/2027. O `results.md` mostra os dois. É estimativa, não
fatura.

## Limites

- Duração dos áudios não é verificada (o script só ignora arquivos acima de 5 MB).
- Latência depende da sua rede e do horário; uma rodada é uma amostra.
- Estabilidade igual em 2 repetições sustenta que `temperature=0` é respeitado; diferença não prova o contrário.
- O chat usa uma planilha falsa e um catálogo pequeno: mede o modelo, não a planilha.
