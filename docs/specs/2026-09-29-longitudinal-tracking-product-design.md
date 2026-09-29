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

## As built (weekly engine)

`apps/sheet4/src/weeks.js` (`Weeks`, `dailyRefresh`), `analysis.js` (`Analysis`, `Rules`),
`recommend.js` (`Recommend`); tests `test/weeks.test.js`, `test/analysis.test.js`.

- **By date, never by storage.** `Weeks.compute(start)` reads Diário, Medidas e fotos, Registro de
  treino, Exercícios, Objetivos, Metas and Fichas once (a snapshot) and resolves versions by date.
  Ids are those in force on the Sunday; `Transição na semana` lists every id change from Tuesday to
  Sunday ("Objetivo O002 → O003 em 19/11/2026"). The history an analysis sees (previous 4 weeks)
  is recomputed the same way, so `store` and `recomputeAll` give identical rows and a later phase
  change alters nothing before it.
- **Weight**: weigh-ins Mon..as-of; 7-day (`analysis.weightTrendDays`) average at the Sunday (or
  today for the running week) vs the previous Sunday; %/week scaled to 7 days for the running week.
  **Waist**: last value of the week, Medidas wins over Diário on the same day; delta vs the latest
  earlier measurement. **Food**: only days with `Registro alimentar = Completo`, kcal present and
  no item without calculation; adherence of each day against the goal in force *on that day*
  (kcal ± tolerance, protein in [mín, máx] with mín defaulting to the target, fat ± tolerance);
  coverage "N de D dias" with D = days elapsed. **Training**: `Progression.weekSummary(start, asOf)`
  when defined; otherwise sessions = distinct sessions with a `Concluído` row, volume = Σ kg×reps of
  Work 1/Work 2 only (partial sessions included), progression = top work set vs the previous
  session of the exercise (more kg, or same kg and more reps, at the same RIR or more).
- **Status**: rules return issues (`warn`/`off`) and a positive pattern; any `off` or 2 `warn` →
  Fora do esperado, 1 `warn` → Atenção, none + positive → No caminho (none, no positive → Atenção).
  Recovery signals (sono/cansaço/dor) downgrade No caminho to Atenção. Missing weight data (or
  training data for `performance`) → Dados insuficientes; a week with no objective too.
- **Default ranges (%/sem)**: adaptacao −0.5..0.5, recomposicao −0.5..0.25, manutencao −0.3..0.3,
  manutencao_pos_cut −0.2..0.4, deficit −1.0..−0.5, ganho_controlado 0.1..0.3, ganho_agressivo
  0.3..0.6, performance −0.25..0.5, personalizado none; the objective row overrides them.
- **New Config keys** (Análise): `analysis.weightFastPctPerWeek` (0.5, lento/rápido boundary),
  `analysis.adherenceMin` (0.7, fraction of complete days on target), `analysis.phaseReviewStreak`
  (3, weeks for REVISAR OBJETIVO/FASE).
- **Recommendation**: spec §8 precedence. REVISAR ENERGIA needs the weight out of range with the
  week Fora do esperado (or Atenção two weeks running in the same objective) *and* the diet
  followed (otherwise REVISAR MACROS). REVISAR OBJETIVO/FASE: phase ≥ `minWeeksForPhaseReview`
  weeks and the last 3 weeks of that objective No caminho with the rule's expectation met
  (recomposição: waist down since the start by ≥ noise; déficit: weight down; ganho: weight up;
  manutenção/personalizado: on track; adaptação: coverage reached; performance: progression), or 3
  Fora do esperado when no energy/macros/training cause applies. `nextReview` = Sunday +
  `analysis.reviewEveryDays`.
- **Storage**: `Semanas` gains `Exercícios com regressão` and `Faixa alvo %/sem`. A closed week's
  row is final once `Calculado em` is after its Sunday; `closeFinished` writes only non-final closed
  weeks, `refreshCurrent` the running week, `recomputeAll` everything (rows updated in place).
  `Evolução` is written with the same rows. Derived writes are not undoable actions (the analysis
  actions are `logged: false`), except when they happen inside a transition.
