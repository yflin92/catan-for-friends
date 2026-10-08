// The rule registry: one handler per action type, plus the legal-action slices contributed by each rule track.
import { buildCity } from './buildCity';
import { buyDevCard } from './buyDevCard';
import { cancelTrade } from './cancelTrade';
import { confirmTrade } from './confirmTrade';
import { endTurn } from './endTurn';
import { maritimeSlice } from './maritime';
import { maritimeTrade } from './maritimeTrade';
import { placeRoad } from './placeRoad';
import { placeSettlement } from './placeSettlement';
import { playKnight } from './playKnight';
import { playMonopoly } from './playMonopoly';
import { playRoadBuilding } from './playRoadBuilding';
import { playYearOfPlenty } from './playYearOfPlenty';
import { proposeTrade } from './proposeTrade';
import { respondTrade } from './respondTrade';
import { moveRobber } from './robber';
import { rollDice } from './rollDice';
import { discard } from './seven';
import { skipSeat } from './skipSeat';
import { buildSlice } from './build-legal';
import { devSlice } from './dev-legal';
import { robberSlice } from './robber-legal';
import { rollSlice } from './roll-legal';
import { setupSlice } from './setup-legal';
import { turnSlice } from './turn-legal';
import { tradeSlice } from './trade-legal';
import type { ActionHandlers, LegalSlice, SystemHandler } from './types';

export const ACTION_HANDLERS: ActionHandlers = Object.freeze({
  placeSettlement,
  placeRoad,
  buildCity,
  rollDice,
  discard,
  moveRobber,
  buyDevCard,
  playKnight,
  playRoadBuilding,
  playYearOfPlenty,
  playMonopoly,
  maritimeTrade,
  proposeTrade,
  respondTrade,
  confirmTrade,
  cancelTrade,
  endTurn,
});

export const SYSTEM_HANDLER: SystemHandler = skipSeat;

/** Legal-action slices, merged in this order by legalActions(). Each rule track appends its own. */
export const LEGAL_SLICES: readonly LegalSlice[] = Object.freeze([
  turnSlice, setupSlice, rollSlice, buildSlice, devSlice, robberSlice, tradeSlice, maritimeSlice,
]);
