# Longitudinal physical tracking product (sheet 4.0) — design

Date: 2026-09-29 · Status: approved for implementation · Branch: `claude/charming-curie-kdu20x`

The spreadsheets *Projeto Breno* and *Projeto Zoio* (exports in `sheets/`) become the first two
clients of one product: a spreadsheet plus a bound Apps Script that follows one person over years
through changing objectives, goals and training plans without ever reinterpreting the past.

The owner chose to **rebuild the Apps Script from scratch in this repository**. The 3.0 script that
runs in the spreadsheets today is not in the repo; the `.xlsx` exports are the specification of
its layout and behaviour. From now on `apps/sheet` is the only source of the script.

## 1. Findings of the audit (3.0 exports, 2026-09-28)

| # | Finding | Handling |
|---|---------|----------|
| 1 | The repo's sheet API (`kg série 1..4`) no longer matches the sheets (3.0 uses warm-up, feeder, Work 1, Work 2, `Estado sessão`). The bot would write to columns that do not exist | The rebuild owns both; the bot API follows the 4.0 schema (§12) |
| 2 | `Histórico de fichas` F001 rows and `Histórico de metas` M001 have the technical date 01/01/1900 as "vigência" | Real dates: F001 15/09/2026–27/09/2026, F002 from 28/09/2026, M001 from 28/09/2026. A date before 2000 is never written or shown again (§4.4) |
| 3 | Cross-client text: Zoio's `Revisões!D7` and both `Guia e fontes!B21/C17/C21` mention the other person | Guide text becomes generic and reads names/rotations from Config; migration moves the other client's sentences out |
| 4 | Zoio `Macros e perfil!B27` "Status da ficha" = "Revisar novamente" while F002 is the plan in force | Plan status comes from the Plans entity (§4.3), never typed |
| 5 | Breno F001 notes ("Primeiras 2 semanas: 2 séries. Coluna de 3 séries…") sit next to F002 rows in history and read like the current plan | History rows carry `Status` (Encerrada/Vigente); closed versions are rendered muted with "Ficha encerrada em …" |
| 6 | Zoio's M001 has no kcal/fat; profile has no start date; Breno's profile start (21/09) differs from the F002/O001 start (28/09) | Migration sets the owner's O001/M001 values (§9) and asks for confirmation in the wizard |
| 7 | Goals, objective and thresholds are typed in text cells (`Painel!B32` "kcal ±5%…", `Macros e perfil!B26`) and in formulas (`COUNTIFS … "Sim"`, fixed `$A$6:$A1000`) | All structural values move to Config/entities; weekly numbers are computed by the script, not by per-cell formulas (§6) |
| 8 | `Semanas`/`Painel` are live formulas: changing a goal or objective today re-evaluates past weeks | Weekly analysis rows are stored values with the objective/goal/plan ids of that week (§6.2) |
| 9 | Fixed ranges `A6:A1000` in formulas; data past row 1000 would be ignored | No fixed-range formulas in data tabs; the script reads by header |
| 10 | Google-only functions (`COUNTUNIQUE`, `FILTER`) appear as `__xludf.DUMMYFUNCTION` in the export | Not an error in Sheets; removed anyway by §6 |
| 11 | Both files have no data yet (Diário, Registro, Alimentação empty) | Migration is low-risk; it still preserves every existing row |

## 2. Principles

1. **Objective, goal and plan are three independent, versioned entities.** Each version has an id
   (`O001`, `M001`, `F001`), a start date, an end date (empty while in force) and a status. A
   change closes the version in force (end = day before the new start) and creates the next one.
   Nothing is overwritten.
2. **Everything is resolved by date.** Any computation about a day or week asks
   `Objectives.on(date)`, `Goals.on(date)`, `Plans.on(date)`. There is no "current objective"
   shortcut outside the Painel.
3. **Closed weeks are frozen.** Weekly analysis is stored as values with the ids used. Recomputing a
   week uses the same by-date lookup, so it gives the same answer after a phase change.
4. **No client data in code.** Names, sex, sessions, rotations, goals, thresholds and texts live in
   the sheet (Config and entities). Cloning the spreadsheet (or running Setup on an empty one) makes
   a new client with no code change.
