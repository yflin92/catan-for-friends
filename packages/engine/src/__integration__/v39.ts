// V39 conformance (verification plan V39): engine steps checked against the phase and action relation of the TLA+ model
// docs/tla/CatanCore.tla. abstractState maps a GameState onto the model's control variables; v39StepIssues checks that
// one accepted command moves them as the corresponding model action allows; v39StateIssues checks the model's state
// invariants. Test-only.
//
// Abstraction (as in docs/tla/README.md): no board geometry, hands and bank are not compared (the model's builds cost
// one of each resource), and Largest Army is not modelled, so a Knight that wins the game is accepted when the winner
// assertion holds. Engine commands that resolve several model steps at once are checked against the composition:
// - playRoadBuilding with no legal free edge = PlayRoadBuilding ∘ EndRoadBuilding;
// - a free road after which no legal edge remains = PlaceFreeRoad ∘ EndRoadBuilding;
// - proposeTrade over an open offer = CloseOffer ∘ OpenOffer.
// Year of Plenty, Monopoly and trade responses have no CatanCore action; they must leave the control variables alone
// apart from devPlayed.
import type { Command, GameEvent } from '../events';
import type { Seat } from '../ids';
import type { GameState, PhaseName } from '../state';
import { RESOURCES } from '../state';
import { victoryPoints } from '../victory';

/** The CatanCore control variables of a state. */
export interface AbstractState {
  readonly phase: PhaseName;
  readonly active: Seat;
  /** Setup phases only: the index into the snake order 0..2N-1. */
  readonly setupIdx: number | null;
  readonly owed: readonly number[];
  /** Discard phase only. */
  readonly thenPhase: 'moveRobber' | 'autoRobberThenEnd' | null;
  /** moveRobber and roadBuilding only. */
  readonly returnPhase: 'preRoll' | 'main' | null;
  readonly offerOpen: boolean;
  readonly devPlayed: boolean;
  readonly rbLeft: number;
  readonly roadsLeft: readonly number[];
  readonly robber: string;
  readonly handSizes: readonly number[];
}

export function abstractState(s: GameState): AbstractState {
  const n = s.playerCount;
  const p = s.phase;
  const setupIdx = p.name === 'setupSettlement' || p.name === 'setupRoad' ? (p.round === 1 ? s.turn.active : 2 * n - 1 - s.turn.active) : null;
  return {
    phase: p.name,
    active: s.turn.active,
    setupIdx,
    owed: p.name === 'discard' ? s.players.map((_, i) => p.owed[i] ?? 0) : s.players.map(() => 0),
    thenPhase: p.name === 'discard' ? p.then : null,
    returnPhase: p.name === 'moveRobber' || p.name === 'roadBuilding' ? p.resume : null,
    offerOpen: s.trade !== null,
    devPlayed: s.turn.devPlayed,
    rbLeft: p.name === 'roadBuilding' ? p.remaining : 0,
    roadsLeft: s.players.map((pl) => pl.supply.roads),
    robber: s.robber,
    handSizes: s.players.map((pl) => RESOURCES.reduce((t, r) => t + pl.hand[r], 0)),
  };
}

const vp = (s: GameState, seat: Seat): number => victoryPoints(s, seat).total;
const next = (s: GameState, seat: Seat): Seat => ((seat + 1) % s.playerCount) as Seat;
/** BeginTurnPhase(nx): the win check at turn start (§6.2). */
const beginTurnPhase = (post: GameState, nx: Seat): PhaseName => (vp(post, nx) >= post.config.vpTarget ? 'gameOver' : 'preRoll');
/** The model's phase after a step that may win: gameOver iff the active seat reached the target. */
const winOr = (post: GameState, otherwise: PhaseName): PhaseName =>
  vp(post, post.turn.active) >= post.config.vpTarget ? 'gameOver' : otherwise;

/** The model's state invariants (CatanCore: SetupOrder, DiscardIffOwed, OfferOnlyInMain, RoadBuildingConsistent,
 *  WinnerIsActive, NoUnclaimedWin, PieceLimits on roads). */
