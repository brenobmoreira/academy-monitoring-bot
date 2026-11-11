# Pulso interativo — entrega local

Implementado e validado localmente na branch `claude/pulso-interativo`. Os cinco itens foram atendidos, preservando o JSON enviado, o catálogo e a API anterior do avatar. Nenhuma dependência adicionada; nenhum push, merge ou troca de branch. Todos os arquivos alterados ficam em `apps/miniapp/`; `.playwright-mcp/` foi preservada.

- **Expressão:** boca e sobrancelhas diferentes nos cinco humores, além dos olhos fechados no cochilo. Arte e estilos continuam somente em `src/avatar.js`, com o contrato/API documentados. Braços ficaram de fora para manter a leitura a 32 px.
- **Toque:** botão nativo com nome acessível, Enter/Espaço e dicas cíclicas sobre histórico, séries restantes, próximo exercício e refeição. O balão conserva `role="status"`/`aria-live="polite"`. Texto variável usa `textContent`; toque preserva o campo em edição.
- **Olhar:** olhos acompanham o campo focado e sua posição após rolagem/redimensionamento; voltam ao centro ao sair. Erros apontam para o campo correspondente sem mover o foco.
- **Reações:** ganho de carga/reps com diferença em português; reação `full` ao preencher todo o plano; cochilo após 45 s e despertar por toque/teclado/input. Cada ação escolhe uma única fala. Incluído teste para o blur atrasado que antes apagava o olhar de erro.
- **Presença:** Pulso grande e resumo factual na revisão e na cena de solicitação de envio. A cena diz **“Envio solicitado”**: a gravação só pode ser confirmada pela resposta do bot.

Validação: `node --test apps/miniapp/test/` — **100 testes, 100 aprovados, 0 falhas**. `npm.cmd run check` e `git diff --check` passaram. Os testes incluem decisões puras e integração pelo harness: dicas, ganho, conclusão, repetição do histórico, erros, foco, sono e cenas. Payload/idempotência continuam cobertos pelos testes existentes.

Inspeção no Edge/Chromium, largura de 390 px: cinco humores e cochilo a 32/40/112 px nos temas claro/escuro; introdução, formulário, erro, revisão e envio com SDK simulado. Conferidos por automação toque real em emulação móvel, Enter/Espaço, foco preservado, balão sem deslocamento, olhos, sono/despertar com relógio controlado e redução de movimento. Não foram verificados Telegram real, WebViews em aparelhos físicos, confirmação do bot ou leitura com leitor de tela real. As ferramentas de prévia falharam ao capturar; a inspeção usou Playwright já instalado, sem instalar pacotes ou navegadores.

Capturas PNG, fora dos commits: [`shots/`](shots/). Galeria reproduzível: [`pulso-demo.html`](pulso-demo.html). Checagem opcional: [`check-pulso.cjs`](check-pulso.cjs), usando um módulo Playwright já existente e servidor local, conforme o cabeçalho do arquivo.

Decisões reversíveis: comparação com a série de mesmo número, sem inventar referência para séries extras; reconhecimento conservador de prescrições `N×reps`; contagem pelo catálogo atual mesmo quando o rascunho antigo omite exercícios; balão com três linhas fixas e rolagem para falas longas; maior ganho de carga tem preferência sobre ganho de reps no resumo.

Commits de implementação:

- `1f9c478` — decisões puras, dicas e reações.
- `49d2e2e` — expressões, olhar/cochilo e botão acessível.
- `4d5c770` — integração, resumos e testes de regressão.

A galeria, o script de inspeção e este relatório acompanham um commit separado de validação.
