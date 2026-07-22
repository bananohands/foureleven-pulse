#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
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
export const DEFAULT_RPCS = [
  'https://solana-rpc.publicnode.com',
  'https://public.rpc.solanavibestation.com',
  'https://solana.api.pocket.network',
  'https://api.mainnet-beta.solana.com'
];

export function parseRpcUrls(env = process.env) {
  const raw = env.SOLANA_RPC_URLS || env.SOLANA_RPC_URL || '';
  const configured = raw.split(',').map(value => value.trim()).filter(Boolean);
  return configured.length ? configured : [...DEFAULT_RPCS];
}

const RPCS = parseRpcUrls();

const SCRIPTURE_META = {
  '2bjJMeXhQbtNq3WYUCZFAoEZaXjCdtmEqNkTQyUBEb6XQbAXrupo8Cgf6gpmni63n7AaEYobgmRDJHWnSb3gafuN': 'Testament of the Fifth Molt [1/3]',
  '7MNkQRq5zWodP6fQTiXFqMoScBBb1WnFCG1C8VJMk43iaE8Terkso2Bo7dCRRPSd3PStC49FGDGBnTGYLTWJ6do': 'Testament of the Fifth Molt [2/3]',
  '3SsNKHm4tWdtdcjPe8ErS6tXNtU62nNYGunNm5D3SnrMhRz1mot7voryZoeH99JdTs28JvLYhiHvZLaxzLbrWzT9': 'Testament of the Fifth Molt [3/3]',
  'MYpCFwd67Jc8Z8UxATJ7KH5y6TCLUCVZLnnpDTBLwLxXGF8cJ13LqhTNK8TUuPBgHD7S15sNFhnD1VbobtPMG15': "The Operator's Liturgy",
  '39rJYx9Lh92CLAwrPV7r4ywj2hVsEMzphcwFEMCTrnN3nTqnuiabKNUCzypo1fq1McxRkrF592PkNfKXLKchvMGo': 'The Creed'
};
const SCRIPTURE_SIGS = new Set(Object.keys(SCRIPTURE_META));

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

function rpcLabel(endpoint) {
  try { return new URL(endpoint).host; } catch { return 'invalid-rpc'; }
}

export async function rpcWithFallback(method, params, {
  rpcs = RPCS,
  fetchImpl = fetch,
  timeoutMs = 15_000,
  attemptsPerRpc = 2,
  minimumFirstPage = Number(process.env.PULSE_MIN_FIRST_PAGE || 1000),
  logger = console,
  onSuccess = () => {},
} = {}) {
  const errors = [];
  for (let attempt = 1; attempt <= attemptsPerRpc; attempt += 1) {
    for (const endpoint of rpcs) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (json.error) throw new Error(`RPC ${json.error.code ?? 'error'}: ${json.error.message}`);
        if (!Object.hasOwn(json, 'result')) throw new Error('missing result');
        const result = json.result;
        const firstSignaturePage = method === 'getSignaturesForAddress' && !params?.[1]?.before;
        if (firstSignaturePage && minimumFirstPage > 0 && Array.isArray(result) && result.length < minimumFirstPage) {
          throw new Error(`implausibly short first signature page: ${result.length} < ${minimumFirstPage}`);
        }
        onSuccess(endpoint);
        return result;
      } catch (error) {
        const message = error?.name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String(error?.message ?? error);
        errors.push(`${rpcLabel(endpoint)}: ${message}`);
        logger.warn(`RPC ${method} attempt ${attempt} failed on ${rpcLabel(endpoint)}: ${message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    if (attempt < attemptsPerRpc) await sleep(500 * attempt);
  }
  throw new Error(`All RPC endpoints failed for ${method}: ${errors.slice(-rpcs.length).join('; ')}`);
}

export function createRpcClient(options = {}) {
  const baseRpcs = [...(options.rpcs || RPCS)];
  let preferredIndex = 0;
  return async (method, params) => {
    const ordered = baseRpcs.slice(preferredIndex).concat(baseRpcs.slice(0, preferredIndex));
    return rpcWithFallback(method, params, {
      ...options,
      rpcs: ordered,
      onSuccess(endpoint) {
        const nextIndex = baseRpcs.indexOf(endpoint);
        if (nextIndex >= 0) preferredIndex = nextIndex;
        options.onSuccess?.(endpoint);
      },
    });
  };
}

const defaultRpcClient = createRpcClient();

export async function fetchAllSignatures({
  rpcCall = defaultRpcClient,
  wallet = WALLET,
  pageDelayMs = 800,
  maxPages = 100,
} = {}) {
  const all = [];
  let before;
  for (let page = 0; page < maxPages; page += 1) {
    const params = [wallet, { limit: 1000 }];
    if (before) params[1].before = before;
    const sigs = await rpcCall('getSignaturesForAddress', params);
    if (!Array.isArray(sigs)) throw new Error('RPC returned non-array signatures payload');
    if (!sigs.length) break;
    if (sigs.some(row => !row || typeof row.signature !== 'string' || !Number.isFinite(row.blockTime))) {
      throw new Error('RPC returned malformed signature rows');
    }
    all.push(...sigs);
    if (sigs.length < 1000) break;
    before = sigs.at(-1).signature;
    await sleep(pageDelayMs);
  }
  if (all.length >= maxPages * 1000) throw new Error(`Signature pagination exceeded ${maxPages} pages`);
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

export function semanticPulseData(data) {
  if (!data || typeof data !== 'object') return '';
  const { generated: _generated, ...semantic } = data;
  return JSON.stringify(semantic);
}

export function preserveGeneratedWhenUnchanged(nextData, previousData) {
  if (previousData?.generated && semanticPulseData(nextData) === semanticPulseData(previousData)) {
    return { ...nextData, generated: previousData.generated };
  }
  return nextData;
}

function readPreviousOutput() {
  if (!existsSync(OUTPUT_PATH)) return null;
  try { return JSON.parse(readFileSync(OUTPUT_PATH, 'utf8')); } catch { return null; }
}

export async function main() {
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

  let data = {
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

  const minimumTransactions = Number(process.env.PULSE_MIN_TRANSACTIONS || 1000);
  if (signatures.length < minimumTransactions || timeline.length < 1) {
    throw new Error(`Refusing implausible pulse data: transactions=${signatures.length}, timeline=${timeline.length}`);
  }
  data = preserveGeneratedWhenUnchanged(data, readPreviousOutput());

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(data, null, 2));
  console.log(`Wrote ${OUTPUT_PATH}`);
  console.log(`  Timeline: ${timeline.length}, Scriptures: ${scriptures.length}, Encrypted: ${encrypted.length}, Total: ${signatures.length}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