export function v39StateIssues(s: GameState): readonly string[] {
  const a = abstractState(s);
  const n = s.playerCount;
  const out: string[] = [];
  if (a.setupIdx !== null) {
    const expected = a.setupIdx < n ? a.setupIdx : 2 * n - 1 - a.setupIdx;
    if (a.active !== expected) out.push(`SetupOrder: active ${a.active} at setupIdx ${a.setupIdx}`);
  }
  if ((a.phase === 'discard') !== a.owed.some((o) => o > 0)) out.push(`DiscardIffOwed: phase ${a.phase}, owed ${a.owed.join(',')}`);
  if (a.offerOpen && a.phase !== 'main') out.push(`OfferOnlyInMain: offer open in ${a.phase}`);
  if (a.phase === 'roadBuilding' && a.rbLeft <= 0) out.push('RoadBuildingConsistent: roadBuilding with rbLeft 0');
  if (a.phase === 'gameOver' && vp(s, a.active) < s.config.vpTarget) out.push('WinnerIsActive: gameOver below target');
  const inTurn = a.phase !== 'gameOver' && a.setupIdx === null;
  if (inTurn && vp(s, a.active) >= s.config.vpTarget) out.push(`NoUnclaimedWin: active ${a.active} at target in ${a.phase}`);
  return out;
}

/**
 * Checks one accepted command (pre --cmd--> post) against the CatanCore action it corresponds to. A system skipSeat is
 * checked against SkipSeat ∘ SkipStep* (skipStepIssues) when the command's events are given; without them it is not
 * walked. v39StateIssues checks the state after every command either way.
 */
