// 'playKnight' action handler (R10, R11; AC13). Reached only by the active seat in preRoll or main. The knight is
// counted, Largest Army is re-evaluated, and the robber move starts, resuming the phase the knight was played in.
// Leaving main withdraws any open offer (setPhase → onPhaseExit).
import { setPhase } from '../internal/turn';
import { updateLargestArmy } from '../largest-army';
import { emit } from '../log';
import { devPlayIssue, spendDevCard } from './dev';
import type { ActionHandler } from './types';

export const playKnight: ActionHandler<'playKnight'> = (state, seat) => {
  const issue = devPlayIssue(state, seat, 'knight');
  if (issue !== null) return { ok: false, reason: issue };
  const resume = state.phase.name === 'preRoll' ? 'preRoll' : 'main';
  let s = spendDevCard(state, seat, 'knight');
  s = emit(s, { kind: 'devPlayed', seat, card: 'knight' });
  s = updateLargestArmy(s, seat);
  return { ok: true, state: setPhase(s, { name: 'moveRobber', resume }) };
};
