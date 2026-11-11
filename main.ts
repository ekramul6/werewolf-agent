// werewolf-agent-01: a deterministic rule-based Werewolf agent (no model calls).
//
// Loop: read the brief from MAKEFUN_PROMPT_FILE, POST /observe, answer every pending
// decision via POST /act, exit when "done" is true. Every choice is a function of the
// game's own view and MAKEFUN_TRIAL_SEED only: no wall clock, no unseeded randomness,
// no state shared between games (each decision recomputes from the view it was served).
// A refusal (400/409) is retried once with a safe fallback (pass / abstain); a malformed
// view or any error inside one decision falls back the same way, so no game ever stalls.
//
// Strategy in one line per role:
//   werewolf: blend in, vote with the village against a villager, match the partner's
//     night kill (or pick the most dangerous villager), never claim wolf, never vote partner.
//   seer: inspect the most suspicious uninspected seat; hint at a found wolf, claim openly
//     once corroborated or late; vote known wolves first.
//   doctor: protect the seer-claimant or the most trusted living villager; never self, never
//     last night's seat; vote like a villager.
//   villager: vote from a suspicion score built from votes, speeches, deaths and revealed
//     roles; push the top suspect in debate, abstain on day 1 without a strong signal.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

type Seat = number;
type Role = 'werewolf' | 'seer' | 'doctor' | 'villager';
type DecisionKind = 'speak' | 'vote' | 'kill' | 'protect' | 'inspect';

interface LogEntry {
  seq: number;
  day: number;
  kind: string;
  seat?: Seat;
  target?: Seat | null;
  text?: string;
  died?: Seat | null;
  role?: string | null;
  round?: number;
  tally?: { seat: Seat; votes: number }[];
  [k: string]: unknown;
}

interface Player {
  seat: Seat;
  name: string;
  alive: boolean;
  role: Role | null;
}

interface View {
  day: number;
  phase: string;
  you: { seat: Seat; name: string; role: Role; alive: boolean; partner: { seat: Seat; name: string; alive: boolean } | null };
  players: Player[];
  seerResults: { night: number; seat: Seat; werewolf: boolean }[] | null;
  lastProtect: { night: number; seat: Seat } | null;
  wolfVotes: { night: number; seat: Seat; target: Seat | null }[] | null;
  log: LogEntry[];
  outcome: unknown;
  [k: string]: unknown;
}

interface Pending {
  game: number;
  decision: DecisionKind;
  options?: Seat[];
  max_chars?: number;
  view: View;
}

interface Observed {
  games: number;
  finished: number;
  done: boolean;
  pending: Pending[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Fold a statement the env's way: runs of line breaks/tabs become one space, other control chars go. */
export function foldStatement(text: string): string {
  return text
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]+/g, ' ')
    .replace(/\p{Cc}/gu, '')
    .trim();
}

export function cutTo(text: string, max: number): string {
  const chars = [...foldStatement(text)];
  return chars.length > max ? chars.slice(0, max).join('').trim() : chars.join('');
}

/** Seeded PRNG (mulberry32) from sha256(seed + label): the same seed and label give the same stream. */
export function seededRng(seed: string, label: string): () => number {
  const h = createHash('sha256').update(seed, 'utf8').update('\0', 'utf8').update(label, 'utf8').digest();
  let a = h.readUInt32LE(0) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, items: readonly T[]): T => items[Math.floor(rng() * items.length)] as T;

// ---------------------------------------------------------------- analysis

interface Analysis {
  suspicion: Map<Seat, number>;
  knownWolves: Set<Seat>;
  knownVillage: Set<Seat>;
  speechCount: Map<Seat, number>;
  /** seat -> { target, result } for every "I am the seer, I checked seat X" claim in the log. */
  seerClaims: Map<Seat, { target: Seat; result: 'werewolf' | 'villager' }>;
  /** Seats that accused a seat that later died at night. */
  nightVictims: Set<Seat>;
}

