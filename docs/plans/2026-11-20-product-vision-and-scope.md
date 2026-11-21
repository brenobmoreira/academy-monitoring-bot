# Visão de Produto e Escopo Consolidado — Shaping (Shape)

Status: **Visão e escopo de longo prazo** (documento vivo; nada aqui é compromisso de implementação imediata).
Data: 2026-11-20
Referências analisadas: **FitFolio** (`fitfolio.com.br`, App Store v1.8.12) e **Pumpy** (`pumpyapp.si`, assistente conversacional da FitFolio), integrados à base existente do repositório.

---

## 1. Tese de produto e diferencial competitivo

O mercado fitness está convergindo para dois polos:
- **Apps all-in-one tradicionais (ex.: FitFolio):** fortes em organização visual, histórico de cargas, dieta flexível, comunidade, rankings e ecossistema para profissionais.
- **Companheiros conversacionais de IA (ex.: Pumpy):** *"Sua rotina. Uma conversa."* — baixa fricção via chat, foto do prato, cards ricos, mascote vivo e notificações proativas humanas.

**Nossa aposta é unir o melhor dos dois mundos sem sacrificar integridade de dados:**
1. **Híbrido real (Chat + Interface estruturada):** o usuário escolhe o canal de menor atrito no momento — áudio, foto ou texto livre no chat **ou** tela estruturada rápida no app/Mini App — mas **tudo passa pelo mesmo motor determinístico de validação** (zero linha torta no histórico longitudinal).
2. **Companheiro vivo com identidade própria (Shaping):** o orbe *Lentes Ember* (com anel de progresso, estados emocionais e física fluida) como fio condutor entre treino, dieta, descanso, hidratação e constância.
3. **Resultado e dados na mão do usuário:** histórico auditável, análise semanal objetiva (peso, cintura, adesão, volume e progressão) e interoperabilidade aberta com IAs e wearables.

---

## 2. Base já construída hoje

- **Agente conversacional no Telegram** ([`services/agent`](../../services/agent)): texto, áudio e foto com confirmação e desfazer; comandos determinísticos (`/hoje`, `/ficha`, `/exercicios`, `/semana`, `/fase`, `/desfazer`, `/app`); lembretes agendados (`reminder.py`).
- **Motor longitudinal transacional** ([`apps/sheet4`](../../apps/sheet4)): Google Sheets 4.0 com rollback comprovado, catálogo validado, fases/metas versionadas e análise semanal.
- **Telegram Mini App zero-build** ([`apps/miniapp`](../../apps/miniapp)): treino com prescrição + última carga + "repetir última" + mapa muscular de 7 dias (`body.js`), refeição com tabela TACO (575 alimentos) + soma ao vivo verificada por hash (`fh`), entrada por voz com áudio reativo (`voice.js`) e mascote **Shaping** (`avatar.js` + `muscle-motion.js`).

---

## 3. Escopo completo por ondas de evolução

Tudo abaixo faz parte da visão oficial do produto, organizado por camadas de maturidade técnica e de negócio (sem descartar nenhuma frente).

### Onda 1 — Core de alta retenção no Telegram + Mini App (sobre a base atual)

- **Cronômetro de descanso no anel do Shaping:** ao concluir uma série no card de treino, chip rápido de descanso (`60s · 90s · 120s`, pré-sugerido pela prescrição) rodando diretamente no anel de 12 ticks do Shaping (contexto `descanso`) com `HapticFeedback` ao zerar.
- **Saldo diário "Hoje vs. Meta" + hidratação rápida na aba Refeição:** barra viva de calorias (`consumido / meta`), `P / C / G` e **água (`L / meta`)** atualizando em tempo real enquanto o usuário monta a refeição, com botões rápidos `+250 ml` / `+500 ml`.
- **Troca inteligente de alimento (*Swap & Adjust*):** trocar qualquer item da refeição (ex.: arroz → batata inglesa) com recálculo automático da gramatura equivalente sobre a tabela TACO + alimentos próprios para manter calorias ou o macro principal.
- **Foto de prato & Voz → Rascunho revisável antes de salvar:** IA estima alimentos/porções a partir da foto ou áudio e devolve resumo com botões **`✅ Registrar no diário`** e **`✏️ Ajustar no Mini App`** (abrindo o rascunho pré-preenchido para ajuste fino de gramas antes de gravar).
- **Lembretes proativos com contexto e personalidade:** evoluir `reminder.py` para mensagens curtas e contextuais usando dados reais da semana (próxima sessão da rotação, última carga de referência, água restante no dia, cobrança leve e bem-humorada de consistência).
- **Coreografia expressiva do Shaping:** evoluir `muscle-motion.js` com princípio de antecipação do olhar antes do movimento do corpo e sequências curtas de celebração (`notice`, `focus`, `acknowledge`, `proud`, `milestone`) para PRs, treino concluído e streaks.

### Onda 2 — Evolução visual, planejamento e rotina conectada

