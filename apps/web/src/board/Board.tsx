// The SVG game board (design §2.4, ADR-0010): terrain, number tokens, harbors, robber and pieces drawn from the engine
// geometry, plus a target layer whose clickable vertices, edges and hexes come only from view.legal.
import { memo, useMemo, useRef, type KeyboardEvent } from 'react';
import type { EdgeId, HexId, Seat, VertexId } from '@hexlands/engine';
import type { PlayerViewWire } from '../wire';
import { harborName, harborRatioLabel, RESOURCE_NAME, SEAT_STYLE, TERRAIN_FILL, TERRAIN_NAME, TERRAIN_RESOURCE } from './art';
import {
  boardBounds,
  edgeToPixels,
  harborAnchor,
  HEX_SIZE,
  hexCornerPoints,
  hexToPixel,
  round,
  SEA_HEXES,
  toPointsAttr,
  tokenPips,
  vertexToPixel,
  type Point,
} from './geometry';
import { targetLabel } from './labels';
import { legalTargets, type PickMode } from './legal-targets';
import { usePanZoom } from './use-pan-zoom';
import './board.css';

export type BoardView = Pick<PlayerViewWire, 'board' | 'robber' | 'pieces' | 'legal'>;

export interface BoardProps {
  readonly view: BoardView;
  /** Which legal targets to offer; null shows none. */
  readonly pick: PickMode | null;
  onPickVertex?(v: VertexId): void;
  onPickEdge?(e: EdgeId): void;
  onPickHex?(h: HexId): void;
}

const S = HEX_SIZE;
const FULL = boardBounds(S);

