# Pesquisa: APIs para o Mini App (treino e alimentação) — 2026-11-09

Fontes oficiais citadas por afirmação. "não verificado" = não confirmado em fonte.

## Parte A — Fatos técnicos do Telegram

### A1. sendData
- Envia dados ao bot como mensagem de serviço, "de até 4096 bytes", e fecha o Mini App. Só funciona para Mini Apps abertos por botão de teclado (KeyboardButton). Fonte: https://core.telegram.org/bots/webapps
- O bot recebe `Message.web_app_data` (tipo `WebAppData`) com `data` (String) e `button_text` (texto do botão que abriu o app). Ambos podem ser forjados por cliente malicioso ("a bad client can send arbitrary data"). Fonte: https://core.telegram.org/bots/api (WebAppData).
- No python-telegram-bot/long polling: o update vem como `message` com o campo `web_app_data`. Em botão de teclado, `WebAppInitData` vem vazio (sem `initData` assinado), então não dá para validar o hash; a autenticação é o próprio chat privado (checar `from_user.id`). Fonte: https://core.telegram.org/bots/webapps
- O botão `web_app` do teclado só está disponível em chats privados. Fonte: https://core.telegram.org/bots/api (KeyboardButton).

### A2. Tamanho da URL / fragmento
- `WebAppInfo.url` é "an HTTPS URL"; a documentação oficial **não cita limite de tamanho** (Bot API e página de Mini Apps). Fontes: https://core.telegram.org/bots/api e https://core.telegram.org/bots/webapps
- Busca por relatos de truncamento/rejeição de fragmentos longos: nada encontrado. **Limite real: não verificado.**
- Atenção: o cliente Telegram transmite os parâmetros de lançamento (`tgWebAppData`, `tgWebAppThemeParams`, `tgWebAppVersion` etc.) no fragmento `#`, lido em `window.location.hash`. Fonte: https://docs.telegram-mini-apps.com/platform/launch-parameters. Se Telegram sobrescreve ou concatena um fragmento próprio ao seu: não verificado. Risco real de colisão.
- Também limite do envio: o `reply_markup` faz parte do JSON do sendMessage; limite específico de tamanho do teclado: não verificado.
- Recomendação: não depender do fragmento. Alternativas ordenadas: (1) catálogo como arquivo estático `catalog.json` no próprio Pages, buscado via `fetch` (sem limite prático); (2) query string `?c=...` (mais seguro que `#`, pois Telegram usa o hash); (3) o bot reenvia o catálogo atualizado só quando muda, com versão no nome do arquivo para furar cache. Testar de qualquer modo no aparelho: abrir com fragmento de 4 KB e logar `location.hash`/`location.search`.

### A3. DecompressionStream("deflate-raw")
- Dados MDN/browser-compat-data: `DecompressionStream` Chrome 80, Safari 16.4, Firefox 113; formato `deflate-raw`: Chrome 103, Safari 16.4; Chrome Android e WebView Android espelham o Chrome (103); Safari iOS espelha Safari (16.4). Fonte: https://raw.githubusercontent.com/mdn/browser-compat-data/main/api/DecompressionStream.json ; contexto: https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream/DecompressionStream (Baseline desde maio de 2023).
- Telegram Android usa o WebView do sistema (Chrome atualizável) e iOS o WKWebView: versão mínima efetiva depende do aparelho; Telegram Desktop (Qt WebEngine) / Web: não verificado.
- Fallbacks sem dependência: (a) detectar `typeof DecompressionStream === "function"` em try/catch com `new DecompressionStream("deflate-raw")`; (b) fallback: publicar também o catálogo em JSON puro (ou gzip pelo servidor do Pages, que o navegador descompacta sozinho via `Content-Encoding`; não verificado para esse caso) e usar `fetch`; (c) base64url de JSON minificado, sem compressão (3–4 KB comprimidos tendem a virar ~10–15 KB crus; só viável via arquivo estático, não via URL).

### A4. Recursos úteis (versão da Bot API)
Fonte para todos: https://core.telegram.org/bots/webapps
| Recurso | Versão |
|---|---|
| MainButton / BackButton / HapticFeedback | 6.1 (MainButton renomeado BottomButton em 7.10) |
| enableClosingConfirmation, showPopup, showConfirm | 6.2 |
| showScanQrPopup | 6.4 (descrito só como scanner de QR; evento `qrTextReceived`) |
| CloudStorage | 6.9: até 1024 itens por usuário/bot; chave 1–128 chars (A-Za-z0-9_-); valor 0–4096 chars |
| SettingsButton | 7.0 |
| BiometricManager | 7.2 |
| disableVerticalSwipes | 7.7 |
| SecondaryButton | 7.10 |
| safeAreaInset, contentSafeAreaInset, requestFullscreen, LocationManager, Accelerometer, addToHomeScreen | 8.0 |
| DeviceStorage | 9.0: até 5 MB por usuário/bot |
| SecureStorage | 9.0: até 10 itens (Keychain/Keystore) |
| themeParams | base sem versão; campos extras em 6.1, 7.0, 7.6, 7.10 |
Versão atual da Bot API na página: 10.4 (9/11/2026). Fonte: https://core.telegram.org/bots/api
Nota: CloudStorage/DeviceStorage funcionam em app lançado por botão de teclado? Não verificado (a doc não restringe, mas `initData` vazio). Testar.

