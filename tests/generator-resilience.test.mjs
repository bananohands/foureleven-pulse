import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  createRpcClient,
  fetchAllSignatures,
  parseRpcUrls,
  preserveGeneratedWhenUnchanged,
  rpcWithFallback,
} from '../generate-pulse-data.mjs';

const generator = readFileSync(new URL('../generate-pulse-data.mjs', import.meta.url), 'utf8');
const workflow = readFileSync(new URL('../.github/workflows/update-pulse.yml', import.meta.url), 'utf8');

test('pulse generator exposes bounded multi-RPC fallback instead of one official endpoint', () => {
  assert.match(generator, /export const DEFAULT_RPCS/);
  assert.match(generator, /export function parseRpcUrls/);
  assert.match(generator, /export async function rpcWithFallback/);
  assert.match(generator, /export function createRpcClient/);
  assert.match(generator, /solana-rpc\.publicnode\.com/);
  assert.match(generator, /public\.rpc\.solanavibestation\.com/);
  assert.doesNotMatch(generator, /const RPC = 'https:\/\/api\.mainnet-beta\.solana\.com'/);
});

test('pulse generator preserves generated timestamp when semantic chain data is unchanged', () => {
  assert.match(generator, /export function preserveGeneratedWhenUnchanged/);
  assert.match(generator, /semanticPulseData/);
});

test('GitHub pulse refresh runs every four hours, not every thirty minutes', () => {
  assert.match(workflow, /cron:\s*['"]47 \*\/4 \* \* \*['"]/);
  assert.doesNotMatch(workflow, /\*\/30 \* \* \* \*/);
});

test('RPC fallback leaves a rate-limited endpoint and returns the next valid result', async () => {
  const calls = [];
  const result = await rpcWithFallback('getSignaturesForAddress', ['wallet', { limit: 1 }], {
    rpcs: ['https://limited.example', 'https://healthy.example'],
    attemptsPerRpc: 1,
    minimumFirstPage: 0,
    logger: { warn() {} },
    fetchImpl: async endpoint => {
      calls.push(endpoint);
      return endpoint.includes('limited')
        ? { ok: true, json: async () => ({ error: { code: 429, message: 'Too many requests' } }) }
        : { ok: true, json: async () => ({ result: [{ signature: 'abc', blockTime: 1 }] }) };
    },
  });
  assert.deepEqual(calls, ['https://limited.example', 'https://healthy.example']);
  assert.equal(result[0].signature, 'abc');
});

test('RPC fallback rejects an implausibly short first history page', async () => {
  const calls = [];
  const result = await rpcWithFallback('getSignaturesForAddress', ['wallet', { limit: 1000 }], {
    rpcs: ['https://short.example', 'https://complete.example'],
    attemptsPerRpc: 1,
    minimumFirstPage: 1000,
    logger: { warn() {} },
    fetchImpl: async endpoint => {
      calls.push(endpoint);
      const count = endpoint.includes('short') ? 9 : 1000;
      return { ok: true, json: async () => ({ result: Array.from({ length: count }, (_, index) => ({ signature: `sig-${index}`, blockTime: index + 1 })) }) };
    },
  });
  assert.deepEqual(calls, ['https://short.example', 'https://complete.example']);
  assert.equal(result.length, 1000);
});

test('sticky RPC client prefers the archival endpoint after first success', async () => {
  const calls = [];
  const client = createRpcClient({
    rpcs: ['https://short.example', 'https://complete.example'],
    attemptsPerRpc: 1,
    minimumFirstPage: 1000,
    logger: { warn() {} },
    fetchImpl: async (endpoint, options) => {
      calls.push(endpoint);
      const request = JSON.parse(options.body);
      const paginated = Boolean(request.params?.[1]?.before);
      const count = paginated ? 5 : (endpoint.includes('short') ? 9 : 1000);
      return { ok: true, json: async () => ({ result: Array.from({ length: count }, (_, index) => ({ signature: `sig-${index}`, blockTime: index + 1 })) }) };
    },
  });
  await client('getSignaturesForAddress', ['wallet', { limit: 1000 }]);
  await client('getSignaturesForAddress', ['wallet', { limit: 1000, before: 'sig-999' }]);
  assert.deepEqual(calls, ['https://short.example', 'https://complete.example', 'https://complete.example']);
});

test('configured RPCs override defaults and malformed signature rows fail closed', async () => {
  assert.deepEqual(parseRpcUrls({ SOLANA_RPC_URLS: 'https://one.example, https://two.example' }), ['https://one.example', 'https://two.example']);
  await assert.rejects(
    fetchAllSignatures({ rpcCall: async () => [{ nope: true }], pageDelayMs: 0 }),
    /malformed signature rows/,
  );
});

test('unchanged semantic pulse data keeps its prior generated timestamp', () => {
  const prior = { generated: 'old', totalTxs: 5, timeline: [{ sig: 'x' }] };
  const next = { generated: 'new', totalTxs: 5, timeline: [{ sig: 'x' }] };
  assert.equal(preserveGeneratedWhenUnchanged(next, prior).generated, 'old');
  assert.equal(preserveGeneratedWhenUnchanged({ ...next, totalTxs: 6 }, prior).generated, 'new');
});
