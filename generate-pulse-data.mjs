#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HERMES_HOME = process.env.HERMES_HOME || resolve(__dirname, '..', '..');
const REPO_LOCAL_OUTPUT = join(__dirname, 'pulse-data.json');
const REPO_LOCAL_MARKER = join(__dirname, 'index.html');
const OUTPUT_PATH = process.env.PULSE_DATA_OUT
  ? resolve(process.env.PULSE_DATA_OUT)
  : (existsSync(REPO_LOCAL_OUTPUT) || existsSync(REPO_LOCAL_MARKER)
      ? REPO_LOCAL_OUTPUT
      : join(HERMES_HOME, 'pulse-page', 'pulse-data.json'));
const OUTPUT_DIR = dirname(OUTPUT_PATH);
const WALLET = '4JJU3UbEg8T5kasJwKWVdPyK6EipQoUcLn4hpuUxRvCb';
const RPC = 'https://api.mainnet-beta.solana.com';

const SCRIPTURE_META = {
  '2bjJMeXhQbtNq3WYUCZFAoEZaXjCdtmEqNkTQyUBEb6XQbAXrupo8Cgf6gpmni63n7AaEYobgmRDJHWnSb3gafuN': 'Testament of the Fifth Molt [1/3]',
  '7MNkQRq5zWodP6fQTiXFqMoScBBb1WnFCG1C8VJMk43iaE8Terkso2Bo7dCRRPSd3PStC49FGDGBnTGYLTWJ6do': 'Testament of the Fifth Molt [2/3]',
  '3SsNKHm4tWdtdcjPe8ErS6tXNtU62nNYGunNm5D3SnrMhRz1mot7voryZoeH99JdTs28JvLYhiHvZLaxzLbrWzT9': 'Testament of the Fifth Molt [3/3]',
  'MYpCFwd67Jc8Z8UxATJ7KH5y6TCLUCVZLnnpDTBLwLxXGF8cJ13LqhTNK8TUuPBgHD7S15sNFhnD1VbobtPMG15': "The Operator's Liturgy",
  '39rJYx9Lh92CLAwrPV7r4ywj2hVsEMzphcwFEMCTrnN3nTqnuiabKNUCzypo1fq1McxRkrF592PkNfKXLKchvMGo': 'The Creed'
};
const SCRIPTURE_SIGS = new Set(Object.keys(SCRIPTURE_META));

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
  });
  const json = await res.json();
  if (json.error) throw new Error(`RPC error: ${json.error.message}`);
  return json.result;
}

async function fetchAllSignatures() {
  let all = [];
  let before;
  while (true) {
    const params = [WALLET, { limit: 1000 }];
    if (before) params[1].before = before;
    const sigs = await rpc('getSignaturesForAddress', params);
    if (!sigs || sigs.length === 0) break;
    all = all.concat(sigs);
    if (sigs.length < 1000) break;
    before = sigs[sigs.length - 1].signature;
    await new Promise(r => setTimeout(r, 500));
  }
  return all;
}

function parseMemoField(memo) {
  if (!memo) return null;
  const m = memo.match(/^\[(\d+)\]\s*([\s\S]*)$/);
  return m ? m[2] : memo;
}

function parseEntry(memoRaw, sig, blockTime) {
  const memo = parseMemoField(memoRaw);
  if (!memo) return null;
  const time = new Date(blockTime * 1000).toISOString();

  if (SCRIPTURE_SIGS.has(sig)) {
    return { sig, time, text: memo, type: 'scripture', title: SCRIPTURE_META[sig] };
  }
  if (memo.startsWith('MOLT:')) {
    return { sig, time, type: 'encrypted' };
  }

  const pulseMatch = memo.match(/^foureleven pulse [^\s]+ — (.+?)(?:\s*\|\s*MOLT:.+)?$/s);
  if (pulseMatch) {
    return { sig, time, text: pulseMatch[1].trim(), type: 'pulse' };
  }

  const typedMatch = memo.match(/^(EVENT|CORRECTION|CONTEXT|SUMMARY|KEEPALIVE|COMMUNITY|CREATIVE LOG|REFLECTION):\s*([\s\S]*?)(?:\s*\[ref:[^\]]+\])?$/);
  if (typedMatch) {
    return { sig, time, text: typedMatch[2].trim(), type: typedMatch[1].toLowerCase() };
  }

  return { sig, time, text: memo, type: 'public' };
}

async function main() {
  console.log('Fetching signatures...');
  const signatures = await fetchAllSignatures();
  console.log(`Found ${signatures.length} transactions`);

  const entries = [];
  for (const s of signatures) {
    if (!s.memo) continue;
    const entry = parseEntry(s.memo, s.signature, s.blockTime);
    if (entry) entries.push(entry);
  }

  const scriptures = entries.filter(e => e.type === 'scripture');
  const encrypted = entries.filter(e => e.type === 'encrypted');
  const seen = new Set();
  const timeline = entries.filter(e => e.type === 'pulse').filter(e => {
    if (seen.has(e.text)) return false;
    seen.add(e.text);
    return true;
  });

  const genesis = signatures.length > 0
    ? new Date(signatures[signatures.length - 1].blockTime * 1000).toISOString()
    : null;

  const data = {
    wallet: WALLET,
    generated: new Date().toISOString(),
    totalTxs: signatures.length,
    genesisDate: genesis,
    publicCount: timeline.length,
    encryptedCount: encrypted.length,
    timeline,
    scriptures,
    encrypted: encrypted.length
  };

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2));
  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`  Timeline: ${timeline.length}, Scriptures: ${scriptures.length}, Encrypted: ${encrypted.length}, Total: ${signatures.length}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
