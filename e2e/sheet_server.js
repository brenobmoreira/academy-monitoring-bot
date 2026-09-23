/**
 * Serves the real Apps Script code (apps/sheet/src) over local HTTP, backed by the in-memory
 * spreadsheet fake the unit tests use. It stands in for the published Web App URL.
 *
 *   POST /          body goes to doPost, exactly like the Web App
 *   GET  /__sheets  current rows of the written tabs, as objects keyed by header
 *
 * Prints "LISTENING <port>" on stdout once ready. SHEET_API_KEY comes from the environment.
 */
'use strict';
const http = require('node:http');
const { load } = require('../apps/sheet/test/harness');
const { sheets } = require('../apps/sheet/test/fixtures');

const HEADER_ROW = 5;
const ctx = load({ sheets: sheets(), properties: { SHEET_API_KEY: process.env.SHEET_API_KEY || '' } });

function dump(name) {
  const sheet = ctx.__spreadsheet.getSheetByName(name);
  const headers = sheet.rows[HEADER_ROW - 1] || [];
  return sheet.rows.slice(HEADER_ROW).filter((line) => line.some((v) => v !== '' && v !== undefined)).map((line) => {
    const row = {};
    headers.forEach((h, i) => {
      const v = line[i];
      if (h && v !== '' && v !== undefined) row[h] = v instanceof Date ? ctx.Sheets.dayKey(v) : v;
    });
    return row;
  });
}

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/__sheets') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 'Diário': dump('Diário'), 'Registro de treino': dump('Registro de treino') }));
    return;
  }
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const out = ctx.doPost({ postData: { contents: body } });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(out.text);
  });
});

server.listen(0, '127.0.0.1', () => {
  console.log(`LISTENING ${server.address().port}`);
});