5. **Nothing changes targets automatically.** The script suggests; a person approves. Transitions
   are explicit actions logged in `Revisões`.
6. **Unknown is not zero.** Every measure distinguishes *não informado* (empty), *zero* (0), and
   for aggregates *parcial/completo*, *estimado/calculado/sem cálculo* (§4.5).
7. **Mobile first for input.** Menus do not exist in the Sheets mobile app, so every action is also
   reachable from the `Ação rápida` dropdown on `Hoje` (installable onEdit trigger).

## 3. Tabs

Layer 1 — person (visible, first): `Hoje`, `Painel`, `Progressão`, `Dieta base`, `Ficha de treino`,
`Medidas e fotos`.
Layer 2 — history: `Semanas`, `Evolução`, `Alimentação`, `Registro de treino`, `Diário`, `Revisões`,
`Objetivos`, `Metas`, `Fichas`.
Layer 3 — technical (grey tabs, grouped at the end): `Config`, `Alimentos`, `Favoritas`,
`Ingredientes`, `Equivalências`, `Exercícios`, `Guia`, `Auditoria`, `Log`.

Renames from 3.0: `Macros e perfil` → `Config` (+ profile card on Painel); `Histórico de metas` →
`Metas`; `Histórico de fichas` → `Fichas`; `Guia e fontes` → `Guia`. `Evolução`, `Objetivos`,
`Auditoria` and `Log` are new. The migration renames tabs in place (keeps sheet ids, links and
charts pointing at them).

Every data tab: title on row 2, one-line help on row 3, header on row 5, data from row 6. The code
addresses columns **by header text** through `Tabs` (§5.2); column order may change.

### 3.1 Entity tabs

`Objetivos` — one row per objective version:
`ID | Objetivo | Tipo de análise | Início | Fim | Status | Peso inicial kg | Cintura inicial cm |
Motivo da mudança | Expectativa principal | Variação de peso alvo %/sem mín | Variação de peso alvo %/sem máx |
kcal iniciais | Proteína g | Gordura g | Carboidrato g | Treinos/sem | Cardio/sem | Atividades/sem |
Meta ligada | Ficha ligada | Revisor | Observações`

- `Objetivo` is free text ("Recomposição corporal", "Mini-cut pré-viagem"…).
- `Tipo de análise` is a list validated against the rule registry (§7): `adaptacao`,
  `recomposicao`, `manutencao`, `deficit`, `ganho_controlado`, `ganho_agressivo`,
  `manutencao_pos_cut`, `performance`, `personalizado`. A custom objective picks the closest rule set
  or `personalizado` (generic rules, uses the target range columns only).
- `Status`: `Vigente` | `Encerrado` | `Planejado` (future start).
- Peso/cintura iniciais are filled at creation from the 7-day average / latest measurement.

`Metas` — one row per goal version:
`ID | Objetivo | Início | Fim | Status | kcal | Proteína g | Proteína mín | Proteína máx | Gordura g |
Carboidrato g | Fibra g | Tolerância kcal | Tolerância gordura | Treinos/sem | Cardio/sem |
Atividades/sem | Passos/dia | TMB kcal | Método TMB | Fator de atividade | Gasto estimado kcal |
Motivo | Revisor`

Carboidrato is computed at creation `(kcal − 4·P − 9·G)/4` and stored (the value used is part of
history). TMB/fator/gasto are stored with the goal so TMB ≠ gasto estimado ≠ meta kcal stay distinct.

`Fichas` — 3.0 `Histórico de fichas` plus `Início | Fim | Status` per version (per row, repeated for
each exercise row of a version). `Ficha de treino` shows the version in force, editable as a draft;
`Salvar nova ficha` archives it as the next version.

### 3.2 Config

Two-column key/value table (`Chave | Valor | Unidade | Descrição`), grouped by section headers.
Keys (English ids in code, Portuguese labels in the sheet):

