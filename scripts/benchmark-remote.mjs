/** Alternate two built runtimes against the same public source with fresh caches/processes.
 * Every sample runs the full SHA/mode/API/warm-cache assertions in check-remote-catalog.
 * Example: node scripts/benchmark-remote.mjs --baseline-dist /tmp/beta5/dist --runs 3
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'baseline-dist': { type: 'string' },
  'candidate-dist': { type: 'string', default: fileURLToPath(new URL('../dist/', import.meta.url)) },
  runs: { type: 'string', default: '3' },
  skill: { type: 'string', multiple: true },
  output: { type: 'string' },
} });
const runs = Number(values.runs);
if (!values['baseline-dist'] || !Number.isSafeInteger(runs) || runs < 1 || runs > 20) {
  throw new Error('Usage: node scripts/benchmark-remote.mjs --baseline-dist PATH [--candidate-dist PATH] [--runs 1..20] [--skill NAME] [--output PATH]');
}
const skills = values.skill ?? ['human-writing', 'superpowers'];
const runtimes = { baseline: resolve(values['baseline-dist']), candidate: resolve(values['candidate-dist']) };
function fingerprint(root) {
  const hash = createHash('sha256');
  for (const path of readdirSync(root, { recursive: true }).filter(path => path.endsWith('.js')).sort()) {
    hash.update(path).update('\0').update(readFileSync(join(root, path))).update('\0');
  }
  return hash.digest('hex');
}
const fingerprints = Object.fromEntries(Object.entries(runtimes).map(([variant, root]) => [variant, fingerprint(root)]));
const smoke = fileURLToPath(new URL('./check-remote-catalog.mjs', import.meta.url));
function sample(runtime, name) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [smoke, '--runtime-dir', runtime, '--skill', name], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: 300_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-16_384); });
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) { reject(new Error(`Smoke exited ${code}: ${stderr}`)); return; }
      try { accept(JSON.parse(stdout)); } catch (error) { reject(error); }
    });
  });
}
const samples = [];
for (let round = 0; round < runs; round++) {
  for (const skill of skills) {
    // AB / BA order reduces systematic connection/CDN warmup bias. The network
    // still varies; this is a small experiment, not a latency guarantee.
    for (const variant of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      console.error(`round ${round + 1}/${runs}: ${variant} ${skill}`);
      const result = await sample(runtimes[variant], skill);
      if (fingerprint(runtimes[variant]) !== fingerprints[variant]) throw new Error('Runtime changed during benchmark: ' + variant);
      samples.push({ round: round + 1, variant, manifestMs: result.manifestMs, ...result.results[0] });
    }
  }
}
const percentile = (numbers, fraction) => [...numbers].sort((a, b) => a - b)[Math.max(0, Math.ceil(numbers.length * fraction) - 1)];
const summary = skills.flatMap(name => Object.keys(runtimes).map(variant => {
  const selected = samples.filter(item => item.name === name && item.variant === variant);
  return { name, variant, samples: selected.length,
    coldP50Ms: percentile(selected.map(item => item.coldMs), .5),
    coldMaxMs: Math.max(...selected.map(item => item.coldMs)),
    manifestP50Ms: percentile(selected.map(item => item.manifestMs), .5),
    manifestPlusColdP50Ms: percentile(selected.map(item => item.manifestMs + item.coldMs), .5),
    requestsP50: percentile(selected.map(item => item.networkRequests), .5),
    warmP50Ms: percentile(selected.map(item => item.warmMs), .5) };
}));
const report = JSON.stringify({ measuredAt: new Date().toISOString(), node: process.version,
  platform: `${process.platform}-${process.arch}`, runtimes, fingerprints,
  method: 'Alternating separate processes, isolated disk caches, fully remote manifest/catalog/files; requests include cancelled losers; small sample, no production SLA.',
  summary, samples }, null, 2);
if (values.output) writeFileSync(resolve(values.output), report + '\n');
console.log(report);