export function Board({ view, pick, onPickVertex, onPickEdge, onPickHex }: BoardProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const pz = usePanZoom(svgRef, FULL);
  const targets = useMemo(() => legalTargets(view.legal, pick), [view.legal, pick]);
  const v = pz.view;

  return (
    <div className="board">
      <svg
        ref={svgRef}
        className="board-svg"
        viewBox={`${round(v.x)} ${round(v.y)} ${round(v.w)} ${round(v.h)}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label="Game board"
        data-pick={pick ?? ''}
        {...pz.handlers}
      >
        <Sea />
        <Terrain board={view.board} />
        <Harbors board={view.board} />
        <Tokens board={view.board} />
        <Roads roads={view.pieces.roads} />
        <Robber hex={view.robber} />
        <Buildings settlements={view.pieces.settlements} cities={view.pieces.cities} />
        <g className="targets">
          {pick !== null &&
            [...targets.hexes].map((h) => (
              <HexTarget key={h} hex={h} label={targetLabel(pick, view.board.hexes, { hex: h }, view.robber)} onPick={onPickHex} />
            ))}
          {pick !== null &&
            [...targets.edges].map((e) => (
              <EdgeTarget key={e} edge={e} label={targetLabel(pick, view.board.hexes, { edge: e }, view.robber)} onPick={onPickEdge} />
            ))}
          {pick !== null &&
            [...targets.vertices].map((vx) => (
              <VertexTarget key={vx} vertex={vx} label={targetLabel(pick, view.board.hexes, { vertex: vx }, view.robber)} onPick={onPickVertex} />
            ))}
        </g>
      </svg>
      <div className="board-controls" role="group" aria-label="Board zoom">
        <button type="button" onClick={pz.zoomIn} aria-label="Zoom in">
          +
        </button>
        <button type="button" onClick={pz.zoomOut} aria-label="Zoom out">
          −
        </button>
        <button type="button" onClick={pz.reset} aria-label="Fit board">
          ⤢
        </button>
      </div>
    </div>
  );
}

const Sea = memo(function Sea() {
  return (
    <g className="sea" aria-hidden="true">
      {SEA_HEXES.map((h) => (
        <polygon key={h} points={toPointsAttr(hexCornerPoints(h, S))} />
      ))}
    </g>
  );
});

const Terrain = memo(function Terrain({ board }: { board: BoardView['board'] }) {
  return (
    <g className="terrain">
      {board.hexes.map((hex) => {
        const c = hexToPixel(hex.id, S);
        const resource = TERRAIN_RESOURCE[hex.terrain];
        const label = `${TERRAIN_NAME[hex.terrain]}${resource !== null ? ` (${RESOURCE_NAME[resource]})` : ''}${hex.token !== null ? `, ${hex.token}` : ''}`;
        return (
          <g key={hex.id} data-hex={hex.id} data-terrain={hex.terrain}>
            <title>{label}</title>
            <polygon points={toPointsAttr(hexCornerPoints(hex.id, S * 0.97))} fill={TERRAIN_FILL[hex.terrain]} className="hex" />
            <TerrainGlyph terrain={hex.terrain} at={{ x: c.x, y: c.y - S * 0.5 }} />
          </g>
        );
      })}
    </g>
  );
});

/** Small original pictograms so terrain is recognisable without relying on colour. */
function TerrainGlyph({ terrain, at }: { terrain: BoardView['board']['hexes'][number]['terrain']; at: Point }) {
  const k = S * 0.12;
  const t = `translate(${round(at.x)} ${round(at.y)})`;
  switch (terrain) {
    case 'hills':
      return (
        <g transform={t} className="glyph">
          <rect x={-k} y={-k * 0.5} width={k * 0.9} height={k * 0.45} />
          <rect x={k * 0.1} y={-k * 0.5} width={k * 0.9} height={k * 0.45} />
          <rect x={-k * 0.45} y={0} width={k * 0.9} height={k * 0.45} />
        </g>
      );
    case 'forest':
      return <polygon transform={t} className="glyph" points={`0,${-k} ${k * 0.8},${k * 0.6} ${-k * 0.8},${k * 0.6}`} />;
    case 'pasture':
      return <ellipse transform={t} className="glyph" rx={k * 0.9} ry={k * 0.55} />;
    case 'fields':
      return (
        <g transform={t} className="glyph glyph-lines">
          <line x1={-k * 0.5} y1={k * 0.7} x2={-k * 0.5} y2={-k * 0.7} />
          <line x1={0} y1={k * 0.7} x2={0} y2={-k * 0.9} />
          <line x1={k * 0.5} y1={k * 0.7} x2={k * 0.5} y2={-k * 0.7} />
        </g>
      );
    case 'mountains':
      return <polygon transform={t} className="glyph" points={`${-k},${k * 0.6} ${-k * 0.2},${-k * 0.8} ${k * 0.2},${-k * 0.1} ${k * 0.5},${-k * 0.5} ${k},${k * 0.6}`} />;
    case 'desert':
      return <circle transform={t} className="glyph" r={k * 0.45} />;
  }
}

const Tokens = memo(function Tokens({ board }: { board: BoardView['board'] }) {
  return (
    <g className="tokens">
      {board.hexes.map((hex) => {
        if (hex.token === null) return null;
        const c = hexToPixel(hex.id, S);
        const hot = hex.token === 6 || hex.token === 8;
        const pips = tokenPips(hex.token);
        return (
          <g key={hex.id} data-token={hex.token} data-token-hex={hex.id} className={hot ? 'token token-hot' : 'token'}>
            <circle cx={round(c.x)} cy={round(c.y + S * 0.12)} r={S * 0.3} />
            <text x={round(c.x)} y={round(c.y + S * 0.12)} dy="0.1em">
              {hex.token}
            </text>
            {Array.from({ length: pips }, (_, i) => (
              <circle key={i} className="pip" cx={round(c.x + (i - (pips - 1) / 2) * S * 0.07)} cy={round(c.y + S * 0.32)} r={S * 0.022} />
            ))}
          </g>
        );
      })}
    </g>
  );
});

const Harbors = memo(function Harbors({ board }: { board: BoardView['board'] }) {
  return (
    <g className="harbors">
      {board.harbors.map((h) => {
        const [a, b] = edgeToPixels(h.edge, S);
        const m = harborAnchor(h.edge, S);
        return (
          <g key={h.edge} data-harbor={h.edge} data-harbor-kind={h.kind}>
            <title>{`Harbor ${harborRatioLabel(h.kind)} ${harborName(h.kind)}`}</title>
            <line className="pier" x1={round(a.x)} y1={round(a.y)} x2={round(m.x)} y2={round(m.y)} />
            <line className="pier" x1={round(b.x)} y1={round(b.y)} x2={round(m.x)} y2={round(m.y)} />
            <circle className="harbor" cx={round(m.x)} cy={round(m.y)} r={S * 0.27} />
            <text className="harbor-ratio" x={round(m.x)} y={round(m.y - S * 0.05)}>
              {harborRatioLabel(h.kind)}
            </text>
            <text className="harbor-kind" x={round(m.x)} y={round(m.y + S * 0.13)}>
              {harborName(h.kind)}
            </text>
          </g>
        );
      })}
    </g>
  );
});

function Roads({ roads }: { roads: BoardView['pieces']['roads'] }) {
  return (
    <g className="roads">
      {(Object.entries(roads) as [EdgeId, Seat][]).map(([e, seat]) => {
        const [a, b] = edgeToPixels(e, S);
        const st = SEAT_STYLE[seat];
        const inset = 0.18;
        const x1 = a.x + (b.x - a.x) * inset;
        const y1 = a.y + (b.y - a.y) * inset;
        const x2 = b.x + (a.x - b.x) * inset;
        const y2 = b.y + (a.y - b.y) * inset;
        return (
          <g key={e} data-road={e} data-seat={seat}>
            <title>{`Road, seat ${st.label}`}</title>
            <line className="road-outline" x1={round(x1)} y1={round(y1)} x2={round(x2)} y2={round(y2)} stroke={st.stroke} />
            <line
              className="road"
              x1={round(x1)}
              y1={round(y1)}
              x2={round(x2)}
              y2={round(y2)}
              stroke={st.fill}
              strokeDasharray={st.roadDash.length > 0 ? st.roadDash.map((d) => d * S).join(' ') : undefined}
            />
          </g>
        );
      })}
    </g>
  );
}

function Buildings({ settlements, cities }: { settlements: BoardView['pieces']['settlements']; cities: BoardView['pieces']['cities'] }) {
  const k = S * 0.16;
  return (
    <g className="buildings">
      {(Object.entries(settlements) as [VertexId, Seat][]).map(([vx, seat]) => {
        const p = vertexToPixel(vx, S);
        const st = SEAT_STYLE[seat];
        return (
          <g key={vx} data-settlement={vx} data-seat={seat} transform={`translate(${round(p.x)} ${round(p.y)})`}>
            <title>{`Settlement, seat ${st.label}`}</title>
            <polygon className="building" fill={st.fill} stroke={st.stroke} points={`0,${-k * 1.2} ${k},${-k * 0.3} ${k},${k} ${-k},${k} ${-k},${-k * 0.3}`} />
            <text className="building-label" fill={st.stroke} y={k * 0.45}>
              {st.label}
            </text>
          </g>
        );
      })}
      {(Object.entries(cities) as [VertexId, Seat][]).map(([vx, seat]) => {
        const p = vertexToPixel(vx, S);
        const st = SEAT_STYLE[seat];
        return (
          <g key={vx} data-city={vx} data-seat={seat} transform={`translate(${round(p.x)} ${round(p.y)})`}>
            <title>{`City, seat ${st.label}`}</title>
            <polygon
              className="building"
              fill={st.fill}
              stroke={st.stroke}
              points={`${-k * 1.5},${k} ${-k * 1.5},${-k * 0.4} ${-k * 0.6},${-k * 1.3} ${k * 0.3},${-k * 0.4} ${k * 0.3},${-k * 0.1} ${k * 1.5},${-k * 0.1} ${k * 1.5},${k}`}
            />
            <text className="building-label" fill={st.stroke} x={-k * 0.6} y={k * 0.55}>
              {st.label}
            </text>
          </g>
        );
      })}
    </g>
  );
}

function Robber({ hex }: { hex: HexId }) {
  const c = hexToPixel(hex, S);
  const k = S * 0.14;
  return (
    <g className="robber" data-robber={hex} transform={`translate(${round(c.x - S * 0.48)} ${round(c.y + S * 0.05)})`}>
      <title>Robber</title>
      <circle cy={-k * 1.3} r={k * 0.55} />
      <path d={`M ${-k * 0.8},${k * 1.1} Q ${-k * 0.9},${-k * 0.6} 0,${-k * 0.8} Q ${k * 0.9},${-k * 0.6} ${k * 0.8},${k * 1.1} Z`} />
    </g>
  );
}

function activate(e: KeyboardEvent, run: () => void): void {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    run();
  }
}

function VertexTarget({ vertex, label, onPick }: { vertex: VertexId; label: string; onPick: ((v: VertexId) => void) | undefined }) {
  const p = vertexToPixel(vertex, S);
  const pickIt = () => onPick?.(vertex);
  return (
    <g className="target target-vertex" data-target-vertex={vertex} role="button" tabIndex={0} aria-label={label} onClick={pickIt} onKeyDown={(e) => activate(e, pickIt)}>
      <circle className="target-hit" cx={round(p.x)} cy={round(p.y)} r={S * 0.24} />
      <circle className="target-mark" cx={round(p.x)} cy={round(p.y)} r={S * 0.12} />
    </g>
  );
}

function EdgeTarget({ edge, label, onPick }: { edge: EdgeId; label: string; onPick: ((e: EdgeId) => void) | undefined }) {
  const [a, b] = edgeToPixels(edge, S);
  const pickIt = () => onPick?.(edge);
  const inset = 0.22;
  const x1 = round(a.x + (b.x - a.x) * inset);
  const y1 = round(a.y + (b.y - a.y) * inset);
  const x2 = round(b.x + (a.x - b.x) * inset);
  const y2 = round(b.y + (a.y - b.y) * inset);
  return (
    <g className="target target-edge" data-target-edge={edge} role="button" tabIndex={0} aria-label={label} onClick={pickIt} onKeyDown={(e) => activate(e, pickIt)}>
      <line className="target-hit" x1={x1} y1={y1} x2={x2} y2={y2} />
      <line className="target-mark" x1={x1} y1={y1} x2={x2} y2={y2} />
    </g>
  );
}

function HexTarget({ hex, label, onPick }: { hex: HexId; label: string; onPick: ((h: HexId) => void) | undefined }) {
  const pickIt = () => onPick?.(hex);
  return (
    <g className="target target-hex" data-target-hex={hex} role="button" tabIndex={0} aria-label={label} onClick={pickIt} onKeyDown={(e) => activate(e, pickIt)}>
      <polygon className="target-mark" points={toPointsAttr(hexCornerPoints(hex, S * 0.9))} />
    </g>
  );
}