| Section | Keys |
|---------|------|
| Perfil | `client.name`, `client.sex` (`M`/`F`, used only by the TMB equation), `client.birthDate` or `client.age`, `client.heightCm`, `client.startWeightKg`, `client.startDate`, `client.reviewer` |
| Rotina | `routine.strengthPerWeek`, `routine.cardioPerWeek`, `routine.activities` (text, e.g. "Muay Thai"), `routine.activitiesPerWeek`, `routine.sessionRotation` (e.g. `Upper, Lower, Full Body`), `routine.rotationMode` (`continuous` = next session after the last completed one; `weekly` = restart each week) |
| Energia | `energy.bmrMethod` (`mifflin`), `energy.activityFactor` |
| Análise | `analysis.weightTrendDays` (7), `analysis.minWeighInsPerWeek` (3), `analysis.minCompleteFoodDays` (4), `analysis.kcalTolerance` (0.05), `analysis.fatTolerance` (0.15), `analysis.waistNoiseCm` (0.5), `analysis.weightNoisePctPerWeek` (0.25), `analysis.sleepMinH` (7), `analysis.fatigueHigh` (4), `analysis.hungerHigh` (4), `analysis.painHigh` (4), `analysis.reviewEveryDays` (7), `analysis.minWeeksForPhaseReview` (8) |
| Sistema | `system.schemaVersion` (`4.0`), `system.timezone` |

Current objective/goal/plan are **not** keys: they are derived from the entities and shown on
Config as read-only lines. `Config` is the only place Setup reads to render names and texts.

### 3.3 Daily and log tabs

`Diário` (one row per day, input columns written by the script):
`Data | Peso kg | Cintura cm | Sono h | Passos | Cardio min | Atividade min | Atividade | Fome 1–5 |
Cansaço 1–5 | Dor 0–10 | Registro alimentar | Observações | Objetivo | Meta | Ficha | kcal | Proteína g |
Carboidrato g | Gordura g | Fibra g | Itens sem cálculo | Itens estimados | Treinos | Estado do dia`

- `Registro alimentar`: `Não informado` | `Parcial` | `Completo`.
- `Objetivo | Meta | Ficha`: ids resolved for that date, written when the day is saved (and
  re-resolved by `Recalcular`). Goal numbers are not copied per day any more; they are looked up
  by id.
- Food totals (`kcal`…`Itens estimados`) and `Treinos` are written by the script from
  `Alimentação`/`Registro de treino` whenever those change (no per-row formulas).
- `Estado do dia`: `Sem registro` | `Parcial` | `Completo` | `Completo — cálculo parcial`.

`Alimentação`: 3.0 columns plus `Fonte` (`Rótulo confirmado` | `TACO/fonte confiável` | `Estimativa` |
`Pendente`) and `Cálculo` (`Calculado` | `Estimado` | `Sem cálculo`). `Sem cálculo` rows keep macros
empty (never 0).

`Registro de treino`: 3.0 columns (warm-up, feeder, Work 1, Work 2, `RIR work 1`, `RIR work 2`,
`Estado sessão` = `Parcial` | `Concluído`, `Modelo de séries`) plus `Objetivo`. Only work sets count in
volume/progression.

`Medidas e fotos`: 3.0 columns plus `Objetivo`.

`Revisões`: `Data | Área | Observação / motivo | Alteração | Revisor | Status | Próxima revisão |
Resultado | Objetivo | Meta | Ficha | Recomendação`.

`Log` (hidden): the change log used by undo (§5.4) — `Quando | Ação | Aba | Linha | Antes (JSON) |
Depois (JSON) | Desfeito`.

## 4. Domain rules

### 4.1 Versioned entities

`Versions` is one generic implementation used by Objectives, Goals and Plans:

```
on(date)          -> version whose Início ≤ date ≤ (Fim or ∞); null before the first
current()         -> on(today)
list()            -> all versions ordered by Início
nextId()          -> prefix + 3 digits, max existing + 1
open(fields, start)  -> closes the version in force on start−1 (Fim, Status=Encerrado) and appends
                         the new one (Status=Vigente, or Planejado when start > today)
```

Validation: no overlap, no gap between consecutive versions of the same entity, `Início` ≤ `Fim`,
one `Vigente`. A start before the latest version's start is rejected (history is append-only).

### 4.2 Phase transition