- **Painel "Evolução" integrado:**
  - **Heatmap mensal de dias ativos** (4 níveis: sem registro, leve, moderado, intenso);
  - **Streak unificado** (cresce ao registrar treino *ou* refeição);
  - **Sparkline de peso e cintura (30 dias)** com tendência e variação no mês;
  - **Barras semanais de constância (`S1–S4`)** com total de treinos/semana;
  - **Fotos de progresso** organizadas por data/fase com comparador antes/depois.
- **Lista de compras automática:** gerada a partir do plano alimentar e das refeições frequentes da fase ativa.
- **Cards compartilháveis de treino e marcos:** geração de cards visuais (estética Ember) com sessão, volume, PRs batidos, streak e mapa muscular da sessão — pensados para Stories/TikTok/Reels como motor de crescimento orgânico.
- **Conector MCP & Hub de IAs ("Sua rotina, conectada"):** ponte segura (read-only / escopo controlado) para conectar histórico de treino, dieta e evolução diretamente ao **Claude** e **ChatGPT**.
- **Integração Strava (OAuth/webhook):** sincronização automática de corridas, caminhadas e cardio.

### Onda 3 — Experiência conversacional rica (Chat-First completo)

- **Rich Cards na conversa:** fichas de treino numeradas (`01..06` com grupo muscular, séries×reps, descanso, duração e aquecimento), visualização de foto de prato com **pins de ingredientes identificados** (`Frango`, `Arroz`, `Feijão`) + macros, e atalhos contextuais (`Ver meu dia →`, `Ver minha evolução →`).
- **Operação 100% conversacional opcional:** permitir gerenciar toda a rotina em uma única conversa contínua (estilo Pumpy), mantendo a interface estruturada disponível com um toque sempre que o usuário preferir precisão cirúrgica.

### Onda 4 — App nativo (iOS / Android) e ecossistema de dispositivos

- **App mobile nativo (iOS e Android):** evolução natural da experiência do Mini App para aplicativo dedicado, mantendo o Telegram como canal sincronizado para quem prefere o bot.
- **Apple Health & Health Connect:** sincronização bidirecional de passos, gasto calórico, sono, treinos e peso corporal (balanças inteligentes).
- **Apple Watch, Widgets & Live Activities:**
  - Registro rápido de séries e descanso no pulso;
  - Live Activity / Dynamic Island para cronômetro de descanso e exercício atual na tela bloqueada;
  - Widgets na tela inicial (streak, saldo de kcal/macros, água e próximo treino).
- **Scanner de código de barras nativo:** leitura instantânea de embalagens integrada ao Open Food Facts e base nutricional brasileira.

### Onda 5 — Escala comercial, comunidade e B2B

- **Plataforma multi-tenant escalável:** migrar do modelo atual (um deploy + planilha por cliente) para backend multi-usuário com onboarding instantâneo em minutos — mantendo a sincronização com Google Sheets como recurso *Power User / Pro*.
- **Comunidade, Clubes & Gamificação:**
  - Perfil e compartilhamento opcional de treinos, refeições e marcos;
  - Seguir amigos, interações e motivação mútua;
  - Medalhas/badges de consistência e progressão;
  - **Clubes e desafios coletivos** com **ranking semanal/mensal que reseta todo mês**;
  - **Clube Pro** com premiações mensais e parcerias com marcas de saúde/suplementação.
- **Ecossistema B2B (Nutricionistas, Personais e Academias):**
  - Portal dedicado para profissionais acompanharem alunos/pacientes no mesmo histórico (adesão alimentar, progressão de carga, check-ins, medidas e fotos);
  - Criação e atualização de fichas/planos alimentares diretamente na conta do aluno;
  - Planos para academias criarem sua própria comunidade digital e desafios internos.
- **Estratégia de monetização e distribuição:**
  - **Free:** registro manual completo de treino/dieta, base TACO, histórico e streak;
  - **Pro (B2C):** IA ilimitada (foto, voz, chat), planos personalizados de treino e dieta, troca inteligente avançada, lista de compras, analytics profundos, conector MCP/integrações, clube VIP com desafios/prêmios;
  - **B2B / Profissionais:** licenciamento por carteira de alunos/pacientes ou por academia;
  - **Aquisição orgânica:** cards compartilháveis nativos do app + programa de afiliados + conteúdo recorrente em vídeo curto/carrossel (TikTok/Instagram/X).

---

## 4. Documentos relacionados

- Produto longitudinal (Sheet 4.0): [`docs/specs/2026-09-29-longitudinal-tracking-product-design.md`](../specs/2026-09-29-longitudinal-tracking-product-design.md)
- Mini App atual: [`docs/specs/2026-11-09-miniapp-design.md`](../specs/2026-11-09-miniapp-design.md)
- Entrada por voz: [`docs/specs/2026-11-14-voice-input-design.md`](../specs/2026-11-14-voice-input-design.md)
- Pesquisa de APIs (Telegram, TACO, Open Food Facts, código de barras): [`docs/research/2026-11-09-miniapp-apis.md`](../research/2026-11-09-miniapp-apis.md)