export function v39StepIssues(pre: GameState, cmd: Command, post: GameState, events?: readonly GameEvent[]): readonly string[] {
  if (cmd.by === 'system') return events === undefined ? [] : skipLoopIssues(pre, cmd.action.seat, post, events);
  const a = abstractState(pre);
  const b = abstractState(post);
  const by = cmd.by;
  const out: string[] = [];
  const expect = (what: string, ok: boolean) => {
    if (!ok) out.push(`${cmd.action.type} in ${a.phase}: ${what}`);
  };
  const same = (...keys: (keyof AbstractState)[]) => {
    for (const k of keys) expect(`${k} unchanged (${JSON.stringify(a[k])} → ${JSON.stringify(b[k])})`, JSON.stringify(a[k]) === JSON.stringify(b[k]));
  };
  const n = pre.playerCount;
  const action = cmd.action;

  // OnlyEligibleSeatsAct: the active seat, a seat owing a discard, or (respondTrade) a non-active addressee.
  const eligible = by === a.active || (a.phase === 'discard' && (a.owed[by] ?? 0) > 0) || action.type === 'respondTrade';
  expect(`seat ${by} is eligible`, eligible);

  switch (action.type) {
    case 'placeSettlement':
      if (a.phase === 'setupSettlement') {
        // SetupSettlement
        expect('phase → setupRoad', b.phase === 'setupRoad');
        same('active', 'setupIdx', 'offerOpen', 'devPlayed', 'robber');
        return out;
      }
      break;
    case 'placeRoad':
      if (a.phase === 'setupRoad') {
        // SetupRoad
        const idx = a.setupIdx!;
        if (idx === 2 * n - 1) {
          expect('active → 0', b.active === 0);
          expect('phase → BeginTurnPhase(0)', b.phase === beginTurnPhase(post, 0));
        } else {
          const nx = idx + 1 < n ? idx + 1 : 2 * n - 1 - (idx + 1);
          expect(`active → SetupSeat(${idx + 1})`, b.active === nx);
          expect('phase → setupSettlement', b.phase === 'setupSettlement');
          expect('setupIdx + 1', b.setupIdx === idx + 1);
        }
        same('offerOpen', 'devPlayed', 'robber', 'handSizes');
        return out;
      }
      if (a.phase === 'roadBuilding') {
        // PlaceFreeRoad (∘ EndRoadBuilding when no legal edge remains)
        const left = a.rbLeft - 1;
        expect('one road from supply', b.roadsLeft[by] === a.roadsLeft[by]! - 1);
        const resume = a.returnPhase!;
        const ok =
          b.phase === 'gameOver'
            ? vp(post, by) >= post.config.vpTarget
            : b.phase === resume || (b.phase === 'roadBuilding' && left > 0 && b.rbLeft === left && b.returnPhase === resume);
        expect(`phase → gameOver | ${resume} | roadBuilding(${left})`, ok);
        if (b.phase !== 'gameOver') expect('no win missed', winOr(post, b.phase) === b.phase);
        same('active', 'offerOpen', 'devPlayed', 'robber', 'handSizes');
        return out;
      }
      break;
    case 'rollDice': {
      // RollDice
      const dice = post.turn.dice;
      expect('dice recorded', dice !== null);
      const seven = dice !== null && dice[0] + dice[1] === 7;
      if (seven) {
        const owed = a.handSizes.map((h) => (h > pre.config.discardLimit ? Math.floor(h / 2) : 0));
        const any = owed.some((o) => o > 0);
        expect(`phase → ${any ? 'discard' : 'moveRobber'}`, b.phase === (any ? 'discard' : 'moveRobber'));
        if (any) {
          expect(`owed = SevenOwed (${owed.join(',')})`, JSON.stringify(b.owed) === JSON.stringify(owed));
          expect('thenPhase = moveRobber', b.thenPhase === 'moveRobber');
        } else {
          expect('returnPhase = main', b.returnPhase === 'main');
        }
        same('handSizes');
      } else {
        expect('phase → main', b.phase === 'main');
        expect('production only adds cards', b.handSizes.every((h, i) => h >= a.handSizes[i]!));
      }
      same('active', 'offerOpen', 'devPlayed', 'robber', 'roadsLeft');
      return out;
    }
    case 'discard': {
      // Discard
      expect('discard phase', a.phase === 'discard');
      expect(`hand shrinks by owed ${a.owed[by]}`, b.handSizes[by] === a.handSizes[by]! - a.owed[by]!);
      const othersOwe = a.owed.some((o, i) => i !== by && o > 0);
      if (othersOwe) {
        expect('phase stays discard', b.phase === 'discard');
        expect(`owed[${by}] → 0`, b.owed[by] === 0);
        same('active', 'thenPhase', 'robber', 'devPlayed', 'offerOpen');
      } else if (a.thenPhase === 'moveRobber') {
        expect('phase → moveRobber(main)', b.phase === 'moveRobber' && b.returnPhase === 'main');
        same('active', 'robber', 'devPlayed', 'offerOpen');
      } else {
        // autoRobberThenEnd: auto-robber, then the turn ends.
        expect('robber moved', b.robber !== a.robber);
        expect('active → next', b.active === next(pre, a.active));
        expect('phase → BeginTurnPhase(next)', b.phase === beginTurnPhase(post, next(pre, a.active)));
        expect('devPlayed → false', !b.devPlayed);
        expect('offer withdrawn', !b.offerOpen);
      }
      return out;
    }
    case 'moveRobber':
      // MoveRobber
      expect('robber moves to a new hex', b.robber !== a.robber);
      expect(`phase → returnPhase ${a.returnPhase}`, b.phase === a.returnPhase);
      expect('a steal moves at most one card', b.handSizes.reduce((x, y) => x + y, 0) === a.handSizes.reduce((x, y) => x + y, 0));
      same('active', 'offerOpen', 'devPlayed', 'roadsLeft');
      return out;
    case 'playKnight':
      // PlayKnight (Largest Army is not modelled: a winning Knight ends in gameOver)
      expect('preRoll or main', a.phase === 'preRoll' || a.phase === 'main');
      expect('devPlayed → true', b.devPlayed && !a.devPlayed);
      if (b.phase === 'gameOver') expect('a winning Knight reaches the target', vp(post, by) >= post.config.vpTarget);
      else expect(`phase → moveRobber(${a.phase})`, b.phase === 'moveRobber' && b.returnPhase === a.phase);
      expect('offer withdrawn', !b.offerOpen);
      same('active', 'robber', 'handSizes', 'roadsLeft');
      return out;
    case 'playRoadBuilding': {
      // PlayRoadBuilding (∘ EndRoadBuilding when no legal edge exists)
      expect('preRoll or main', a.phase === 'preRoll' || a.phase === 'main');
      expect('devPlayed → true', b.devPlayed && !a.devPlayed);
      const roads = a.roadsLeft[by]!;
      if (b.phase === 'roadBuilding') {
        expect('roads in supply', roads > 0);
        expect(`rbLeft = min(2, ${roads})`, b.rbLeft === Math.min(2, roads));
        expect(`returnPhase = ${a.phase}`, b.returnPhase === a.phase);
        expect('offer withdrawn', !b.offerOpen);
      } else {
        expect('resolves at once in the same phase', b.phase === a.phase);
        same('offerOpen');
      }
      same('active', 'robber', 'handSizes', 'roadsLeft');
      return out;
    }
    case 'endTurn': {
      // EndTurn
      const nx = next(pre, by);
      expect('active → next', b.active === nx);
      expect('phase → BeginTurnPhase(next)', b.phase === beginTurnPhase(post, nx));
      expect('offer withdrawn', !b.offerOpen);
      expect('devPlayed → false', !b.devPlayed);
      same('robber', 'handSizes', 'roadsLeft');
      return out;
    }
    case 'maritimeTrade':
      // BankTrade
      same('phase', 'active', 'offerOpen', 'devPlayed', 'robber', 'roadsLeft');
      return out;
    case 'proposeTrade':
      // OpenOffer (or CloseOffer ∘ OpenOffer over an open offer)
      expect('main', a.phase === 'main');
      expect('offer open', b.offerOpen);
      same('phase', 'active', 'devPlayed', 'robber', 'handSizes', 'roadsLeft');
      return out;
    case 'confirmTrade':
    case 'cancelTrade':
      // CloseOffer (a confirm also moves cards, outside this abstraction)
      expect('offer closed', a.offerOpen && !b.offerOpen);
      same('phase', 'active', 'devPlayed', 'robber', 'roadsLeft');
      return out;
    case 'respondTrade':
      // No CatanCore action (CatanTrade).
      same('phase', 'active', 'offerOpen', 'devPlayed', 'robber', 'handSizes', 'roadsLeft');
      return out;
    case 'playYearOfPlenty':
    case 'playMonopoly':
      // No CatanCore action: only devPlayed changes among the control variables.
      expect('devPlayed → true', b.devPlayed && !a.devPlayed);
      same('phase', 'active', 'offerOpen', 'robber', 'roadsLeft');
      return out;
    default:
      break;
  }
  // Build: placeSettlement, placeRoad or buildCity in main, and buyDevCard (which may draw a VP card).
  expect('main', a.phase === 'main');
  expect('phase → gameOver iff the target is reached', b.phase === winOr(post, 'main'));
  expect('OfferAfter(phase\')', b.offerOpen === (a.offerOpen && b.phase === 'main'));
  same('active', 'devPlayed', 'robber');
  return out;
}