`Transition.apply({date, objective, goal?, plan?, reason, reviewer})`, called only from the
"Mudar objetivo/fase" dialog after the person confirms a preview:

1. `Objectives.open(objective, date)`.
2. If `goal` given: `Goals.open(goal, date)` linked to the new objective; else the goal in force
   continues and the new objective records `Meta ligada` = that id.
3. If `plan` given: `Plans.open(...)`; else the plan continues.
4. A `Revisões` row (`Área` = `Objetivo/fase`) with ids before → after and the reason.
5. Current week re-analysed; closed weeks untouched.

"Nova meta" and "Salvar nova ficha" are the same operation limited to one entity.

### 4.3 Energy

- TMB Mifflin-St Jeor: `10·kg + 6.25·cm − 5·idade + 5` (M) / `− 161` (F). Breno: 1.673,75; Zoio: 1.886,25.
- Gasto estimado = TMB × `energy.activityFactor` (stored as an estimate, labelled "estimado").
- Meta kcal is chosen by a person and stored in the goal; carbs derive from kcal, P, G.
- Four distinct numbers are shown with their labels: TMB · gasto estimado · meta da fase · dieta
  base (planned, `Dieta base` totals) · ingestão realizada (Alimentação).

### 4.4 Dates

- Every date cell is a pure local date (midnight, script time zone), formatted `dd/mm/yyyy`.
- A value before 2000-01-01 is treated as missing when read and never written. Setup applies a
  conditional format that hides such values, and the audit reports them.

### 4.5 Data states

| State | Meaning | Where |
|-------|---------|-------|
| não informado | cell empty | any measure |
| zero | numeric 0 typed or saved | any measure |
| parcial / completo | the person's declaration for food; `Estado sessão` for training | Diário, Registro |
| estimado | value derived from household units or estimated sources | Alimentação `Cálculo`, Metas gasto |
| calculado | derived by the script from confirmed inputs | totals |
| sem cálculo | food logged without known macros | Alimentação |

Aggregates never treat empty as 0 and always show coverage ("4 de 7 dias").

## 5. Apps Script architecture

### 5.1 Files (`apps/sheet/src`, one global scope)

| File | Namespace | Responsibility |
|------|-----------|----------------|
| `core_dates.js` | `Dates` | local dates, keys, week start (Monday), guards for technical dates |
| `core_tabs.js` | `Tabs` | tab registry (name, layer, header row, columns: header, type, role `input`/`calc`/`id`), read/append/update rows by header, find by key |
| `core_config.js` | `Config` | Config tab (typed get with defaults), Script Properties for secrets |
| `core_versions.js` | `Versions`, `Objectives`, `Goals`, `Plans` | §4.1–4.2 |
| `core_log.js` | `ChangeLog`, `Undo` | before/after log, undo of the last action (replaces `undo.js`) |
| `energy.js` | `Energy` | §4.3 |
| `diary.js` | `Diary` | day rows, states, measures |
| `food.js` | `Foods`, `FoodLog`, `Favorites`, `Units` | catalogue, units/conversions, log, favourites + ingredients, copy, no-calc, correct/delete |
| `workout.js` | `Exercises`, `Sessions`, `Progression` | plan in force, load/partial/complete/resume, rotation, progression history and suggestions |
| `measures.js` | `Measures` | waist/other measures and photo links |
| `weeks.js` | `Weeks` | weekly aggregation (§6) |
| `analysis.js` | `Analysis`, `Rules` | rule registry per `Tipo de análise` (§7) |
| `recommend.js` | `Recommend` | recommendation state (§8) |
| `dashboard.js` | `Dashboard` | Painel and Evolução rendering, charts (§10) |
| `ui_hoje.js` | `Hoje` | Hoje layout and read/write of its cells |
| `ui_actions.js` | `Actions`, `onOpen`, `onEditInstalled` | menu, Ação rápida, dialogs |
| `ui_style.js` | `Style` | design tokens and helpers (§11) |
| `setup.js` | `Setup` | builds/updates every tab from `Tabs` + styles, validations, protections, triggers; idempotent, never deletes data |
| `migrate.js` | `Migrate` | 3.0 → 4.0 (§9) |
| `audit.js` | `Audit` | structural audit → `Auditoria` tab |
| `api.js`, `validator.js`, `schema.js` | `SheetApi`… | bot API (§12) |