### A5. GitHub Pages como host
- Serve HTTPS; limites: site ≤ 1 GB, soft 100 GB/mês de banda, rate limit 429, 10 builds/h soft. Fonte: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- Caminho customizado (`/<repo>/miniapp/`) é só estrutura de pastas; HTTPS exigido pelo Telegram ("HTTPS URL"; HTTP só no ambiente de teste). Fonte: https://core.telegram.org/bots/webapps
- Cache (Cache-Control/max-age), CSP e cabeçalhos customizados: **não verificado** (a doc de limites não trata). Mitigação: versionar assets (`app.js?v=hash`). Repositório privado exige plano pago para Pages: não verificado.

## Parte B — APIs úteis

| Fonte | Custo / auth / limite | Cobertura BR / licença | Como ajuda |
|---|---|---|---|
| TACO (UNICAMP/NEPA), 4ª ed. 2011 | Gratuita; PDF/tabela em unicamp.br/nepa/taco; sem API oficial | Alimentos brasileiros; reprodução permitida citando a fonte (https://www.nescon.medicina.ufmg.br/biblioteca/imagem/1549.pdf). API comunitária não oficial: https://taco-api.netlify.app/en/about (licença não verificada) | Base local estática de alimentos comuns em PT-BR |
| TBCA (USP) | Download/API: não verificado | Brasileira; licença não verificada | Complemento ao TACO, se houver dump |
| Open Food Facts | Grátis, sem auth para leitura; User-Agent `App/versão (email)` obrigatório; 15 req/min produto, 10/min busca por IP; v3 recomendada, v2 depreciada | Banco ODbL, conteúdo DbCL, imagens CC BY-SA. Fonte: https://openfoodfacts.github.io/openfoodfacts-server/api/ . Cobertura de produtos BR: não verificado | Código de barras de embalagem para macros, via bot (servidor) |
| USDA FoodData Central | Grátis, chave data.gov; 1000 req/h por IP; DEMO_KEY 30/h. Fonte: http://fdc.nal.usda.gov/api-guide/ | Domínio público CC0; alimentos dos EUA (pouco BR) | Fallback de nutrientes crus (carnes, grãos) |
| wger | Código AGPL-3.0; dados de exercício sob Creative Commons conforme cada entrada. Fonte: https://raw.githubusercontent.com/wger-project/wger/master/README.md . Auth, limites e PT-BR: não verificado (site bloqueou fetch) | | Nomes/grupos musculares de exercícios |
| ExerciseDB e outros | não verificado | | |

### Código de barras no WebView
- `BarcodeDetector`: Android WebView suportado (depende de decodificação da plataforma, https://groups.google.com/a/chromium.org/g/blink-dev/c/j-PLtssE5fo/m/budv_U6fCwAJ); iOS/Safari: não suportado / desativado por padrão, segundo https://caniuse.com/mdn-api_barcodedetector . Em iOS exigiria polyfill WASM (dependência).
- `showScanQrPopup`: descrito apenas para QR (https://core.telegram.org/bots/webapps); EAN-13 não é suportado segundo a doc, comportamento real: não verificado. Alternativa sem dependência: digitar o código no bot e consultar OFF no servidor.

### Outros
- Apps Script (conta pessoal): 20.000 URL fetch/dia, 6 min por execução, 30 execuções simultâneas, 20 triggers por usuário/script. Fonte: https://developers.google.com/apps-script/guides/services/quotas . Folga ampla para uso de um usuário. Cota de Sheets API vs Apps Script: não verificado.
- Bot API: `message_effect_id` em sendMessage (só chat privado) e reações via `setMessageReaction`/`message_reaction` existem. Fonte: https://core.telegram.org/bots/api . Escopos de `setMyCommands` (BotCommandScope): não verificados nesta rodada (a página é grande demais para a ferramenta); a API é conhecida, confirmar na doc.

## Recomendações
1. Não colocar o catálogo no fragmento: usar `catalog.json` estático em Pages (fetch, versionado), com ou sem compressão. Elimina A2/A3 de uma vez.
2. Contrato de sendData: JSON compacto < 4096 bytes (medir em bytes UTF-8), validar no bot (`from_user.id` do dono, tipos, limites), tratando `data` e `button_text` como não confiáveis.
3. Usar MainButton (salvar), BackButton, HapticFeedback, `themeParams` e `safeAreaInset` (todos ≤ 8.0); `enableClosingConfirmation` para evitar perder série preenchida.
4. CloudStorage (6.9) ou localStorage para rascunho do treino; testar se funciona em app via teclado.
5. Alimentos: TACO local (estático) primeiro; Open Food Facts por código de barras digitado, com cache e User-Agent; USDA só se faltar.

Evitar: depender de `BarcodeDetector`/`showScanQrPopup` para EAN; depender de limite de URL não documentado; adicionar bibliotecas (zxing, pako) sem aprovação; scraping de TBCA; usar a API não oficial da TACO como dependência crítica; campos de exercício de wger sem checar licença por entrada.