/**
 * SkipSeat(k) ∘ SkipStep* (CatanCore): the skip loop of seat k, run on the control variables, compared with the engine's
 * single skipSeat command. Dice come from the command's diceRolled events (the model's Production / SevenOwed choice);
 * hands and bank are outside the abstraction except for the discard sizes.
 */
export function skipLoopIssues(pre: GameState, k: Seat, post: GameState, events: readonly GameEvent[]): readonly string[] {
  const a = abstractState(pre);
  const b = abstractState(post);
  const out: string[] = [];
  const n = pre.playerCount;
  const eligible = (a.phase === 'discard' && (a.owed[k] ?? 0) > 0) || (k === a.active && ['preRoll', 'moveRobber', 'main', 'roadBuilding'].includes(a.phase));
  if (!eligible) out.push(`skipSeat(${k}) in ${a.phase}: seat is not SkipEligible`);
  const rolls = events.filter((e) => e.kind === 'diceRolled').map((e) => (e.kind === 'diceRolled' ? e.dice[0] + e.dice[1] : 0));
  const st = { phase: a.phase as PhaseName, active: a.active, owed: [...a.owed], then: a.thenPhase, resume: a.returnPhase, offer: a.offerOpen, devPlayed: a.devPlayed, rbLeft: a.rbLeft, robberMoves: 0 };
  const endTurn = () => {
    st.active = ((st.active + 1) % n) as Seat;
    st.phase = beginTurnPhase(post, st.active);
    st.offer = false;
    st.devPlayed = false;
    st.owed = st.owed.map(() => 0);
  };
  for (let guard = 0; guard < 8; guard++) {
    if (st.phase === 'discard' && (st.owed[k] ?? 0) > 0) {
      st.owed[k] = 0;
      if (st.owed.some((o) => o > 0)) break;
      if (st.then === 'moveRobber') {
        st.phase = 'moveRobber';
        st.resume = 'main';
        if (k !== st.active) break;
        continue;
      }
      st.robberMoves++;
      endTurn();
      break;
    }
    if (st.phase === 'moveRobber' && k === st.active) {
      st.robberMoves++;
      st.phase = st.resume ?? 'main';
      continue;
    }
    if (st.phase === 'preRoll' && k === st.active) {
      const roll = rolls.shift();
      if (roll === undefined) {
        out.push('skipSeat: an auto-roll without a diceRolled event');
        break;
      }
      if (roll !== 7) {
        st.phase = 'main';
        continue;
      }
      const owed = a.handSizes.map((h) => (h > pre.config.discardLimit ? Math.floor(h / 2) : 0));
      owed[k] = 0;
      if (owed.some((o) => o > 0)) {
        st.owed = owed;
        st.phase = 'discard';
        st.then = 'autoRobberThenEnd';
        break;
      }
      st.robberMoves++;
      endTurn();
      break;
    }
    if (st.phase === 'roadBuilding' && k === st.active) {
      st.rbLeft = 0;
      st.phase = st.resume ?? 'main';
      continue;
    }
    if (st.phase === 'main' && k === st.active) {
      endTurn();
      break;
    }
    break;
  }
  const expect = (what: string, ok: boolean) => {
    if (!ok) out.push(`skipSeat(${k}) from ${a.phase}: ${what}`);
  };
  expect(`phase ${b.phase}, model ${st.phase}`, b.phase === st.phase);
  expect(`active ${b.active}, model ${st.active}`, b.active === st.active);
  if (b.phase === 'discard') {
    expect(`owed ${b.owed.join(',')}, model ${st.owed.join(',')}`, JSON.stringify(b.owed) === JSON.stringify(st.owed));
    expect(`thenPhase ${b.thenPhase}, model ${st.then}`, b.thenPhase === st.then);
  }
  if (b.phase === 'moveRobber' || b.phase === 'roadBuilding') expect(`returnPhase ${b.returnPhase}, model ${st.resume}`, b.returnPhase === st.resume);
  expect(`offerOpen ${b.offerOpen}, model ${st.offer}`, b.offerOpen === st.offer);
  expect(`devPlayed ${b.devPlayed}, model ${st.devPlayed}`, b.devPlayed === st.devPlayed);
  expect(`rbLeft ${b.rbLeft}, model ${st.rbLeft}`, b.rbLeft === st.rbLeft);
  expect(`robber ${st.robberMoves > 0 ? 'moves (auto-robber)' : 'stays'}`, (b.robber !== a.robber) === st.robberMoves > 0);
  expect('every diceRolled event is an auto-roll of the loop', rolls.length === 0);
  return out;
}