Old files (`sheet_ui.js`, `sheets.js`, `diary.js` 3.x logic, `progression.js`, `undo.js`) are
replaced; `api.js`/`validator.js` are rewritten against the new modules.

### 5.2 Tabs registry

`Tabs.SPEC` is the single description of every tab (§3). `Setup`, `Migrate`, `Audit`, repos and the
API all read it. A column spec: `{key, header, type: 'date'|'number'|'integer'|'text'|'enum'|'bool'|'id',
role: 'input'|'calc'|'id', enum?: [...], width?}`. Repos return objects keyed by `key`.

### 5.3 Actions

Every user action is a function `Actions.<name>()` with the same effect from the menu and from
`Ação rápida`. Menu `Projeto`:

- Hoje: Carregar dia · Salvar dia · Salvar parcial do treino · Concluir treino · Carregar treino
- Alimentação: Lançar alimento · Lançar favorita · Lançar sem cálculo · Copiar refeição/dia ·
  Corrigir linha selecionada · Excluir linha selecionada · Criar favorita da refeição
- Fase e metas: Nova meta · Mudar objetivo/fase · Salvar nova ficha · Registrar revisão
- Análise: Atualizar semana · Recalcular histórico · Atualizar painel · Sugestões de progressão
- Desfazer última alteração
- Sistema: Configuração inicial · Migrar 3.0 → 4.0 · Auditoria · Reaplicar layout

Writes take `LockService.getScriptLock()` and log to `Log` before writing.

### 5.4 Undo

Generalises the F6 undo log: each action records the before-values of the cells it wrote (or the
rows it appended/deleted) in `Log` (a tab, not a Script Property, so it has no size limit and is
auditable). `Desfazer` restores the latest not-undone action; the bot's `write.undo` uses it too.

## 6. Weekly engine

### 6.1 Aggregation

A week is Monday–Sunday. For each week `Weeks.compute(start)` returns:

- ids: objective, goal, plan **in force on the week's Sunday**, plus `Transição na semana` when any
  id changed inside the week (the analysis then uses the objective of the later part and says so);
- weight: weigh-ins, 7-day moving average at week end, delta vs previous week, %/week;
- waist: last measurement of the week (Diário or Medidas), delta vs previous measurement;
- food: complete days with calculation, averages kcal/P/G/C/fibra over those days only, adherence
  against the week's goal (kcal within tolerance, P within [mín, máx], fat within tolerance),
  coverage, items without calculation;
- training: sessions completed vs goal, work-set volume per group, count of exercises with
  progression (load or reps up at same RIR or better vs previous session of the same exercise);
- recovery: sleep avg, hunger avg, fatigue avg, pain max, steps avg, cardio min, activity sessions;
- data sufficiency flags.

### 6.2 Storage

`Semanas` rows = the aggregate + analysis + recommendation, **as values**, with `Calculado em`. The
current week is recomputed on every save and by the daily trigger; a closed week is written once
(when the week ends) and only rewritten by `Recalcular histórico`, which uses the same by-date
lookups.

## 7. Analysis rules

`Rules.register(type, {label, evaluate(week, context) -> {status, signals[], reasons[]}})`. Context
has the objective and goal of that week, the previous 4 weeks and Config thresholds.

Signals are small named facts (`peso_estavel`, `peso_caindo_lento`, `peso_caindo_rapido`,
`peso_subindo_lento`, `peso_subindo_rapido`, `cintura_caindo`, `cintura_subindo`,
`desempenho_subindo`, `desempenho_caindo`, `proteina_baixa`, `kcal_fora`, `aderencia_baixa`,
`sono_baixo`, `fadiga_alta`, `fome_alta`, `dor_alta`, `dados_insuficientes`…) computed once by
`Analysis.signals(week)`; each rule set only combines them. Status per week: `No caminho` |
`Atenção` | `Fora do esperado` | `Dados insuficientes`.

