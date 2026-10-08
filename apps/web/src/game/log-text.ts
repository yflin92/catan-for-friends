// One line of text per log entry, for every GameEvent kind (design §3.3). Private details appear only because the
// server sends those entries only to the seats that may see them; unknown kinds from a newer server get generic text.
import type { Resource, ResourceCounts, Seat } from '@hexlands/engine';
import { RESOURCE_NAME } from '../board/art';
import { unknownEventText } from '../log-store';
import type { LogEntryWire } from '../wire';
import { DEV_CARD_NAME } from './DevCards';
import { formatCounts } from './turn-model';

type Name = (seat: Seat) => string;
type Ev = Record<string, unknown> & { kind: string };

const res = (r: unknown) => (typeof r === 'string' && r in RESOURCE_NAME ? RESOURCE_NAME[r as Resource].toLowerCase() : String(r));

export function eventText(entry: LogEntryWire, you: Seat, name: Name): string {
  const e = entry.event as unknown as Ev;
  const who = (s: unknown) => (s === you ? 'You' : name(s as Seat));
  switch (e.kind) {
    case 'diceRolled': {
      const dice = e['dice'] as [number, number];
      const gains = (e['gains'] as ResourceCounts[])[you];
      const got = gains !== undefined && formatCounts(gains) !== 'nothing' ? ` You got ${formatCounts(gains)}.` : '';
      return `${who(e['seat'])} rolled ${dice[0] + dice[1]} (${dice[0]} + ${dice[1]}).${got}`;
    }
    case 'setupResources':
      return `${who(e['seat'])} received ${formatCounts(e['gained'] as ResourceCounts)} from the second settlement.`;
    case 'built':
      return `${who(e['seat'])} built a ${String(e['piece'])}${e['free'] === true ? ' for free' : ''}.`;
    case 'discarded':
      return `${who(e['seat'])} discarded ${formatCounts(e['cards'] as ResourceCounts)}.`;
    case 'robberMoved':
      return e['victim'] === null ? `${who(e['seat'])} moved the robber.` : `${who(e['seat'])} moved the robber to rob ${name(e['victim'] as Seat)}.`;
    case 'stole':
      return `${who(e['seat'])} stole a card from ${e['victim'] === you ? 'you' : name(e['victim'] as Seat)}.`;
    case 'stoleDetail':
      return `The stolen card was 1 ${res(e['resource'])}.`;
    case 'devBought':
      return `${who(e['seat'])} bought a development card.`;
    case 'devBoughtDetail':
      return `It was a ${DEV_CARD_NAME[e['card'] as keyof typeof DEV_CARD_NAME] ?? String(e['card'])}.`;
    case 'devPlayed': {
      const card = DEV_CARD_NAME[e['card'] as keyof typeof DEV_CARD_NAME] ?? String(e['card']);
      const picks = Array.isArray(e['picks']) ? ` (${(e['picks'] as unknown[]).map(res).join(' + ')})` : '';
      return `${who(e['seat'])} played ${card}${picks}.`;
    }
    case 'maritimeTraded':
      return `${who(e['seat'])} traded ${String(e['gave'])} ${res(e['give'])} with the bank for ${String(e['received'])} ${res(e['receive'])}.`;
    case 'tradeProposed': {
      const o = e['offer'] as { from: Seat; give: ResourceCounts; get: ResourceCounts };
      return `${who(o.from)} offered ${formatCounts(o.give)} for ${formatCounts(o.get)}.`;
    }
    case 'tradeResponded':
      return `${who(e['seat'])} ${e['accept'] === true ? 'accepted' : 'declined'} the offer.`;
    case 'tradeResolved':
      switch (e['outcome']) {
        case 'confirmed':
          return `The trade went through${e['partner'] !== null ? ` with ${e['partner'] === you ? 'you' : name(e['partner'] as Seat)}` : ''}.`;
        case 'cancelled':
          return 'The offer was cancelled.';
        case 'replaced':
          return 'The offer was replaced.';
        default:
          return 'The offer was withdrawn.';
      }
    case 'awardChanged': {
      const award = e['award'] === 'longestRoad' ? 'Longest Road' : 'Largest Army';
      return e['to'] === null ? `Nobody holds ${award} now.` : `${who(e['to'])} took ${award}.`;
    }
    case 'seatSkipped':
      return `${who(e['seat'])} was skipped.`;
    case 'turnEnded':
      return `${who(e['seat'])} ended turn ${String(e['turn'])}.`;
    case 'gameOver':
      return `${who(e['winner'])} won the game!`;
    default:
      return unknownEventText(e.kind);
  }
}
