// Game over (F7, AC18): the winner, then every seat's revealed hand, development cards and VP (view.reveal).
import { RESOURCES, type Seat } from '@hexlands/engine';
import { RESOURCE_NAME } from '../board/art';
import type { PlayerViewWire, RoomView } from '../wire';
import { DEV_CARD_NAME } from './DevCards';
import { seatName } from './names';

export function WinScreen({ view, room }: { view: PlayerViewWire; room: RoomView | null }) {
  if (view.phase.name !== 'gameOver') return null;
  const winner = view.phase.winner;
  return (
    <section className="win" aria-label="Game over" data-testid="win-screen">
      <h2>{winner === view.you ? 'You won!' : `${seatName(room, winner)} won!`}</h2>
      {view.reveal !== null && (
        <table className="reveal">
          <thead>
            <tr>
              <th scope="col">Player</th>
              <th scope="col">VP</th>
              <th scope="col">Hand</th>
              <th scope="col">Development cards</th>
            </tr>
          </thead>
          <tbody>
            {view.reveal.vp.map((vp, seat) => (
              <tr key={seat} data-reveal-seat={seat}>
                <th scope="row">{seatName(room, seat as Seat)}</th>
                <td>{vp}</td>
                <td>
                  {RESOURCES.map((r) => `${view.reveal?.hands[seat]?.[r] ?? 0} ${RESOURCE_NAME[r].toLowerCase()}`).join(', ')}
                </td>
                <td>{(view.reveal?.devCards[seat] ?? []).map((k) => DEV_CARD_NAME[k]).join(', ') || 'none'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
