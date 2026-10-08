// The rule registry. Every rule module registers its own handlers and legal-actions slice through its exported
// `rule`; this file only lists the modules (one per line, sorted), and ACTION_HANDLERS and LEGAL_SLICES are derived
// from those registrations. Adding a rule track means adding one line here.
import type { ActionType } from '../events';
import * as buildLegal from './build-legal';
import * as buildCity from './buildCity';
import * as buyDevCard from './buyDevCard';
import * as cancelTrade from './cancelTrade';
import * as confirmTrade from './confirmTrade';
import * as devLegal from './dev-legal';
import * as endTurn from './endTurn';
import * as maritime from './maritime';
import * as maritimeTrade from './maritimeTrade';
import { PHASE_ACTIONS } from './phases';
import * as placeRoad from './placeRoad';
import * as placeSettlement from './placeSettlement';
import * as playKnight from './playKnight';
import * as playMonopoly from './playMonopoly';
import * as playRoadBuilding from './playRoadBuilding';
import * as playYearOfPlenty from './playYearOfPlenty';
import * as progress from './progress';
import * as proposeTrade from './proposeTrade';
import * as respondTrade from './respondTrade';
import * as robber from './robber';
import * as robberLegal from './robber-legal';
import * as rollLegal from './roll-legal';
import * as rollDice from './rollDice';
import * as setupLegal from './setup-legal';
import * as seven from './seven';
import { skipSeat } from './skipSeat';
import * as tradeLegal from './trade-legal';
import * as turnLegal from './turn-legal';
import { collectHandlers, collectSlices, type ActionHandlers, type LegalSlice, type RuleModule, type SystemHandler } from './types';

/** Every registered rule module. */
export const RULE_MODULES: readonly RuleModule[] = Object.freeze(
  [
    buildLegal,
    buildCity,
    buyDevCard,
    cancelTrade,
    confirmTrade,
    devLegal,
    endTurn,
    maritime,
    maritimeTrade,
    placeRoad,
    placeSettlement,
    playKnight,
    playMonopoly,
    playRoadBuilding,
    playYearOfPlenty,
    progress,
    proposeTrade,
    respondTrade,
    robber,
    robberLegal,
    rollLegal,
    rollDice,
    setupLegal,
    seven,
    tradeLegal,
    turnLegal,
  ].map((m) => m.rule),
);

/** Every action type some phase accepts. */
const ACTION_TYPES: readonly ActionType[] = [...new Set(Object.values(PHASE_ACTIONS).flat())];

export const ACTION_HANDLERS: ActionHandlers = collectHandlers(RULE_MODULES, ACTION_TYPES);

/** The system command (skipSeat) is not an ActionType; its handler is registered here directly. */
export const SYSTEM_HANDLER: SystemHandler = skipSeat;

/** Legal-action slices, merged by legalActions(); phase-disjoint, so their order does not matter. */
export const LEGAL_SLICES: readonly LegalSlice[] = collectSlices(RULE_MODULES);
