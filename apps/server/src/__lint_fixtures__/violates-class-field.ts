// V37 seeded violation: an any-typed class-field initialiser as a PlayerView (HARD-1, bug 546967f1).
import type { PlayerView } from '@hexlands/engine';

export class Holder {
  static raw = '{}';
  v: PlayerView = JSON.parse(Holder.raw);
}