| Tipo | "No caminho" when | Attention when |
|------|-------------------|----------------|
| `recomposicao` | weight stable (±noise) or slowly down (≤0.5%/wk) **and** (waist down or performance up) | weight trend outside, waist up, performance down |
| `deficit` | weight down within the objective's %/wk range, performance kept, recovery ok | too fast, stalled 2+ weeks, performance down, hunger/fatigue high |
| `ganho_controlado`/`ganho_agressivo` | weight up within range, performance up | too fast (waist up faster), stalled, performance flat |
| `manutencao`/`manutencao_pos_cut` | weight within ±range, waist stable | drift beyond range 2+ weeks |
| `adaptacao` | adherence and data coverage improving | low coverage |
| `performance` | performance up, recovery ok | performance down, recovery signals |
| `personalizado` | weight %/wk inside the objective's min/max when set, else only data/recovery checks | outside range |

Ranges come from the objective row (`Variação de peso alvo %/sem mín/máx`) with defaults per type
in `Rules` (documented in `Guia`). Adding a new type is registering one object.

## 8. Recommendations

`Recommend.for(week, history)` → `{code, reason, data, nextReview}` where code ∈ `MANTER`,
`REVISAR ENERGIA`, `REVISAR MACROS`, `REVISAR TREINO`, `REVISAR RECUPERAÇÃO`, `REVISAR OBJETIVO/FASE`,
`DADOS INSUFICIENTES`. Precedence: insufficient data → recovery → energy → macros → training →
phase → keep. `REVISAR OBJETIVO/FASE` appears when the phase has lasted at least
`analysis.minWeeksForPhaseReview` and the last 3 weeks are "No caminho" with the expectation met
(e.g. waist target reached), or 3 consecutive "Fora do esperado". The script never changes targets.

## 9. Migration 3.0 → 4.0

`Migrate.run()` is idempotent (records `system.schemaVersion` = 4.0 at the end; re-running is a
no-op) and writes an `Auditoria` report of every change. It never deletes a data row.

1. Rename tabs (§3). Create `Objetivos`, `Evolução`, `Auditoria`, `Log`, `Config` (from
   `Macros e perfil` values).
