// Periodic balance + pace eval. Plays bot-vs-bot matches headless and checks the numbers
// that define the game against frozen thresholds:
//   fairness : warrior vs mage win rate stays inside 35-65% at equal bot skill
//   pace     : rounds last 12-60s (Battlerite-like, not a slog, not a coin flip)
//   frenzy   : each player casts >= 40 abilities per minute
//   skill    : a hard bot beats an easy bot >= 70% of matches (the game rewards play)
// Usage: node evals/balance.mjs [matchesPerPairing=40]
import { writeFileSync, mkdirSync } from 'node:fs';
import { createMatch, step, constants as C } from '../services/sim/index.js';
import { createBot } from '../services/ai/bot.js';

const N = Number(process.argv[2]) || 40;
const MAX_TICKS = C.TICK_RATE * 60 * 8;

function playMatch(classes, diffs, seed) {
  const s = createMatch({ classes, seed });
  const bots = [createBot({ difficulty: diffs[0], seed: seed * 2 + 1 }), createBot({ difficulty: diffs[1], seed: seed * 2 + 2 })];
  while (s.phase !== 'matchEnd' && s.tick < MAX_TICKS) {
    step(s, [bots[0].think(s, 0), bots[1].think(s, 1)]);
  }
  const fightSeconds = s.rounds.reduce((a, r) => a + r.duration, 0);
  return {
    winner: s.winner,
    rounds: s.rounds,
    castsPerMin: s.players.map((p) => (p.stats.casts / Math.max(1, fightSeconds)) * 60),
    timedOut: s.phase !== 'matchEnd',
  };
}

function pairing(label, classes, diffs, seedBase) {
  const res = { label, matches: 0, wins: [0, 0], rounds: [], cpm: [], timeouts: 0 };
  for (let i = 0; i < N; i++) {
    // Alternate sides so spawn position never biases the result.
    const swap = i % 2 === 1;
    const cls = swap ? [classes[1], classes[0]] : classes;
    const df = swap ? [diffs[1], diffs[0]] : diffs;
    const m = playMatch(cls, df, seedBase + i);
    res.matches += 1;
    if (m.timedOut) res.timeouts += 1;
    if (m.winner >= 0) res.wins[swap ? 1 - m.winner : m.winner] += 1;
    res.rounds.push(...m.rounds.map((r) => r.duration));
    res.cpm.push(...m.castsPerMin);
  }
  return res;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) * q)] ?? 0; };

const t0 = Date.now();
const wm = pairing('warrior vs mage (normal)', ['warrior', 'mage'], ['normal', 'normal'], 1000);
const ww = pairing('warrior mirror (normal)', ['warrior', 'warrior'], ['normal', 'normal'], 2000);
const mm = pairing('mage mirror (normal)', ['mage', 'mage'], ['normal', 'normal'], 3000);
const skillW = pairing('hard vs easy (warrior vs mage)', ['warrior', 'mage'], ['hard', 'easy'], 4000);
const skillM = pairing('hard vs easy (mage vs warrior)', ['mage', 'warrior'], ['hard', 'easy'], 5000);

const allRounds = [...wm.rounds, ...ww.rounds, ...mm.rounds];
const allCpm = [...wm.cpm, ...ww.cpm, ...mm.cpm];
const mageRate = wm.wins[1] / Math.max(1, wm.wins[0] + wm.wins[1]);
const hardRate = (skillW.wins[0] + skillM.wins[0]) / Math.max(1, skillW.matches + skillM.matches);

const checks = [
  { name: 'fairness: mage win rate vs warrior', value: mageRate, lo: 0.35, hi: 0.65 },
  { name: 'pace: mean round seconds', value: mean(allRounds), lo: 12, hi: 60 },
  { name: 'pace: p90 round seconds', value: pct(allRounds, 0.9), lo: 0, hi: 80 },
  { name: 'frenzy: casts per minute per player', value: mean(allCpm), lo: 40, hi: Infinity },
  { name: 'skill: hard bot match win rate vs easy', value: hardRate, lo: 0.7, hi: 1 },
  { name: 'health: matches that timed out', value: wm.timeouts + ww.timeouts + mm.timeouts, lo: 0, hi: 0 },
];

const report = {
  when: new Date().toISOString(),
  matchesPerPairing: N,
  seconds: (Date.now() - t0) / 1000,
  pairings: [wm, ww, mm, skillW, skillM].map((p) => ({
    label: p.label, matches: p.matches, wins: p.wins, meanRound: +mean(p.rounds).toFixed(1), meanCpm: +mean(p.cpm).toFixed(1),
  })),
  checks: checks.map((c) => ({ ...c, value: +c.value.toFixed(3), pass: c.value >= c.lo && c.value <= c.hi })),
};

for (const p of report.pairings) console.log(`${p.label.padEnd(34)} wins ${p.wins.join('-').padEnd(7)} round ${p.meanRound}s  cpm ${p.meanCpm}`);
console.log('');
for (const c of report.checks) console.log(`${c.pass ? 'PASS' : 'FAIL'}  ${c.name.padEnd(42)} ${c.value}  [${c.lo}, ${c.hi}]`);
mkdirSync(new URL('./results/', import.meta.url), { recursive: true });
writeFileSync(new URL('./results/balance-latest.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(`\n${report.seconds}s, report: evals/results/balance-latest.json`);
process.exit(report.checks.every((c) => c.pass) ? 0 : 1);