- **Hooks**: `phase.changed`, and `day.saved` for a day of the running week → `refreshCurrent`
  (skipped without a Semanas tab; errors logged, never failing the transition or the save).
  Actions `Atualizar semana` (quick) and `Recalcular histórico` (group Análise). `dailyRefresh()`
  closes finished weeks and refreshes the current one. Food/Workout saves should emit `day.saved`
  (or call `Weeks.refreshCurrent`) to refresh on every save.

## As built (daily engine)

Files `apps/sheet4/src/diary.js`, `measures.js`, `ui_hoje.js`, `ui_actions.js`. Deviations and choices:

- **Saving from Hoje never erases by omission.** An empty Hoje cell leaves the stored Diário value
  as it is; typing `-` or `limpar` and saving clears it (não informado); `0` is stored as zero.
  The help line on Hoje says so. (`Diary.save`: absent key = untouched, `null` = clear.)
- **Estado do dia** is food-oriented: `Registro alimentar` Completo → Completo (or "Completo —
  cálculo parcial" with items without calculation); Parcial → Parcial; not declared → Parcial when
  food was logged (kcal or no-calc items), else Sem registro. A day with only measures is "Sem
  registro". Food calls `Diary.refreshState(date)` after patching totals.
- **Baselines on transition** (`transition.prepare`): Peso inicial = average of the weigh-ins of the
  `analysis.weightTrendDays` days ending the day before the start, else the latest weigh-in on or
  before the start; Cintura inicial = latest waist on or before the start (Diário wins over Medidas
  on the same day). Values given by the caller are kept; no data leaves them empty.
- **phase.changed** re-stamps Diário ids and Medidas `Objetivo` of rows dated on or after the change
  (inside the transition action, so undo reverts it).
- **Hoje layout** is a fixed cell map in `Hoje.layout()` (label A, value B; training table A–M rows
  44–55; Meta × realizado rows 60–65). Hoje writes are not logged: the screen is a view; undo
  restores the data tabs. "Meta × realizado" compares only complete days; partial days show
  "Parcial" and unknown values stay blank (never 0).
- **Actions**: Carregar dia, Salvar dia, Ir para hoje, Limpar tela (quick) and Ir para data (menu
  only, it prompts; prompts do not work on mobile). Loading and clearing are not undoable actions.
  `onEditInstalled` also stamps the Objetivo of a row typed directly on Medidas e fotos. Event
  `hoje.loaded` ({date}) lets Food/Workout fill their cards; `day.saved` follows `Diary.save`.
- The core registry tests (`core_actions.test.js`) now start from a registry with only the core
  action, since feature files register theirs at load time.

## As built (food)

Files `apps/sheet4/src/food_units.js` (`Units`), `food_catalog.js` (`Foods`), `food_log.js`
(`FoodLog`, `FoodScreen`, actions), `food_favorites.js` (`Favorites`), `food_plan.js` (`BaseDiet`,
`Equivalences`). Deviations and choices:

- **Units**: g/mg/kg and ml/l convert within their family; mass ↔ volume is refused (no density);
  any other unit is a household measure and needs Alimentos `Medida caseira` + `Base por medida`
  (the unit must match), else a Portuguese error ("2 un nunca vira 2 g"). Household conversions are
  flagged estimated.
- **Alimentação row**: quantity/unit stored in the food's base unit; the typed amount goes to
  Observação ("Informado: 2 un (medida caseira, estimada)"). `Cálculo` = Estimado when a household
  measure was used, Medição = Estimada, the food's Fonte is Estimativa/Pendente, or the favourite
  ingredient was estimated; `Conferência` says why (or OK). Sem cálculo rows keep macros empty and
  Fonte = Pendente. `ID lançamento` = `A<yyyyMMdd>-<nnn>` per date. Future dates are refused.
- **Fonte mapping** (3.0 free text → enum, first match on quality · reference · name): an exact enum
  value in `Qualidade da referência` wins; "pendente" → Pendente; estimativa/estimado/"a conferir"/
  "conferir rótulo" → Estimativa; "rótulo confirmado/conferido/verificado" → Rótulo confirmado;
  TACO/TBCA/USDA/"fonte confiável" → TACO/fonte confiável; otherwise Pendente. Both 3.0 catalogues
  map to 92 TACO + 18 Estimativa.
- **Day totals**: after every change `Days.patch(date, {kcal, protein, carbs, fat, fiber,
  noCalcItems, estimatedItems})` (sums over Calculado + Estimado rows, 0.1 rounding; macros null
  without calculable rows; all null when the day has no food row) and `Diary.refreshState(date)`.
- **Favourites**: launching expands to **one Alimentação row per ingredient** (so rows can be
  corrected/deleted one by one and each keeps its own Fonte/Cálculo), all tagged
  `Favorita / versão` = "Nome · vN"; quantities × portions, macros recomputed from the current
  catalogue. Creating from the meal of a date never logs consumption; the same name saved again is
  the next version (older ones kept); identical ingredients to the latest version are refused.
  `Ingredientes` gained a `Versão` column (the only change to `Tabs.SPEC`); its `Conferência` keeps
  the source row's Cálculo.
- **Copy**: copies stored values (not recomputed) and prefixes Observação with
  "Cópia de dd/mm/yyyy"; the same meal of the same date copied again to the same day is refused
  ("Todas" is refused when any of its meals was already copied); copying a date onto itself too.
- **Correct/Delete selected row**: act on the Alimentação selection; correction asks for the new
  amount in a dialog ("150" or "2 un"; menu only — prompts do not work on mobile, so these two are
  not quick actions).
- **Dieta base / Equivalências / Cadastro válido**: script-written values replace the 3.0 VLOOKUP
  formulas ("Recalcular dieta base e equivalências"); a food that cannot be computed leaves the
  cells empty (never 0 or #N/A); the totals row is the one whose Refeição is "Total da proposta".
  Results match the 3.0 cached values of both exports within rounding. The planned total
  (`BaseDiet.totals()`) is for display only and never feeds Diário or indicators.
- **Hoje wiring** (`FoodScreen`): reads `Hoje.read().food` + `Hoje.date()`, clears only the
  consumed fields with `Hoje.write('food', {…: null})` (meal and unit stay), re-renders Meta ×
  realizado when Hoje shows the changed date.

## As built (workout)

Files: `apps/sheet4/src/workout.js` (`Exercises`, `Workouts`, `TrainingScreen`/`HojeTrainingScreen`,
`Sessions`, `PlanDraft`, `WorkoutActions`) and `workout_progression.js` (`Progression`).

- **Rotation** — `Sessions.nextSession(date)` reads `routine.sessionRotation` (empty → session
  order of the plan in force) and `routine.rotationMode`: `continuous` = after the last *concluded*
  session on or before the date, whatever the week; `weekly` = first session on Monday, then after
  the last concluded one of that week. Partial sessions never advance; a concluded session whose
  name is not in the rotation (older plan) is skipped when looking back.
- **Load/resume** — `Sessions.load(date, session?)`: without a session, the date's partial session
  (resume), else on a past date its concluded session, else `nextSession`. Rows = the plan in force
  on that date for the session + saved rows of that date/session; each row carries the previous
  work sets of the exercise (`reference`, `referenceText`) — never copied into the work cells.
- **Save** — `Sessions.savePartial/complete(date, session, rows, {phase?})` upsert one Registro row
  per exercise (date + session + exercise), stamp `Ficha`/`Objetivo` in force on that date, `Fase`,
  prescription (`Work sets prescritas`, reps mín/máx, `Modelo de séries` = the plan row's
  "Tipos de série"), `Work sets realizadas`, `Volume work` = Σ work kg×reps (empty when no work
  set was done). Concluding marks every row of the session `Concluído`; a concluded session is
  never downgraded to `Parcial`. `Diário.Treinos` = concluded sessions of the day (via
  `Days.patch`). Validation: kg ≥ 0 (0 = body weight), reps integers, kg and reps together, RIR
  0–10 only with its set (0 valid), Dor 0–10, exercise from the catalogue or the plan in force
  (unknown → closest names), session from the plan in force or the rotation; no future dates.
- **Phase** — Adaptação while the date is within `routine.adaptationWeeks` (new Config key,
  default 0) weeks of the plan's Início, else Regular; picks the adaptation/regular sets and RIR.
  The 3.0 plans only state adaptation in free text, so it cannot be derived from them. A phase
  chosen on Hoje (B39) overrides the derived one for that save.
- **Progression** — work sets only, compared set by set (W1↔W1, W2↔W2) and only with the same
  `Equipamento / carga`; a set progresses when load goes up at ≥ reps or reps go up at the same
  load, with RIR not lower. `Progression.weekSummary(start, end)` feeds §6.1 (sessions,
  partialSessions, workSets, workVolume, workVolumeByGroup, progressed/held/regressedExercises:
  last entry in the week vs the last entry before it; volume and the lists are null when nothing was
  measured; `volumeByGroup` alias for `Weeks`). `Progression.suggestions(date)` is pure:
  "top of the rep range in every prescribed work set at the same load for
  `analysis.progressionSessions` (2) sessions → +`routine.loadIncrementKg` (2,5 kg)", and
  "regressed N times in a row → review". The action *Sugestões de progressão* renders `Progressão`
  and records each new suggestion once in `Revisões` (Área Treino, Status A revisar); it never
  touches plans, the draft, the log or Hoje.
- **Progressão tab** — the §3 summary table (one row per exercise of the plan in force: last work
  sets, RIR, trend, suggestion) plus, from column K (right of the table), the picker
  (`Progression.pickerCell()` = L4) and the last 20 sessions of the chosen exercise. Written as
  values, not logged (a view).
- **Ficha de treino** — `PlanDraft.render()` writes the plan in force (or the planned next one) as
  the draft and a title derived from the entity ("Ficha vigente F002 · Vigente desde 28/09/2026"),
  replacing typed statuses (finding #4). *Salvar nova ficha* reads `B4` (início) and `D4`
  (motivo) or args, validates (catalogue names with suggestions, integers, reps mín ≤ máx,
  duplicates, unchanged draft; warns on sessions vs Config rotation and unknown alternatives) and
  calls `Transition.newPlan`. *Mostrar ficha vigente* re-renders.
- **Hoje** — through `TrainingScreen` (`HojeTrainingScreen` over `Hoje.read().training`,
  `Hoje.write('training')`, `Hoje.clear('training')`). Prescription and previous work sets go to
  the note of each Exercício cell (the Hoje table has no reference column). On `hoje.loaded`, an
  empty training table shows the session saved on that date.
- Lists for validations: `Exercises.names()` (3.0 named range `ListaExercicios`, undefined in both
  exports) and `Sessions.names(date)` (plan in force + rotation; Zoio's 3.0 Registro list
  `Push, Pull, Legs` was stale).
- 3.0 data notes: Breno F002 "Remada com apoio" has a note in `Alternativa` ("Máquina disponível;
  confirmar execução com Luan"); F001 names differ from F002/catalogue ("Tríceps corda" vs
  "Tríceps na corda", "Hack / agachamento orientado"), so F001 history does not chain into F002
  progression by name; the catalogues hold near-duplicates ("Crucifixo inverso"/"Crucifixo
  invertido", "Panturrilha sentada"/"Panturrilha sentado", "Peck deck inverso"/"reverso"); the
  generic load convention "Carga total ou por halter: escolher…" does not state which was chosen.

## As built (migration/audit)

Files: `apps/sheet4/src/migrate.js` (`Migrate`), `audit.js` (`Audit`), `wizard.js` + `wizard.html`
(`Wizard`, menu Sistema → Configuração inicial · Migrar 3.0 → 4.0 · Auditoria), client data in
`clients/breno.json` and `clients/zoio.json` (format `academy-client/1`: `config` keyed by Config
keys, `otherClientNames`, `history.{objectives,goals,plans}` with ids and real dates, `review` flags),
preview tool `tools/migrate_preview.js` → `sheets/preview/<name>_4_0.xlsx`.

- **Auditoria** columns: `Data | Severidade | Aba | Célula/linha | Problema | Correção | Estado |
  Código | Valor anterior` (Estado: `Aberto` / `Corrigido` / `Revisar`). `Audit.findings()` writes
  nothing; `Audit.run()` appends its findings. Checks: tabs missing or under a 3.0 name, spec columns
  missing, 3.0 header texts, technical dates (< 2000; time-of-day values on 30/12/1899 excluded),
  formula errors, fixed-range formulas (≥ 100 rows) in data tabs, validations whose named range
  does not exist, text dates / dates with a time in date columns, other clients' names (Config
  `system.otherClientNames`, whole words, accents ignored), stale 3.0 status texts (title/help rows,
  layout tabs, profile) and a typed "Status da ficha" contradicting Fichas, `Versions.validate()` of
  the three entities plus "none in force today", required Config values.
- **Migrate.run(client)** is one undoable action ("Migrar 3.0 → 4.0"), idempotent through
  `system.schemaVersion`, and writes every change (with the previous value) to Auditoria, then the
  audit that is still open and the client's `review` flags. Order: rename tabs in place → create
  missing tabs → Config (3.0 profile rewritten as key/value; every 3.0 row quoted in Auditoria;
  height m → cm; client JSON wins over the 3.0 value, differences flagged `Revisar`) → per data tab:
  title/help from `Tabs.SPEC`, per-row formulas removed in script-written tabs (Diário, Semanas,
  Progressão, Evolução), header rebuilt in spec order when the tab has no data (or is
  script-rendered and incompatible, its 3.0 labels quoted), otherwise 3.0 header texts renamed and
  missing columns appended at the right; text dates / times → pure dates → versions (starts from
  `history`, else the valid date, else the plan's 3.0 Vigência, else `client.startDate` for the first
  version flagged `Revisar`; ends = next start − 1; status derived; goal carbs/tolerances/TMB/gasto;
  O001 created with the targets of the goal in force; links filled) → other-client sentences moved
  to Auditoria → stale layout status texts replaced → ids by date (`Days.restampAll`; empty id cells
  of Registro/Medidas/Revisões) → any remaining technical date cleared → 3.0 named ranges used by
  validations recreated (`ListaExercicios` → Exercícios column) → Painel formulas removed (typed
  text kept) → schema marker → `Weeks.recomputeAll` and `Setup.apply` when defined, **inside the
  same action** (a failing one is reported as `erro` in the result and in Auditoria without
  cancelling the migration; `ausente` when the module is not installed) → audit still open.
  So one "Desfazer última alteração" after a migration returns the file to 3.0, weeks included.
- Core changes: Config keys `client.notes` (profile facts) and `system.otherClientNames`; Auditoria
  columns as above and `ENUMS.AUDIT_STATE`; change-log kind `structure` (`Estrutura`: renameSheet,
  insertSheet, insertColumns, namedRange) so Undo reverts tab renames/creations; Undo now checks
  layout-cell changes for conflicts (it skipped them) and checks a cell written twice in one
  action only against the later write; undo of an append at the end of a tab clears the row
  instead of deleting it (grid size, filters and row formats stay); `Tabs.ensure` adds columns
  for tabs wider than a new sheet's 26. `Weeks.refreshSafely_` (the `action.committed` listener)
  does nothing while Semanas lacks the 4.0 columns, so undoing the migration does not write 4.0
  weeks into the 3.0 tab.
- Undo of the migration restores the 3.0 file exactly (tested on both exports, with the real Weeks
  module recomputing weeks inside the action) except the hidden `Log` tab, cached formula values
  (recomputed by Sheets) and formatting applied by `Setup.apply` (not in the change log). Formats, validations, filters and conditional formats are never touched by
  the migration; the 3.0 ones on rebuilt headers (Diário, Semanas, Progressão) stay until
  `Setup.apply` rewrites them.
- Left for later modules: Hoje keeps its 3.0 formulas (they read Diário by column letter and now
  show nothing useful) until the Hoje module renders it; Painel keeps its typed 3.0 texts and charts
  until Dashboard renders it; Guia texts are only cleaned of other-client sentences.

## As built (bot API)

Files `apps/sheet4/src/api.js` (`doPost`, `SheetApi`), `api_validator.js` (`ApiValidator`); tests
`test/api.test.js`. Agent: `services/agent` (tools, instruction, summary, `/hoje`, `/ficha`,
`/semana`, new `/fase`); e2e: `e2e/sheet_server.js` serves `apps/sheet4/src` (`SHEET_SRC=legacy`
for the old code) seeded with a synthetic client.

- **Contract** unchanged: `{key, op, args}` → `{ok, result} | {ok:false, errors:[{path, code,
  message, suggestions?}]}`, key = Script Property `SHEET_API_KEY`, strict types, every error at
  once, Portuguese messages, nothing written unless valid. Names (session, exercise, food,
  favourite) match ignoring case/accents and come back canonical; unknown ones get suggestions.
- **Writes** call only domain modules (`Diary.save`, `FoodLog.add/addFavorite/addNoCalc`,
  `Sessions.savePartial/complete`) inside `Core.withLock` and one `ChangeLog` action; `writeId` =
  the action id (only when something changed). Its commit refreshes the running week. A domain
  refusal (plain `Error`) rolls the whole action back and answers `rejected`; lock timeout →
  `unavailable`; other exceptions → `internal`. The action label is `Bot: <texto> {json}` where the
  JSON is the op summary (`op`, `date`, `session`/`meal`, `fields`/`exercises`/`items`), which
  `catalog.recent` (Log actions of the last 30 min, not undone, newest first) and `write.undo`
  read back; actions made in the sheet come back with their label only.
- **Ops**: `catalog` (today, timezone, client name, `phase` = phase.get(today), `trainingPhase`,
  sessions, rotation, `nextSession`, `lastWorkout`, exercises with group, plan rows with
  prescription, foods, favourites, meals, units, recent) · `diary.upsert {date, fields}` (the 12
  Diário inputs; absent = untouched, `null` = clear) → stored values, changed keys, day state, ids ·
  `workout.upsert {date, session, exercises:[{name, warmup?, feeder?, work:[{kg, reps, rir?}] 1–2,
  pain?, note?, equipment?}], complete?}` → per exercise warm-up/feeder apart, work sets, work
  volume, prescription, `previous` (work sets only) and `comparison` (Progression.compare), state,
  next session · `food.add {date, meal, items:[{food, qty, unit?, measure?, note?} | {favorite,
  portions?} | {description, qty?, unit?, note?}]}` → rows written (macros, Cálculo, Fonte,
  Conferência) and day totals · `day.get`, `diary.range`, `workout.range`, `exercise.history`
  (work sets only) · `phase.get {date}` → objective/goal/plan in force on that date with targets and
  the latest stored recommendation of that objective up to that week · `week.get {date}` → the
  stored Semanas row of a closed week, else `Weeks.analyze` of the week (not written) · `write.undo
  {writeId?}` → `Undo.last()` / `Undo.action(id)` (codes nothing_to_undo, not_found,
  already_undone, not_latest, conflict; path `args.writeId` when an id was given).
- **Deviations**: `workout.upsert` resending an exercise replaces its work sets but keeps the saved
  warm-up, feeder, pain and note when they are omitted (empty never erases); `rir` is optional
  (never guessed); `complete: true` with no exercises concludes what was saved. Undo now checks
  only the latest write of a cell within one action (`Undo.overwritten_`), so an action that
  patches the same Diário totals several times (several food items) can be undone;
  `ChangeLog.changeCount()` was added for the writeId. The bot's `/semana` and the weekly reminder
  use `week.get` (the sheet's analysis) instead of recomputing from ranges; `/fase [data]` shows the
  objective in force on a date.