2. `Metas`: M001 start 1900 → the O001 start; add the new columns; Breno M001 = 2400/140 (135–145)/65/313,75;
   Zoio M001 = 2650/170 (160–180)/70/335 (owner's values; P range chosen here, flagged for review).
3. `Fichas`: F001 → Início 15/09/2026, Fim 27/09/2026, Encerrada; F002 → Início 28/09/2026, Vigente.
4. `Objetivos`: O001 = "Recomposição corporal", `recomposicao`, from 28/09/2026, Vigente, initial
   weight from Config (Breno 67, Zoio 85), targets = M001, reviewer from Config.
5. Config: Breno — M, 24, 179 cm, 67 kg, strength 3/wk, Muay Thai 2/wk, cardio 0, rotation
   `Upper, Lower, Full Body`; Zoio — M, 25, 185 cm, 85 kg, strength 5/wk, cardio 2/wk, rotation
   `Push A, Pull A, Legs A, Push B, Pull B, Legs B`, `continuous`. Activity factor 1.55 (estimate,
   flagged). The wizard shows these values for confirmation before writing; sex is asked, not
   assumed.
6. Residues: sentences naming the other client are moved to `Auditoria` (quoted) and removed from
   `Guia`/`Revisões` text; 3.0 status texts ("Revisão 3.0 validada…", "Status da ficha") are
   replaced by derived values.
7. Diário/Registro/Alimentação/Medidas: add new columns; existing rows get ids by date.
8. Replace formula-driven `Semanas`/`Painel` with script-rendered ones; recompute all weeks.
9. `Setup.apply()` for layout and styles.

The per-client values in steps 2–5 are **not in code**: `clients/breno.json` and
`clients/zoio.json` (repo root) hold them, and the wizard offers "colar configuração" (paste JSON)
or reading from the 3.0 profile tab. A new client uses the same wizard on an empty spreadsheet.

## 10. Painel and Evolução

`Painel` (rendered by the script, cards laid out on a 12-column grid, readable at phone width):

1. Header band: **OBJETIVO ATUAL — O001 · Recomposição corporal** · since dd/mm · N weeks · reviewer.
2. Fase atual: início, duração, peso inicial → atual (7d avg) → Δ, cintura inicial → atual → Δ.
3. Metas atuais (M id): kcal, P (faixa), G, C, fibra, treinos/sem, cardio/atividades; TMB and gasto
   estimado shown small, labelled as estimates.
4. Estado atual (this week so far + last closed week): tendência de peso, cintura, alimentação
   (adherence + coverage), desempenho (progressions), recuperação (sono, fome, cansaço, dor),
   aderência ao treino — each with a status chip.
5. Recomendação: code chip, reason, data used, next review date.
6. Linha do tempo das fases: one row per objective (O001 → O002 …) with dates, duration, weight and
   waist change inside the phase, outcome.
7. Charts: weight (7d avg) and waist over all weeks, **one series per phase** (so the line changes
   colour at each transition) plus a marker series at transition weeks.

`Evolução`: the long-term table behind the charts (one row per week: ids, weight avg, waist,
kcal avg, protein avg, sessions, volume, status, recommendation) and the per-phase summary.

## 11. Design system

- Tokens in `Style`: neutral surface, one accent per status (ok / attention / off / insufficient),
  input fill (light yellow with dark border) vs calculated fill (light grey, italic-free, protected
  with warning), header band colour per layer, 10–11 pt body, 14–18 pt titles, Roboto/Inter.
- Input cells: validation lists or number ranges; calculated cells protected (warning only, so the
  owner can still fix).
- Gridlines hidden on layer-1 tabs; frozen header rows; column widths from `Tabs.SPEC`; tab colours
  per layer; hidden technical helper columns grouped, not deleted.
- `Hoje` is laid out for a phone: two input columns wide at most, sections top-down (Dia → Medidas →
  Alimentação → Treino → Meta × realizado), `Ação rápida` pinned at the top.
- Navigation: a row of links on `Painel` and `Hoje` to the layer-1 tabs (`HYPERLINK("#gid=…")`).

## 12. Bot API alignment

Ops keep the envelope and error contract. `workout.upsert` exercises become
`{name, warmup?: {kg, reps}, feeder?: {kg, reps}, work: [{kg, reps, rir}] (1–2), pain?, note?, equipment?}`
and write `Estado sessão` (`Parcial` unless `complete: true`). `diary.upsert` gains `waistCm` (moved),
`activityMin`, `activity`, `painLevel`, `foodLog` (`Não informado|Parcial|Completo`). `catalog` returns
the objective/goal/plan in force and the session rotation's next session. New read op
`phase.get {date}` → ids and targets in force on that date. The Python agent's tools, instruction
and summary follow (work sets only in volume and comparison).

## 13. Tests

Node suite (fakes extended with formatting, validation, protection, charts and triggers as
recording no-ops) plus scenario tests that load the 3.0 exports as fixtures
(`apps/sheet/test/fixtures/*.json`, generated from `sheets/*.xlsx` by `tools/xlsx_to_fixture.py`):

- migration of both exports: every check in §1 resolved, no row lost, idempotent second run;
- recomposição → ganho; ganho → déficit; change without new plan; with new goal; with new plan;
- a historical week analysed with its historical objective, unchanged after a later transition;
- Painel uses only the objective in force; Evolução/charts span phases with one series per phase;
- changing the objective today leaves every stored classification of earlier months identical;
- data states (empty vs zero, partial food day, no-calc items) never counted as zero;
- undo of each action type;
- bot API against the 4.0 schema; Python agent tests.

`tools/fixture_to_xlsx.py` writes the migrated fake spreadsheet back to `.xlsx` (values and basic
formatting) as a preview under `sheets/preview/`.

## 14. Needs the owner (after the code is merged)

1. In each spreadsheet: `clasp push` the 4.0 script (replacing the 3.0 code), reload, run
   **Projeto → Sistema → Migrar 3.0 → 4.0**, confirm the wizard values, read `Auditoria`.
2. Authorize the installable triggers (Setup creates them).
3. New Web App deployment version for the bot; redeploy the agent.
4. Review the values flagged as estimates: activity factor, Zoio's protein range.