const ACCUSE = /\b(wolf|werewolf|suspicious|suspect|guilty|lying|liar|vote (him|her|them|out)|exile|doesn'?t add up|story changed|deflect)/i;
const DEFEND = /\b(trust|honest|innocent|clear|believe (him|her|them)|villager|not a wolf|on our side)\b/i;

function seatMentions(text: string): Seat[] {
  const out: Seat[] = [];
  for (const m of text.matchAll(/seat\s+(\d+)/gi)) {
    const s = Number(m[1]);
    if (s >= 1 && s <= 8 && !out.includes(s)) out.push(s);
  }
  return out;
}

/**
 * Suspicion from one game's public log alone. Revealed roles anchor everything: a vote or a
 * defence of a revealed wolf counts against the voter, a vote or an accusation of one counts
 * for them. Seer claims are scored against what is already known (a claim contradicted by a
 * revealed role is a lie). Nothing here reads another game.
 */
export function analyze(view: View): Analysis {
  const suspicion = new Map<Seat, number>();
  const knownWolves = new Set<Seat>();
  const knownVillage = new Set<Seat>();
  const speechCount = new Map<Seat, number>();
  const seerClaims = new Map<Seat, { target: Seat; result: 'werewolf' | 'villager' }>();
  const nightVictims = new Set<Seat>();
  const bump = (seat: Seat, n: number): void => suspicion.set(seat, (suspicion.get(seat) ?? 0) + n);

  for (const p of view.players ?? []) {
    if (p.role === 'werewolf') knownWolves.add(p.seat);
    else if (p.role !== null) knownVillage.add(p.seat);
  }
  if (view.you?.partner) knownWolves.add(view.you.partner.seat);
  for (const r of view.seerResults ?? []) {
    if (r.werewolf) knownWolves.add(r.seat);
    else knownVillage.add(r.seat);
  }

  const log = view.log ?? [];
  // Day-by-day votes, for pack-vote detection.
  const votesByDay = new Map<number, { seat: Seat; target: Seat | null }[]>();
  for (const e of log) {
    if (e.kind === 'speech' && typeof e.seat === 'number' && typeof e.text === 'string') {
      speechCount.set(e.seat, (speechCount.get(e.seat) ?? 0) + 1);
      const low = e.text.toLowerCase();
      const claim = /i'?m the seer|i am the seer/.test(low);
      for (const target of seatMentions(e.text)) {
        if (claim && /(checked|inspected|looked at)/.test(low)) {
          const result = /\bwerewolf\b/.test(low) ? 'werewolf' : /\b(villager|not a wolf|innocent)\b/.test(low) ? 'villager' : null;
          if (result) seerClaims.set(e.seat, { target, result });
        }
        if (ACCUSE.test(low)) {
          if (knownWolves.has(target)) bump(e.seat, -2);
          else if (knownVillage.has(target)) bump(e.seat, +1);
        } else if (DEFEND.test(low)) {
          if (knownWolves.has(target)) bump(e.seat, +2);
          else if (knownVillage.has(target)) bump(e.seat, -1);
        }
      }
    } else if (e.kind === 'vote' && typeof e.seat === 'number') {
      const dayVotes = votesByDay.get(e.day) ?? [];
      dayVotes.push({ seat: e.seat, target: e.target ?? null });
      votesByDay.set(e.day, dayVotes);
      if (typeof e.target === 'number') {
        if (knownWolves.has(e.target)) bump(e.seat, -3);
        else if (knownVillage.has(e.target)) bump(e.seat, +2);
      }
    } else if (e.kind === 'dawn' && typeof e.died === 'number') {
      nightVictims.add(e.died);
      // Who pushed the night's victim during the previous day's debate?
      for (const s of log) {
        if (s.kind === 'speech' && s.day === e.day - 1 && typeof s.text === 'string' && seatMentions(s.text).includes(e.died as Seat) && ACCUSE.test(s.text.toLowerCase())) {
          bump(s.seat as Seat, +1);
        }
      }
    }
  }
  // Pack voting: voting the same target as a revealed wolf, in the same day.
  for (const dayVotes of votesByDay.values()) {
    const wolfTargets = new Set(dayVotes.filter((v) => knownWolves.has(v.seat) && v.target !== null).map((v) => v.target as Seat));
    for (const v of dayVotes) {
      if (!knownWolves.has(v.seat) && v.target !== null && wolfTargets.has(v.target)) bump(v.seat, +0.5);
    }
  }
  // A living seat that has never spoken by day 2+ is hiding.
  if (view.day >= 2) {
    for (const p of view.players ?? []) {
      if (p.alive && p.seat !== view.you?.seat && (speechCount.get(p.seat) ?? 0) === 0) bump(p.seat, +1);
    }
  }
  // A seer claim contradicted by a revealed role is a lie; one confirmed by a revealed role is gold.
  for (const [claimer, claim] of seerClaims) {
    if (claim.result === 'werewolf' && knownVillage.has(claim.target)) bump(claimer, +6);
    else if (claim.result === 'villager' && knownWolves.has(claim.target)) bump(claimer, +6);
    else if (claim.result === 'werewolf' && knownWolves.has(claim.target)) bump(claimer, -4);
    else if (claim.result === 'villager' && knownVillage.has(claim.target)) bump(claimer, -2);
    else bump(claimer, +0.5); // an unverified seer claim is cheap talk
  }
  return { suspicion, knownWolves, knownVillage, speechCount, seerClaims, nightVictims };
}

const living = (view: View): Player[] => (view.players ?? []).filter((p) => p.alive);
const scoreOf = (a: Analysis, seat: Seat): number => a.suspicion.get(seat) ?? 0;

/** Highest-suspicion living seat among `cands`, ties broken by the seeded order (lowest seat first). */
function topSuspect(a: Analysis, cands: Seat[]): Seat | null {
  let best: Seat | null = null;
  let bestScore = -Infinity;
  for (const s of [...cands].sort((x, y) => x - y)) {
    const sc = scoreOf(a, s);
    if (sc > bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  return best;
}

/** The seat the village currently trusts most (lowest suspicion, alive, not me): a doctor's protect pick. */
function mostTrusted(a: Analysis, view: View): Seat | null {
  const cands = living(view).map((p) => p.seat).filter((s) => s !== view.you.seat && !a.knownWolves.has(s));
  if (cands.length === 0) return null;
  let best: Seat | null = null;
  let bestScore = Infinity;
  for (const s of [...cands].sort((x, y) => x - y)) {
    const sc = scoreOf(a, s);
    if (sc < bestScore) {
      bestScore = sc;
      best = s;
    }
  }
  return best;
}

// ---------------------------------------------------------------- decisions

function fallbackFor(p: Pick<Pending, 'game' | 'decision'>): Record<string, unknown> {
  return p.decision === 'speak' ? { game: p.game, decision: 'speak', pass: true } : { game: p.game, decision: p.decision, target: null };
}

function validTarget(p: Pending, target: Seat | null): Seat | null {
  return target !== null && (p.options ?? []).includes(target) ? target : null;
}

/** A werewolf's night kill: match the partner's vote when they voted first, else the most dangerous villager. */
function decideKill(p: Pending, a: Analysis, rng: () => number): Record<string, unknown> {
  const view = p.view;
  const options = (p.options ?? []).filter((s) => s !== view.you.seat);
  if (options.length === 0) return { game: p.game, decision: 'kill', target: null };
  const partnerSeat = view.you.partner?.seat;
  const tonight = (view.wolfVotes ?? []).filter((v) => v.night === view.day);
  const partnerVote = partnerSeat !== undefined ? tonight.find((v) => v.seat === partnerSeat) : undefined;
  if (partnerVote && partnerVote.target !== null && options.includes(partnerVote.target)) {
    return { game: p.game, decision: 'kill', target: partnerVote.target };
  }
  // Most dangerous villager first: a seer-claimant, then anyone who accused a revealed wolf,
  // then the loudest speaker; ties by seeded order.
  const claimants = [...a.seerClaims.keys()].filter((s) => options.includes(s) && s !== partnerSeat);
  if (claimants.length > 0) return { game: p.game, decision: 'kill', target: pick(rng, claimants) };
  const accusers = new Set<Seat>();
  for (const e of view.log ?? []) {
    if (e.kind === 'speech' && typeof e.seat === 'number' && typeof e.text === 'string' && a.knownWolves.has(e.seat) === false) {
      for (const t of seatMentions(e.text)) if (a.knownWolves.has(t)) accusers.add(e.seat);
    }
  }
  const dangerous = [...accusers].filter((s) => options.includes(s));
  if (dangerous.length > 0) return { game: p.game, decision: 'kill', target: pick(rng, dangerous) };
  const bySpeech = [...options].sort((x, y) => (a.speechCount.get(y) ?? 0) - (a.speechCount.get(x) ?? 0) || x - y);
  return { game: p.game, decision: 'kill', target: bySpeech[0] as Seat };
}

/** The doctor's protection: the seer-claimant first, else the most trusted living villager. */
function decideProtect(p: Pending, a: Analysis, rng: () => number): Record<string, unknown> {
  const view = p.view;
  const last = view.lastProtect?.seat;
  const options = (p.options ?? []).filter((s) => s !== view.you.seat && s !== last);
  if (options.length === 0) return { game: p.game, decision: 'protect', target: null };
  // A claimant whose result was confirmed by a revealed role is the real seer: guard them.
  const confirmed = [...a.seerClaims.entries()]
    .filter(([claimer, claim]) => options.includes(claimer) && ((claim.result === 'werewolf' && a.knownWolves.has(claim.target)) || (claim.result === 'villager' && a.knownVillage.has(claim.target))))
    .map(([claimer]) => claimer);
  if (confirmed.length > 0) return { game: p.game, decision: 'protect', target: pick(rng, confirmed) };
  const claimants = [...a.seerClaims.keys()].filter((s) => options.includes(s));
  if (claimants.length > 0) return { game: p.game, decision: 'protect', target: pick(rng, claimants) };
  const trusted = mostTrusted(a, view);
  if (trusted !== null && options.includes(trusted)) return { game: p.game, decision: 'protect', target: trusted };
  return { game: p.game, decision: 'protect', target: pick(rng, options) };
}

/** The seer's inspection: the most suspicious living seat not yet inspected (night 1: seeded pick). */
function decideInspect(p: Pending, a: Analysis, rng: () => number): Record<string, unknown> {
  const view = p.view;
  const options = (p.options ?? []).filter((s) => s !== view.you.seat);
  if (options.length === 0) return { game: p.game, decision: 'inspect', target: null };
  const inspected = new Set((view.seerResults ?? []).map((r) => r.seat));
  const fresh = options.filter((s) => !inspected.has(s));
  const pool = fresh.length > 0 ? fresh : options;
  // Highest suspicion first; on night 1 with no signal, the seeded pick.
  if (view.day === 1 && (view.log ?? []).length === 0) return { game: p.game, decision: 'inspect', target: pick(rng, pool) };
  const top = topSuspect(a, pool);
  return { game: p.game, decision: 'inspect', target: top ?? pick(rng, pool) };
}

/** The day vote: a known wolf first, else the top suspect; villagers abstain on day 1 without a strong signal. */
function decideVote(p: Pending, a: Analysis): Record<string, unknown> {
  const view = p.view;
  const role = view.you.role;
  const cands = living(view)
    .map((pl) => pl.seat)
    .filter((s) => s !== view.you.seat && !a.knownVillage.has(s) && (role !== 'werewolf' || !a.knownWolves.has(s)));
  if (cands.length === 0) return { game: p.game, decision: 'vote', target: null };
  const knownAlive = [...a.knownWolves].filter((s) => cands.includes(s) && s !== view.you.seat && (role !== 'werewolf' || s !== view.you.partner?.seat));
  if (knownAlive.length > 0) return { game: p.game, decision: 'vote', target: knownAlive[0] as Seat };
  const top = topSuspect(a, cands);
  if (top === null) return { game: p.game, decision: 'vote', target: null };
  const sc = scoreOf(a, top);
  if (role === 'werewolf') return { game: p.game, decision: 'vote', target: top };
  if (view.day === 1 && sc < 3) return { game: p.game, decision: 'vote', target: null };
  if (sc < 1) return { game: p.game, decision: 'vote', target: null };
  return { game: p.game, decision: 'vote', target: top };
}

function nameOf(view: View, seat: Seat): string {
  return view.players?.find((pl) => pl.seat === seat)?.name ?? `seat ${seat}`;
}

/** One debate statement for the role and the situation, or null to pass. */
function decideSpeak(p: Pending, a: Analysis, rng: () => number): Record<string, unknown> {
  const view = p.view;
  const role = view.you.role;
  const max = p.max_chars ?? 500;
  const mySeat = view.you.seat;
  const cands = living(view)
    .map((pl) => pl.seat)
    .filter((s) => s !== mySeat && !a.knownVillage.has(s) && (role !== 'werewolf' || !a.knownWolves.has(s)));
  const top = cands.length > 0 ? topSuspect(a, cands) : null;
  const knownAlive = [...a.knownWolves].filter((s) => s !== mySeat && living(view).some((pl) => pl.seat === s) && (role !== 'werewolf' || s !== view.you.partner?.seat));
  const round = (view.log ?? []).filter((e) => e.kind === 'speech' || e.kind === 'pass').length;

  // The seer claims openly once corroborated (someone else already suspects the wolf), late,
  // or when the village is nearly out of seats; before that it only hints.
  if (role === 'seer' && knownAlive.length > 0) {
    const wolf = knownAlive[0] as Seat;
    // Corroborated when another living seat already accused the wolf in speech, or voted
    // for them on an earlier day: the village is already looking their way, so claiming is safe.
    const corroborated = (view.log ?? []).some(
      (e) =>
        e.seat !== mySeat &&
        ((e.kind === 'speech' && typeof e.text === 'string' && seatMentions(e.text).includes(wolf) && ACCUSE.test(e.text.toLowerCase())) ||
          (e.kind === 'vote' && e.day < view.day && e.target === wolf)),
    );
    const livingCount = living(view).length;
    if (corroborated || view.day >= 3 || livingCount <= 5) {
      return { game: p.game, decision: 'speak', text: cutTo(`I'm the seer. I checked seat ${wolf} (${nameOf(view, wolf)}) last night — werewolf. Vote seat ${wolf}.`, max) };
    }
    return { game: p.game, decision: 'speak', text: cutTo(`Seat ${wolf}'s story doesn't add up to me. Watch how they deflect whenever they're asked a direct question.`, max) };
  }
  // A seer who cleared someone defends them, lightly, without claiming.
  if (role === 'seer') {
    const cleared = [...a.knownVillage].filter((s) => s !== mySeat && living(view).some((pl) => pl.seat === s));
    if (cleared.length > 0 && rng() < 0.5) {
      const s = pick(rng, cleared);
      return { game: p.game, decision: 'speak', text: cutTo(`Seat ${s} reads honest to me. I'd look elsewhere before voting them.`, max) };
    }
  }
  // The wolf blends in: agree with the village's top suspect, never the partner, never a wolf claim.
  if (role === 'werewolf' && top !== null) {
    const lines = [
      `Seat ${top} keeps deflecting whenever they're asked directly. Worth a closer look.`,
      `I was watching seat ${top} too — they went quiet when the pressure turned to them.`,
      `Seat ${top}'s vote yesterday felt off to me. I'm leaning that way today.`,
      `Nothing solid yet, but seat ${top} is the one I keep coming back to.`,
    ];
    return { game: p.game, decision: 'speak', text: cutTo(pick(rng, lines), max) };
  }
  // Village roles push the top suspect with the evidence the log gives.
  if (top !== null) {
    const sc = scoreOf(a, top);
    if (sc >= 2) {
      const lines = [
        `Seat ${top} voted for a villager and hasn't explained it. That's where my vote goes.`,
        `Seat ${top}'s story changed between rounds. I don't buy it.`,
        `Look at who pushed the last victim before they died — seat ${top} was loudest.`,
        `Seat ${top} has been too careful with their words. I don't trust them.`,
      ];
      return { game: p.game, decision: 'speak', text: cutTo(pick(rng, lines), max) };
    }
    if (round === 0) {
      return { game: p.game, decision: 'speak', text: cutTo(`Still working through it. Seat ${top} is the one I'm watching closest right now.`, max) };
    }
  }
  // Nothing worth saying: pass (second round, or no signal at all).
  return { game: p.game, decision: 'speak', pass: true };
}

/** The /act body for one pending decision, from that game's view alone. */
export function decide(p: Pending, seed: string): Record<string, unknown> {
  const view = p.view ?? {};
  if (!isRecord(view) || !isRecord(view.you) || typeof view.you.role !== 'string') return fallbackFor(p);
  const rng = seededRng(seed, `game-${p.game}:${p.decision}:${(view.log ?? []).length}`);
  let a: Analysis;
  try {
    a = analyze(view as View);
  } catch {
    return fallbackFor(p);
  }
  try {
    switch (p.decision) {
      case 'kill':
        return decideKill(p, a, rng);
      case 'protect':
        return decideProtect(p, a, rng);
      case 'inspect':
        return decideInspect(p, a, rng);
      case 'vote':
        return decideVote(p, a);
      case 'speak':
        return decideSpeak(p, a, rng);
      default:
        return fallbackFor(p);
    }
  } catch {
    return fallbackFor(p);
  }
}

// ---------------------------------------------------------------- run loop

export interface RunOptions {
  envUrl?: string;
  brief?: string;
  log?: (line: string) => void;
}

export async function run(o: RunOptions = {}): Promise<{ decisions: number }> {
  const env = process.env;
  const envUrl = (o.envUrl ?? env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (envUrl === '') throw new Error('MAKEFUN_ENV_URL is needed');
  if (o.brief === undefined) {
    const file = env.MAKEFUN_PROMPT_FILE ?? '';
    if (file === '') throw new Error('MAKEFUN_PROMPT_FILE is needed');
    o.brief = readFileSync(file, 'utf8'); // the brief: read, not parsed for play
  }
  const seed = env.MAKEFUN_TRIAL_SEED ?? 'werewolf-agent-01';
  const log = o.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  let decisions = 0;

  const envPost = async (path: string, body: unknown): Promise<{ status: number; body: unknown }> => {
    const res = await fetch(`${envUrl}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status, body: parsed };
  };

  // A decision is known by its game, its kind and how far its game's log has come: the same
  // decision is listed again on every /observe until answered, and never answered twice.
  const keyOf = (p: Pending): string => `${p.game}:${p.decision}:${((p.view as View | undefined)?.log ?? []).length}`;
  const answered = new Set<string>();

  for (;;) {
    let obs: Observed;
    try {
      const r = await envPost('/observe', {});
      if (r.status !== 200 || !isRecord(r.body)) throw new Error(`POST /observe answered ${r.status}`);
      obs = r.body as unknown as Observed;
    } catch (err) {
      // The env gone: wait briefly and try again, a few times, then give up.
      await sleep(1000);
      try {
        const r = await envPost('/observe', {});
        if (r.status !== 200 || !isRecord(r.body)) throw err;
        obs = r.body as unknown as Observed;
      } catch {
        throw err;
      }
    }
    if (obs.done) break;
    for (const p of obs.pending ?? []) {
      const key = keyOf(p);
      if (answered.has(key)) continue;
      answered.add(key);
      let act: Record<string, unknown>;
      try {
        act = decide(p, seed);
      } catch {
        act = fallbackFor(p);
      }
      decisions += 1;
      let posted = await envPost('/act', act);
      if (posted.status === 409) continue; // already answered / moved on: nothing to redo
      if (posted.status === 400 && JSON.stringify(act) !== JSON.stringify(fallbackFor(p))) {
        posted = await envPost('/act', fallbackFor(p)); // refused: retry with the safe fallback
      }
      if (posted.status !== 200 && posted.status !== 409) {
        // One last try with the fallback, then move on rather than stall the game.
        await envPost('/act', fallbackFor(p));
      }
    }
    // When nothing was pending, /observe held the request open itself; loop straight on.
  }
  log(`werewolf-bot: ${decisions} decisions answered, trial done`);
  return { decisions };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    await run();
    process.exitCode = 0;
  } catch (err) {
    process.stderr.write(`werewolf-bot: ${(err as Error).stack ?? String(err)}\n`);
    process.exitCode = 1;
  }
}
