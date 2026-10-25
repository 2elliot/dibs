// The "story" view: a full-screen, living graph of the lobby (in the spirit of Obsidian's graph view
// and Gource). Agents are the big nodes. Each shared thing an agent builds or needs becomes a topic
// node it spawns and links to (solid = builds, dashed = needs); agents that touch the same topic meet
// there. dibs' findings colour the topic: red for a contradiction, orange for a redundancy, green once
// everyone agrees. Nodes float into place with a force layout and can be dragged. A single line of
// narration sits at the bottom; the issue detail, a plain-language timeline and the replay controls
// stay out of the way until asked for. Reads the same rows as the evidence view (live or replay).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY, type Simulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import type { DashboardRows } from './source';
import './story.css';

type Row = Record<string, unknown>;
const str = (row: Row | undefined, key: string, fallback = '') => String(row?.[key] ?? fallback);
const num = (row: Row | undefined, key: string) => Number(row?.[key] ?? 0);
const ids = (value: unknown): number[] => {
  if (Array.isArray(value)) return value.map(Number);
  if (typeof value === 'string') { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed.map(Number) : []; } catch { return []; } }
  return [];
};
const parse = (value: unknown): Row => { if (typeof value !== 'string') return (value as Row) ?? {}; try { return JSON.parse(value) as Row; } catch { return {}; } };
// Project-room seats are named `project-<room>-<provider>`; show just the agent.
const display = (name: string) => {
  const seat = /^project-\d+-(claude|codex|droid)$/.exec(name);
  if (seat) return PROVIDER_LABEL[seat[1]!]!;
  return /^[a-z]/.test(name) ? name.charAt(0).toUpperCase() + name.slice(1) : name;
};
/** Graph labels stay short; the full description is in the hover title and the detail card. */
const short = (text: string, max = 34) => {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), max - 8)).replace(/[\s:,;·-]+$/, '')}…`;
};
const clock = (us: number) => us ? new Date(us / 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '';

const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', droid: 'Droid' };
const PROVIDER_MARK: Record<string, string> = { claude: 'C', codex: 'X', droid: 'D' };

/** Plain-language names for the shared interfaces; anything else falls back to the lobby's own description. */
const FRIENDLY_KEYS: Record<string, string> = {
  'auth.session': 'How users stay logged in',
  'auth.server': 'The login check other code uses',
  'events.registration': 'Signing up for an event',
  'project.interface': 'How the parts connect',
};

type Kind = 'contradiction' | 'redundancy' | 'dependency';
const KIND_OF: Record<string, Kind> = { conflict: 'contradiction', duplicate: 'redundancy', dependency: 'dependency' };
const KIND_LABEL: Record<Kind, string> = { contradiction: 'Contradiction', redundancy: 'Redundancy', dependency: 'Depends on' };
const CONSEQUENCE: Record<Kind, string> = {
  contradiction: 'If both had carried on, each part would work on its own but they would not fit together. Git merges the code without complaint, and the app breaks where the parts meet.',
  redundancy: 'If both had carried on, two agents would have built the same thing: wasted work, and two versions someone has to reconcile by hand.',
  dependency: 'One agent needs this from another. Without agreeing on its shape first, it would build against a guess.',
};

interface Issue {
  key: string;
  label: string;
  kind: Kind;
  revisions: Row[];
  latest: Row;
  state: string;
  parties: number[];
  cited: Row[];
  votes: { participantId: number; decision: string; reason: string }[];
}

function useModel(rows: DashboardRows) {
  return useMemo(() => {
    const lobby = rows.lobby[0] as Row | undefined;
    const vocabulary = parse(str(lobby, 'vocabularyJson', '[]')) as unknown as { key: string; description: string }[];
    const describe = (key: string) => FRIENDLY_KEYS[key] ?? (Array.isArray(vocabulary) ? vocabulary.find(v => v.key === key)?.description : undefined) ?? key;
    const agents = rows.participant.filter(p => str(p, 'role') === 'agent')
      .filter(p => rows.plan.some(plan => num(plan, 'participantId') === num(p, 'id')) || num(p, 'currentLobbyId') === num(lobby, 'id') || rows.head.some(h => num(h, 'participantId') === num(p, 'id')))
      .sort((a, b) => num(a, 'id') - num(b, 'id'));
    const items = rows.plan_item.filter(i => i.current !== false);
    const byKey = new Map<string, Row[]>();
    for (const proposal of rows.proposal) {
      const key = str(proposal, 'key');
      if (!KIND_OF[str(proposal, 'relation')]) continue;
      byKey.set(key, [...(byKey.get(key) ?? []), proposal]);
    }
    const issues: Issue[] = [...byKey.entries()].map(([key, list]) => {
      const revisions = [...list].sort((a, b) => num(a, 'id') - num(b, 'id'));
      const latest = revisions.at(-1)!;
      const cited = ids(latest.citedItemIds).map(id => rows.plan_item.find(i => num(i, 'id') === id)).filter(Boolean) as Row[];
      const votes = rows.response.filter(r => num(r, 'proposalId') === num(latest, 'id')).map(r => ({ participantId: num(r, 'participantId'), decision: str(r, 'decision'), reason: str(r, 'reason') }));
      return { key, label: describe(key), kind: KIND_OF[str(latest, 'relation')]!, revisions, latest, state: str(latest, 'state'), parties: ids(latest.requiredPartyIds), cited, votes };
    }).sort((a, b) => num(a.latest, 'createdAtUs') - num(b.latest, 'createdAtUs'));
    const contracts = rows.contract.filter(c => c.current !== false);
    // A check that ran before every agent's work was in (lobby 7's early 0/6) isn't the result.
    const handedIn = new Set(rows.head.map(h => num(h, 'participantId'))).size;
    const complete = rows.verification.filter(v => Object.keys(parse(v.assembledFrom)).length >= handedIn);
    const verification = [...complete].sort((a, b) => num(b, 'id') - num(a, 'id'))[0];
    const review = verification ? rows.review.filter(r => num(r, 'verificationId') === num(verification, 'id')).sort((a, b) => num(b, 'id') - num(a, 'id'))[0] : undefined;
    const analyzing = rows.job.some(j => ['queued', 'leased'].includes(str(j, 'state')));
    return { lobby, describe, agents, items, issues, contracts, verification, review, analyzing };
  }, [rows]);
}

type Model = ReturnType<typeof useModel>;
type Tone = 'neutral' | Kind | 'agreed' | 'aligned' | 'broken';

function agentStatus(model: Model, rows: DashboardRows, agent: Row): { label: string; tone: 'working' | 'done' | 'member' } {
  if (rows.head.some(h => num(h, 'participantId') === num(agent, 'id'))) return { label: 'done', tone: 'done' };
  // Replays don't keep who was online when, so an agent that has shared a plan in a running lobby counts as working.
  const planned = rows.plan.some(p => num(p, 'participantId') === num(agent, 'id'));
  if ((agent.online || planned) && str(model.lobby, 'state', 'running') === 'running') return { label: 'working', tone: 'working' };
  return { label: 'member', tone: 'member' };
}

// ---- Graph ------------------------------------------------------------------------------------

interface GNode extends SimulationNodeDatum { id: string; type: 'agent' | 'topic'; }
interface GLink extends SimulationLinkDatum<GNode> { id: string; kind: 'produces' | 'requires'; }

function useSize() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onResize = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return size;
}

/** Keeps one force simulation alive across data changes, so existing nodes stay put and new ones grow out of their agent. */
interface View { x: number; y: number; k: number }

function useForceGraph(nodeIds: { id: string; type: 'agent' | 'topic'; parent?: string }[], links: { id: string; source: string; target: string; kind: 'produces' | 'requires' }[], w: number, h: number, view: React.MutableRefObject<View>) {
  const sim = useRef<Simulation<GNode, GLink> | null>(null);
  const nodes = useRef(new Map<string, GNode>());
  const [, setTick] = useState(0);
  const signature = JSON.stringify([nodeIds, links]);
  useEffect(() => {
    // Light forces and heavy damping: nodes glide into place slowly rather than snapping.
    const s = forceSimulation<GNode, GLink>().velocityDecay(0.6).alphaDecay(0.008).alphaTarget(0.003)
      .force('collide', forceCollide<GNode>(n => n.type === 'agent' ? 130 : 140).strength(0.9))
      // A slow, per-node drift so the graph keeps gently floating instead of freezing.
      .force('float', () => {
        const t = performance.now() / 4000;
        s.nodes().forEach((n, i) => { if (n.fx != null) return; n.vx = (n.vx ?? 0) + Math.sin(t + i * 1.7) * 0.006; n.vy = (n.vy ?? 0) + Math.cos(t * 0.8 + i * 2.3) * 0.006; });
      });
    // Cap speed per tick so new links ease nodes into place instead of yanking them.
    s.force('glide', () => {
      for (const n of s.nodes()) {
        const v = Math.hypot(n.vx ?? 0, n.vy ?? 0); const max = 2.2;
        if (v > max) { n.vx = (n.vx! / v) * max; n.vy = (n.vy! / v) * max; }
      }
    });
    let frame = 0;
    s.on('tick', () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setTick(t => t + 1)); });
    sim.current = s;
    return () => { s.stop(); cancelAnimationFrame(frame); };
  }, []);
  useEffect(() => {
    const s = sim.current; if (!s) return;
    const next = new Map<string, GNode>();
    const agents = nodeIds.filter(n => n.type === 'agent');
    nodeIds.forEach(spec => {
      const existing = nodes.current.get(spec.id);
      if (existing) { next.set(spec.id, existing); return; }
      let x = w / 2, y = h / 2;
      if (spec.type === 'agent') {
        const i = agents.findIndex(a => a.id === spec.id);
        const angle = -Math.PI / 2 + (i / Math.max(agents.length, 1)) * Math.PI * 2 + Math.PI / 6;
        x += Math.cos(angle) * Math.min(w, h) * 0.33; y += Math.sin(angle) * Math.min(w, h) * 0.33;
      } else {
        const parent = spec.parent ? nodes.current.get(spec.parent) ?? next.get(spec.parent) : undefined;
        if (parent?.x !== undefined && parent.y !== undefined) { x = parent.x + (Math.random() - 0.5) * 30; y = parent.y + (Math.random() - 0.5) * 30; }
      }
      next.set(spec.id, { id: spec.id, type: spec.type, x, y });
    });
    nodes.current = next;
    s.nodes([...next.values()]);
    const k = Math.max(0.6, Math.min(w, h) / 1080);
    // Stronger repulsion between agents plus a firmer pull along each line: topics settle near
    // the agents that use them and lines spread apart, so fewer of them cross.
    s.force('charge', forceManyBody<GNode>().strength(n => (n.type === 'agent' ? -3200 : -1300) * k).distanceMax(1400 * k));
    s.force('link', forceLink<GNode, GLink>(links.map(l => ({ ...l }))).id(n => n.id).distance(l => (l.kind === 'produces' ? 220 : 280) * k).strength(0.5));
    s.force('x', forceX<GNode>(w / 2).strength(0.018));
    s.force('y', forceY<GNode>(h / 2).strength(0.028));
    s.alpha(Math.max(s.alpha(), 0.35)).restart();
  }, [signature, w, h]); // eslint-disable-line react-hooks/exhaustive-deps
  const drag = (id: string) => (event: React.PointerEvent) => {
    const node = nodes.current.get(id); const s = sim.current; if (!node || !s) return;
    event.stopPropagation();
    s.alphaTarget(0.15).restart();
    const move = (e: PointerEvent) => { const v = view.current; node.fx = (e.clientX - v.x) / v.k; node.fy = (e.clientY - v.y) / v.k; };
    const up = () => { node.fx = null; node.fy = null; s.alphaTarget(0.003); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  return { pos: (id: string) => nodes.current.get(id), drag };
}

// ---- View -------------------------------------------------------------------------------------

const RECORDINGS = [
  { url: '/replays/t1-lobby5.json', label: 'T1 · without dibs' },
  { url: '/replays/t3-lobby7.json', label: 'T3 · with dibs' },
  { url: '/sim/team.json', label: 'Simulated team' },
  { url: '/sim/chaos.json', label: 'Chaos (simulated)' },
  { url: '/replays/exp-room2.json', label: 'Playground · Claude + Codex' },
  { url: '/replays/exp-board-dibs.json', label: 'Task board · 3 agents (dibs)' },
];

/** LIVE only while a lobby is actually running; otherwise say we're connected and what we're waiting for. */
function LiveChip({ live, lobby }: { live: boolean; lobby: Row | undefined }) {
  if (!live) return <span className="chip replay"><i />REPLAY</span>;
  const state = str(lobby, 'state');
  const id = str(lobby, 'id');
  const [cls, text, title] =
    !lobby ? ['idle', 'CONNECTED · no lobby yet', 'Connected to the database. A lobby will appear here when one is created.']
    : state === 'running' ? ['live', 'LIVE', `Lobby ${id} is running`]
    : state === 'setup' ? ['setup', 'SETTING UP', `Lobby ${id} has been created; agents are joining`]
    : ['idle', `CONNECTED · lobby ${id} ended`, 'Nothing is running right now. The next lobby will appear here as soon as it starts.'];
  return <span className={`chip ${cls}`} title={title}><i />{text}</span>;
}

export interface StoryTimeline {
  start: number; end: number; time: number;
  playing: boolean; setPlaying: (v: boolean) => void; setClock: (v: number) => void;
  speed: number; setSpeed: (v: number) => void;
  /** The whole run, not just the past, so keyframes can show what's coming. */
  events: Row[]; proposals: Row[]; verifications: Row[]; heads: Row[];
}

export function StoryView({ rows, mode, live, replayLabel, countdown, timeline }: { rows: DashboardRows; mode: string; live: boolean; replayLabel?: string; countdown: number; timeline?: StoryTimeline }) {
  const history = timeline;
  const jump = (atUs: number) => { if (!timeline) return; timeline.setPlaying(false); timeline.setClock(Math.min(timeline.end, atUs + 1_500_000)); };
  const model = useModel(rows);
  const { w, h } = useSize();
  const [focus, setFocus] = useState<string | null>(null);
  const [panel, setPanel] = useState<'closed' | 'timeline' | 'replay'>('closed');
  const [filter, setFilter] = useState<number | 'all'>('all');
  const [showTime, setShowTime] = useState(false);
  const [view, setView] = useState<View>({ x: 0, y: 0, k: 1 });
  // Until someone pans or zooms, the camera follows the graph so every node stays on screen.
  const [autoFit, setAutoFit] = useState(true);
  const fitRef = useRef<View>({ x: 0, y: 0, k: 1 });
  /** The default zoom: comfortably zoomed out. The camera only goes further out when the graph needs it. */
  const BASE_ZOOM = 0.72;
  const viewRef = useRef(view);
  const svgRef = useRef<SVGSVGElement>(null);
  // Scroll to zoom around the pointer.
  useEffect(() => {
    const svg = svgRef.current; if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const base = viewRef.current; setAutoFit(false);
      setView(() => {
        const v = base;
        const k = Math.min(3, Math.max(0.2, v.k * Math.exp(-e.deltaY * 0.0015)));
        return { k, x: e.clientX - (e.clientX - v.x) * (k / v.k), y: e.clientY - (e.clientY - v.y) * (k / v.k) };
      });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, []);
  // T shows or hides the time controls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if ((e.key === 't' || e.key === 'T') && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement)) setShowTime(v => !v); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Space plays or pauses a replay.
  useEffect(() => {
    if (!timeline) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      const t = e.target;
      if (t instanceof HTMLTextAreaElement || (t instanceof HTMLInputElement && t.type !== 'range')) return;
      e.preventDefault(); // stops a focused button from also toggling, and the page from scrolling
      if (e.repeat) return;
      timeline.setPlaying(!timeline.playing);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [timeline]);
  // Drag the background to pan.
  const pan = (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    const start = { x: event.clientX, y: event.clientY, v: viewRef.current };
    let released = false;
    let moved = false;
    const move = (e: PointerEvent) => { moved = moved || Math.abs(e.clientX - start.x) + Math.abs(e.clientY - start.y) > 3; if (!moved) return; if (!released) { released = true; setAutoFit(false); } setView({ ...start.v, x: start.v.x + e.clientX - start.x, y: start.v.y + e.clientY - start.y }); };
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (!moved) setFocus(null); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };

  const nameOf = (participantId: number) => display(str(rows.participant.find(p => num(p, 'id') === participantId), 'name', `#${participantId}`));
  const providerOf = (participantId: number) => str(rows.participant.find(p => num(p, 'id') === participantId), 'provider');
  const failedRoot = model.verification && num(model.verification, 'passed') < num(model.verification, 'total')
    ? parse(str(model.review, 'findings', '{}')).rootCause as Row | undefined : undefined;

  // Topics: one per shared key an agent builds or needs, coloured by what dibs found about it.
  const topicKeys = [...new Set(model.items.map(i => str(i, 'key')))];
  const toneOf = (key: string): Tone => {
    const issue = model.issues.find(i => i.key === key);
    if (issue && ['proposed', 'escalated', 'rejected'].includes(issue.state)) return issue.kind;
    if (failedRoot && mode !== 'dibs' && str(failedRoot, 'key') === key) return 'broken';
    const contract = model.contracts.find(c => str(c, 'key') === key);
    if (contract) return str(contract, 'source') === 'agreed' ? 'agreed' : 'aligned';
    if (issue?.state === 'accepted') return 'agreed';
    return 'neutral';
  };
  const firstOwner = (key: string) => {
    const item = [...model.items].filter(i => str(i, 'key') === key).sort((a, b) => num(a, 'id') - num(b, 'id'))[0];
    return item ? `a:${num(item, 'participantId')}` : undefined;
  };
  const nodeSpecs = [
    ...model.agents.map(a => ({ id: `a:${num(a, 'id')}`, type: 'agent' as const })),
    ...topicKeys.map(key => ({ id: `k:${key}`, type: 'topic' as const, parent: firstOwner(key) })),
  ];
  const linkSpecs = model.items
    .filter(i => model.agents.some(a => num(a, 'id') === num(i, 'participantId')))
    .map(i => ({ id: `l:${str(i, 'id')}`, source: `a:${num(i, 'participantId')}`, target: `k:${str(i, 'key')}`, kind: (str(i, 'kind') === 'produces' ? 'produces' : 'requires') as 'produces' | 'requires' }));
  const graph = useForceGraph(nodeSpecs, linkSpecs, w, h, viewRef);

  const clickTopic = (key: string) => setFocus(`k:${key}`);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFocus(null); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const resolved = model.issues.filter(i => i.state === 'accepted').length;
  // Proposals being voted on right now. The simulation ticks continuously, so `now` animates the pulses.
  const polls = model.issues.filter(i => i.state === 'proposed');
  const now = performance.now();
  // Fit the camera to the nodes (labels need room on the sides), easing toward it on every frame.
  {
    const pts = nodeSpecs.map(n => graph.pos(n.id)).filter((p): p is GNode => p?.x !== undefined && p.y !== undefined);
    if (pts.length) {
      const xs = pts.map(p => p.x!); const ys = pts.map(p => p.y!);
      const minX = Math.min(...xs) - 260, maxX = Math.max(...xs) + 260, minY = Math.min(...ys) - 90, maxY = Math.max(...ys) + 130;
      const top = 80, bottom = 120;
      const k = Math.min(BASE_ZOOM, (w - 60) / (maxX - minX), (h - top - bottom) / (maxY - minY));
      const target = { k, x: w / 2 - ((minX + maxX) / 2) * k, y: top + (h - top - bottom) / 2 - ((minY + maxY) / 2) * k };
      const f = fitRef.current; const ease = f.k === 1 && f.x === 0 && f.y === 0 ? 1 : 0.08;
      fitRef.current = { k: f.k + (target.k - f.k) * ease, x: f.x + (target.x - f.x) * ease, y: f.y + (target.y - f.y) * ease };
    }
  }
  const shown = autoFit ? fitRef.current : view;
  // Dragging a node takes the camera off auto-fit, freezing it where it is.
  const dragNode = (id: string) => (event: React.PointerEvent) => {
    if (autoFit) { setView({ ...viewRef.current }); setAutoFit(false); }
    graph.drag(id)(event);
  };
  viewRef.current = shown;

  return <div className="story">
    <svg ref={svgRef} className="graph" width={w} height={h} onPointerDown={pan} onDoubleClick={() => setAutoFit(true)}>
      <defs>
        <pattern id="dots" width="32" height="32" patternUnits="userSpaceOnUse"><circle cx="16" cy="16" r="1.3" className="grid-dot" /></pattern>
      </defs>
      <g transform={`translate(${shown.x},${shown.y}) scale(${shown.k})`}>
      <rect className="space" x={-20000} y={-20000} width={40000} height={40000} fill="url(#dots)" />
      {linkSpecs.map(link => {
        const a = graph.pos(link.source); const b = graph.pos(link.target);
        if (a?.x === undefined || b?.x === undefined) return null;
        const key = link.target.slice(2); const tone = toneOf(key);
        const agentId = Number(link.source.slice(2));
        const involved = model.issues.find(i => i.key === key)?.parties.includes(agentId) ?? true;
        return <line key={link.id} className={`link ${link.kind} tone-${involved ? tone : 'neutral'}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
      })}
      {polls.map(poll => {
        // A poll in progress: pulses travel from the topic to every agent that still has to vote.
        const t = graph.pos(`k:${poll.key}`); if (t?.x === undefined || t.y === undefined) return null;
        return poll.parties.filter(pid => !poll.votes.some(v => v.participantId === pid)).map((pid, i) => {
          const a = graph.pos(`a:${pid}`); if (a?.x === undefined || a.y === undefined) return null;
          return [0, 0.5].map(offset => {
            const f = (now / 1400 + offset + i * 0.17) % 1;
            return <circle key={`${poll.key}-${pid}-${offset}`} className={`poll-pulse ${poll.kind}`} cx={t.x! + (a.x! - t.x!) * f} cy={t.y! + (a.y! - t.y!) * f} r={6 - f * 2.5} opacity={1 - f * 0.6} />;
          });
        });
      })}
      {topicKeys.map(key => {
        const p = graph.pos(`k:${key}`); if (p?.x === undefined || p.y === undefined) return null;
        const tone = toneOf(key);
        const label = model.describe(key);
        const poll = polls.find(q => q.key === key);
        // Labels sit on the outside of the graph, so they don't run under the agents.
        const left = p.x < w / 2; const lx = left ? -28 : 28; const anchor = left ? 'end' : 'start';
        const rr = tone === 'neutral' ? 15 : 19;
        return <g key={key} className={`node topic tone-${tone}`} transform={`translate(${p.x},${p.y})`} onPointerDown={dragNode(`k:${key}`)} onClick={e => { e.stopPropagation(); clickTopic(key); }}>
          <g className="grow"><g className="hoverable">
            <circle className="hover-ring" r={rr + 9} />
            {['contradiction', 'redundancy', 'broken'].includes(tone) && <circle className="halo" r={30} />}
            {poll && [0, 1, 2].map(i => <circle key={i} className={`poll-wave ${poll.kind}`} r={26} style={{ animationDelay: `${i * 0.6}s` }} />)}
            {poll && <Ballot poll={poll} />}
            <circle className="dot" r={rr} />
            <Badge r={rr} />
            {(tone === 'agreed' || tone === 'aligned') && <path className="tick" d="M-7 0 L-2 5.5 L7.5 -5.5" />}
            {(tone === 'contradiction' || tone === 'broken') && <text className="mark" dy="6">!</text>}
            {tone === 'redundancy' && <text className="mark" dy="6">=</text>}
            <text className="label" x={lx} dy="5" textAnchor={anchor}><title>{label}</title>{short(label)}</text>
            {tone !== 'neutral' && <text className="sublabel" x={lx} dy="25" textAnchor={anchor}>{poll ? `poll · ${poll.votes.filter(v => v.decision === 'accept').length} of ${poll.parties.length} agreed` : tone === 'contradiction' ? 'contradiction' : tone === 'redundancy' ? 'redundancy' : tone === 'dependency' ? 'depends on' : tone === 'broken' ? "didn't fit · found only by testing" : tone === 'agreed' ? 'agreed by everyone' : 'already compatible'}</text>}
          </g></g>
        </g>;
      })}
      {model.agents.map(agent => {
        const id = num(agent, 'id'); const p = graph.pos(`a:${id}`); if (p?.x === undefined || p.y === undefined) return null;
        const status = agentStatus(model, rows, agent); const provider = str(agent, 'provider');
        const hot = model.issues.find(i => i.parties.includes(id) && ['proposed', 'escalated', 'rejected'].includes(i.state));
        const polled = polls.some(q => q.parties.includes(id) && !q.votes.some(v => v.participantId === id));
        return <g key={id} className={`node agent ${provider} ${status.tone} ${hot ? `hot-${hot.kind}` : ''} ${polled ? 'polled' : ''}`} transform={`translate(${p.x},${p.y})`} onPointerDown={dragNode(`a:${id}`)} onClick={e => { e.stopPropagation(); setFocus(`a:${id}`); }}>
          <g className="grow"><g className="hoverable">
            <circle className="ring" r={52} />
            <circle className="hover-ring" r={58} />
            <circle className="body" r={42} />
            <Badge r={42} />
            <text className="mark" dy="10">{PROVIDER_MARK[provider] ?? '?'}</text>
            <text className="name" dy="76">{display(str(agent, 'name'))}</text>
            <text className="status" dy="96">{status.label} · #{id}</text>
          </g></g>
        </g>;
      })}
      </g>
    </svg>

    {focus && <IndexCard id={focus} model={model} rows={rows} nameOf={nameOf} failedRoot={mode !== 'dibs' ? failedRoot : undefined} verification={model.verification} close={() => setFocus(null)} />}

    <header className="overlay top-left">
      <div className="mark-d">d</div>
      <div><b>dibs</b><span>lobby {str(model.lobby, 'id', '–')}</span></div>
      <div className={`mode ${mode === 'dibs' ? 'on' : 'off'}`}>{mode === 'dibs' ? 'dibs on' : 'dibs off'}</div>
    </header>
    <div className="overlay hint">drag to pan · scroll to zoom · double-click to fit{history ? ' · T for time' : ''}</div>

    <div className="overlay top-right">
      {model.issues.length > 0 && <button className="chip issues" onClick={() => setFocus(`k:${model.issues.find(i => i.state !== 'accepted')?.key ?? model.issues[0]!.key}`)}>{model.issues.length} issue{model.issues.length > 1 ? 's' : ''} · {resolved} resolved</button>}
      {history ? <button className={`chip replay ${showTime ? 'active' : ''}`} onClick={() => setShowTime(v => !v)} title="Show or hide the time controls (T)"><i /><span className="chip-text">REPLAY{replayLabel ? ` · ${replayLabel}` : ''}</span> <kbd>T</kbd></button>
        : <LiveChip live={live} lobby={model.lobby} />}
      {countdown > 0 && <span className="chip time">{String(Math.floor(countdown / 60)).padStart(2, '0')}:{String(countdown % 60).padStart(2, '0')}</span>}
      <button className="chip menu" aria-label="History" onClick={() => setPanel(panel === 'closed' ? 'timeline' : 'closed')}>☰</button>
    </div>

    <Narration model={model} mode={mode} nameOf={nameOf} failedRoot={failedRoot} />
    {showTime && timeline && <TimeBar tl={timeline} describe={model.describe} />}

    <div className="overlay legend">
      <b>Key</b>
      <span><i className="sw solid" />builds</span>
      <span><i className="sw dashed" />needs</span>
      <span><i className="dot-sw contradiction" />contradiction</span>
      <span><i className="dot-sw redundancy" />redundancy</span>
      <span><i className="dot-sw dependency" />depends on</span>
      <span><i className="dot-sw poll" />poll · voting now</span>
      <span><i className="dot-sw agreed" />agreed</span>
      <span><i className="dot-sw aligned" />already compatible</span>
    </div>

    {panel !== 'closed' && <aside className="side-panel">
      <div className="side-tabs">
        <button className={panel === 'timeline' ? 'selected' : ''} onClick={() => setPanel('timeline')}>Timeline</button>
        <a href={location.search.replace(/([?&])view=story&?/, '$1') || '?'} className="side-link">Evidence view</a>
        <button className="close" onClick={() => setPanel('closed')} aria-label="Close">×</button>
      </div>
      <div className="recordings"><span>Recordings</span>
        {RECORDINGS.map(r => <a key={r.url} href={`?view=story&replay=${r.url}`} className={location.search.includes(r.url) ? 'selected' : ''}>{r.label}</a>)}
        {/* No uri/db: the serving deployment's /config.json picks its own database. */}
        <a href="?view=story">Live</a>
      </div>
      <Timeline rows={rows} model={model} filter={filter} setFilter={setFilter} nameOf={nameOf} providerOf={providerOf} onJump={timeline ? jump : undefined} />
    </aside>}


  </div>;
}

const KEYFRAME: Record<string, { tone: string; label: (subject: string, detail: Row) => string }> = {
  lobby_started: { tone: 'start', label: () => 'Lobby started' },
  proposal_created: { tone: 'issue', label: s => `Problem found${s ? `: ${s}` : ''}` },
  proposal_rejected: { tone: 'pushback', label: (s, d) => `Pushed back${str(d, 'reason') ? `: “${str(d, 'reason')}”` : ''}` },
  proposal_accepted: { tone: 'agreed', label: s => `Agreed${s ? `: ${s}` : ''}` },
  fallback_reached: { tone: 'start', label: () => 'Fallback: talking time is up' },
  verification_recorded: { tone: 'tested', label: () => 'Combined app tested' },
  review_recorded: { tone: 'tested', label: () => 'The AI reviewer explained the result' },
};

/** Play, scrub and jump between the moments that matter (problems found, pushback, agreement, test). */
function TimeBar({ tl, describe }: { tl: StoryTimeline; describe: (key: string) => string }) {
  // The track starts just before the lobby starts, not when it was created.
  const started = tl.events.find(e => str(e, 'type') === 'lobby_started');
  const start = started ? Math.max(tl.start, num(started, 'atUs') - 5_000_000) : tl.start;
  const span = Math.max(1, tl.end - start);
  const pct = (t: number) => Math.max(0, ((t - start) / span) * 100);
  const proposalKey = (id: number) => str(tl.proposals.find(p => num(p, 'id') === id), 'key');
  const relationOf = (id: number) => str(tl.proposals.find(p => num(p, 'id') === id), 'relation');
  const handedIn = new Set(tl.heads.map(h => num(h, 'participantId'))).size;
  const verificationLabel = (id: number) => {
    const v = tl.verifications.find(r => num(r, 'id') === id);
    if (!v) return 'Combined app tested';
    if (Object.keys(parse(v.assembledFrom)).length < handedIn) return 'Early check before all work was handed in (superseded)';
    return `Combined app tested: ${num(v, 'passed')} of ${num(v, 'total')} checks passed`;
  };
  const partial = (id: number) => { const v = tl.verifications.find(r => num(r, 'id') === id); return Boolean(v) && Object.keys(parse(v!.assembledFrom)).length < handedIn; };
  const frames = tl.events.filter(e => KEYFRAME[str(e, 'type')] && !(str(e, 'type') === 'verification_recorded' && str(parse(e.detail), 'state') === 'verified'))
    .map(e => {
      const type = str(e, 'type'); const detail = parse(e.detail);
      const key = str(detail, 'key') || (type.startsWith('proposal') ? proposalKey(num(e, 'subjectId')) : '');
      const relation = type === 'proposal_created' ? relationOf(num(e, 'subjectId')) : '';
      const isCheck = type === 'verification_recorded';
      const tone = isCheck ? (partial(num(e, 'subjectId')) ? 'start' : 'tested') : relation === 'duplicate' ? 'redundancy' : relation === 'dependency' ? 'dependency' : KEYFRAME[type]!.tone;
      const text = isCheck ? verificationLabel(num(e, 'subjectId')) : KEYFRAME[type]!.label(key ? describe(key).toLowerCase() : '', detail);
      return { at: num(e, 'atUs'), tone, label: `${clock(num(e, 'atUs'))} · ${text}` };
    }).sort((a, b) => a.at - b.at);
  const go = (at: number) => { tl.setPlaying(false); tl.setClock(Math.min(tl.end, at + 1_500_000)); };
  // Moments that would sit on top of each other share one diamond (the most important one shows).
  const RANK = ['issue', 'pushback', 'redundancy', 'dependency', 'tested', 'agreed', 'start'];
  const clusters: { at: number; frames: typeof frames }[] = [];
  for (const f of frames) {
    const last = clusters.at(-1);
    if (last && pct(f.at) - pct(last.frames.at(-1)!.at) < 1.4) last.frames.push(f); else clusters.push({ at: f.at, frames: [f] });
  }
  const prev = [...frames].reverse().find(f => f.at + 1_500_000 < tl.time - 500_000);
  const next = frames.find(f => f.at + 1_500_000 > tl.time + 500_000);
  return <div className="overlay timebar">
    <button className="tb-btn" onClick={() => prev ? go(prev.at) : tl.setClock(start)} title="Previous key moment">⏮</button>
    <button className="tb-btn play" onClick={() => tl.setPlaying(!tl.playing)} aria-label={tl.playing ? 'Pause' : 'Play'}>{tl.playing ? '❚❚' : '▶'}</button>
    <button className="tb-btn" onClick={() => next && go(next.at)} disabled={!next} title="Next key moment">⏭</button>
    <span className="tb-time">{clock(tl.time)}</span>
    <div className="tb-track">
      <div className="tb-fill" style={{ width: `${pct(tl.time)}%` }} />
      <input type="range" aria-label="Replay timeline" min={start} max={tl.end} value={Math.max(start, tl.time)} onChange={e => { tl.setPlaying(false); tl.setClock(Number(e.target.value)); }} />
      {clusters.map((c, i) => {
        const tone = [...c.frames].sort((a, b) => RANK.indexOf(a.tone) - RANK.indexOf(b.tone))[0]!.tone;
        const title = c.frames.map(f => f.label).join('\n');
        return <button key={i} className={`kf ${tone} ${c.at <= tl.time ? 'past' : ''}`} style={{ left: `${pct(c.at)}%` }} title={title} aria-label={title} onClick={() => go(c.at)}>{c.frames.length > 1 && <span>{c.frames.length}</span>}</button>;
      })}
    </div>
    <span className="tb-time">{clock(tl.end)}</span>
    <select className="tb-speed" value={tl.speed} onChange={e => tl.setSpeed(Number(e.target.value))} aria-label="Speed">{[0.25, 0.5, 1, 2, 4].map(v => <option key={v} value={v}>{v}×</option>)}</select>
  </div>;
}

/** The poll as a ring around the topic: one segment per voter, filled in as votes arrive. */
function Ballot({ poll }: { poll: Issue }) {
  const n = poll.parties.length; const r = 27; const gap = n > 1 ? 10 : 0;
  const point = (deg: number) => [Math.cos((deg - 90) * Math.PI / 180) * r, Math.sin((deg - 90) * Math.PI / 180) * r] as const;
  return <g className="ballot">{poll.parties.map((pid, i) => {
    const from = (i * 360) / n + gap / 2; const to = ((i + 1) * 360) / n - gap / 2;
    const [x1, y1] = point(from); const [x2, y2] = point(to);
    const vote = poll.votes.find(v => v.participantId === pid);
    return <path key={pid} className={`seat ${vote ? vote.decision : 'pending'}`} d={`M${x1} ${y1} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2} ${y2}`} />;
  })}</g>;
}

/** A small "open me" mark on everything that has a popup. */
function Badge({ r }: { r: number }) {
  const d = r * 0.72;
  return <g className="badge" transform={`translate(${d},${-d})`}><circle r={8} /><path d="M-2.6 2.6 L2.6 -2.6 M-1.2 -2.6 H2.6 V1.2" /></g>;
}

const RISK: Record<Kind, string> = {
  contradiction: 'Each part works alone; together the app breaks.',
  redundancy: 'Two versions of the same work to reconcile.',
  dependency: 'Built against a guess about the other part.',
};

/** The popup: a plain index card, centred, one timestamped line per thing that happened. */
function IndexCard({ id, model, rows, nameOf, failedRoot, verification, close }: { id: string; model: Model; rows: DashboardRows; nameOf: (id: number) => string; failedRoot?: Row; verification?: Row; close: () => void }) {
  type Line = { at: number; label: string; text: string; tone?: string };
  const lines: Line[] = [];
  const planAt = (planId: number) => num(rows.plan.find(p => num(p, 'id') === planId), 'createdAtUs');
  let title = ''; let tag = ''; let tagTone = '';
  if (id.startsWith('k:')) {
    const key = id.slice(2);
    title = model.describe(key);
    const issue = model.issues.find(i => i.key === key);
    const contract = model.contracts.find(c => str(c, 'key') === key);
    for (const it of model.items.filter(i => str(i, 'key') === key))
      lines.push({ at: planAt(num(it, 'planId')), label: nameOf(num(it, 'participantId')), text: `${str(it, 'kind') === 'produces' ? 'builds' : 'needs'}: ${str(it, 'text')}` });
    if (issue) {
      for (const rev of issue.revisions) {
        const at = num(rev, 'createdAtUs');
        if (rev === issue.revisions[0]) {
          lines.push({ at, label: 'Found', text: str(rev, 'rationale') || `${KIND_LABEL[issue.kind]}.`, tone: issue.kind });
          lines.push({ at, label: 'Risk', text: RISK[issue.kind] });
        }
        lines.push({ at, label: rev === issue.revisions[0] ? 'Fix' : `Fix v${str(rev, 'revision')}`, text: str(rev, 'contractText') });
        for (const r of rows.response.filter(x => num(x, 'proposalId') === num(rev, 'id')))
          lines.push({ at: num(r, 'createdAtUs'), label: nameOf(num(r, 'participantId')), text: str(r, 'decision') === 'accept' ? 'agreed ✓' : `pushed back${str(r, 'reason') ? `: “${str(r, 'reason')}”` : ''}`, tone: str(r, 'decision') === 'accept' ? 'good' : 'bad' });
        const closed = num(rev, 'closedAtUs');
        if (str(rev, 'state') === 'accepted' && closed) lines.push({ at: closed, label: 'Agreed', text: 'everyone involved accepted the fix', tone: 'good' });
        if (str(rev, 'state') === 'rejected' && closed) lines.push({ at: closed, label: 'Revising', text: 'dibs is rewriting the fix', tone: 'bad' });
      }
      tag = `${KIND_LABEL[issue.kind]} · ${issue.state === 'accepted' ? 'resolved' : issue.state === 'proposed' ? 'voting' : issue.state === 'rejected' ? 'revising' : issue.state}`;
      tagTone = issue.state === 'accepted' ? 'good' : issue.kind;
    } else if (contract) {
      lines.push({ at: num(contract, 'createdAtUs'), label: str(contract, 'source') === 'agreed' ? 'Agreed' : 'Compatible', text: str(contract, 'text'), tone: 'good' });
      tag = str(contract, 'source') === 'agreed' ? 'Agreed' : 'Already compatible'; tagTone = 'good';
    } else {
      tag = 'No conflict found';
    }
    if (failedRoot && str(failedRoot, 'key') === key) {
      lines.push({ at: num(verification, 'createdAtUs'), label: 'Test', text: str(failedRoot, 'explanation'), tone: 'bad' });
      tag = "Didn't fit · found only by testing"; tagTone = 'contradiction';
    }
  } else {
    const pid = Number(id.slice(2));
    const agent = rows.participant.find(p => num(p, 'id') === pid);
    title = nameOf(pid);
    tag = `${PROVIDER_LABEL[str(agent, 'provider')] ?? str(agent, 'provider')} · session #${pid}`;
    for (const plan of rows.plan.filter(p => num(p, 'participantId') === pid))
      lines.push({ at: num(plan, 'createdAtUs'), label: num(plan, 'revision') > 1 ? `Plan v${str(plan, 'revision')}` : 'Plan', text: str(plan, 'goal') });
    for (const it of model.items.filter(i => num(i, 'participantId') === pid))
      lines.push({ at: planAt(num(it, 'planId')), label: str(it, 'kind') === 'produces' ? 'Builds' : 'Needs', text: model.describe(str(it, 'key')) });
    for (const r of rows.response.filter(x => num(x, 'participantId') === pid)) {
      const prop = rows.proposal.find(p => num(p, 'id') === num(r, 'proposalId'));
      lines.push({ at: num(r, 'createdAtUs'), label: 'Voted', text: `${str(r, 'decision') === 'accept' ? 'agreed to' : 'pushed back on'} the fix for ${model.describe(str(prop, 'key')).toLowerCase()}`, tone: str(r, 'decision') === 'accept' ? 'good' : 'bad' });
    }
    const head = rows.head.find(h => num(h, 'participantId') === pid);
    if (head) lines.push({ at: num(head, 'createdAtUs'), label: 'Done', text: 'handed in its work' });
  }
  lines.sort((a, b) => a.at - b.at);
  return <div className="card-backdrop" onClick={close}>
    <article className="index-card" onClick={e => e.stopPropagation()} role="dialog" aria-label={title}>
      <header>
        <div><h2>{title}</h2><span className={`card-tag ${tagTone}`}>{tag}</span></div>
        <button onClick={close} aria-label="Close">✕</button>
      </header>
      {lines.length ? <div className="card-rows">{lines.map((l, i) => <div key={i} className={`card-row ${l.tone ?? ''}`}>
        <time>{l.at ? clock(l.at) : ''}</time><b>{l.label}</b><span>{l.text}</span>
      </div>)}</div> : <p className="card-empty">Nothing yet.</p>}
    </article>
  </div>;
}

function Narration({ model, mode, nameOf, failedRoot }: { model: Model; mode: string; nameOf: (id: number) => string; failedRoot?: Row }) {
  const open = model.issues.find(i => ['proposed', 'escalated'].includes(i.state));
  let tone = 'idle'; let title = 'Waiting for agents to share their plans'; let detail = '';
  if (model.verification) {
    const passed = num(model.verification, 'passed'); const total = num(model.verification, 'total');
    if (passed === total) { tone = 'good'; title = `Works together ✓  all ${total} real-user checks passed`; }
    else { tone = 'bad'; title = `Broken ✗  ${passed} of ${total} checks passed`; detail = str(failedRoot, 'explanation') || str(model.review, 'summary') || 'The AI reviewer is looking into why…'; }
  } else if (open) {
    tone = open.kind;
    const agreed = open.votes.filter(v => v.decision === 'accept').length;
    title = `${KIND_LABEL[open.kind]}: ${open.label.toLowerCase()}`;
    detail = `Voting on a fix: ${agreed} of ${open.parties.length} agreed · ${open.parties.map(p => `${nameOf(p)} ${open.votes.find(v => v.participantId === p) ? '✓' : '…'}`).join('  ')}`;
  } else if (model.analyzing) {
    tone = 'busy'; title = 'Comparing plans…';
  } else if (model.issues.some(i => i.state === 'rejected')) {
    const pushed = model.issues.find(i => i.state === 'rejected')!;
    const no = pushed.votes.find(v => v.decision === 'reject');
    tone = pushed.kind; title = `${no ? nameOf(no.participantId) : 'An agent'} pushed back on the fix for ${pushed.label.toLowerCase()}`; detail = `${no?.reason ? `“${no.reason}” · ` : ''}dibs is revising the proposal`;
  } else if (model.issues.length && model.issues.every(i => i.state === 'accepted')) {
    tone = 'good'; title = `Agreed: ${model.issues.map(i => i.label.toLowerCase()).join(', ')}`; detail = 'Everyone involved accepted the fix and is building to it.';
  } else if (model.items.length) {
    title = mode === 'dibs' ? 'Plans shared · no problems so far' : 'Each agent is building on its own guesses';
  }
  return <div key={`${tone}-${title}`} className={`overlay narration ${tone}`} title={detail ? `${title}: ${detail}` : title}><em><i />NOW</em><b>{title}</b>{detail && <span>{detail}</span>}</div>;
}

const EVENT_TEXT: Record<string, (actor: string, detail: Row, subject: string) => string | null> = {
  lobby_started: () => 'The lobby started. The clock is running.',
  joined_lobby: actor => `${actor} joined.`,
  plan_published: actor => `${actor} shared its plan.`,
  message_sent: actor => `${actor} sent a message to the team.`,
  proposal_created: (_a, _d, subject) => `dibs spotted a problem${subject ? ` with ${subject.toLowerCase()}` : ''} and proposed a fix.`,
  response_recorded: (actor, detail) => `${actor} ${str(detail, 'decision') === 'reject' ? 'pushed back on' : 'agreed to'} the proposal.`,
  proposal_accepted: (_a, _d, subject) => `Everyone agreed${subject ? ` on ${subject.toLowerCase()}` : ''}.`,
  proposal_rejected: (actor, detail) => `${actor} pushed back${str(detail, 'reason') ? `: “${str(detail, 'reason')}”` : ''}. dibs is revising the proposal.`,
  proposal_escalated: () => 'Still no agreement after two tries. Escalated.',
  proposal_superseded: () => 'A plan changed, so dibs withdrew an outdated proposal.',
  contract_agreed: (_a, _d, subject) => `Locked in${subject ? `: ${subject.toLowerCase()}` : ''}.`,
  contract_aligned: (_a, _d, subject) => `Already compatible${subject ? `: ${subject.toLowerCase()}` : ''}. Nothing to vote on.`,
  notice_sent: (_a, detail, subject) => detail.key ? `dibs noticed something nobody is building yet${subject ? `: ${subject.toLowerCase()}` : ''}.` : null,
  fallback_reached: () => 'Time is up for talking. Anything not yet agreed falls back to sensible defaults.',
  head_reported: actor => `${actor} finished and handed in its work.`,
  verification_recorded: (_a, detail) => detail.state === 'verified' ? null : detail.passed !== undefined ? `The combined app was tested: ${String(detail.passed)} of ${String(detail.total ?? 6)} checks passed.` : 'The combined app was tested.',
  review_recorded: () => 'An AI reviewer explained the result.',
  lobby_stopped: () => 'The lobby stopped.',
};

function Timeline({ rows, model, filter, setFilter, nameOf, providerOf, onJump }: { rows: DashboardRows; model: Model; filter: number | 'all'; setFilter: (f: number | 'all') => void; nameOf: (id: number) => string; providerOf: (id: number) => string; onJump?: (atUs: number) => void }) {
  const byName = new Map(rows.participant.map(p => [str(p, 'name').toLowerCase(), num(p, 'id')]));
  const subjectKey = (event: Row) => {
    const detailKey = str(parse(event.detail), 'key');
    if (detailKey) return model.describe(detailKey);
    const subject = num(event, 'subjectId');
    const type = str(event, 'type');
    const row = type.startsWith('contract') ? rows.contract.find(c => num(c, 'id') === subject) : type.startsWith('proposal') || type === 'response_recorded' ? rows.proposal.find(p => num(p, 'id') === subject) : undefined;
    return row ? model.describe(str(row, 'key')) : '';
  };
  // Real verification events carry only the row id; fill in the score from the row.
  const detailOf = (event: Row): Row => {
    const detail = parse(event.detail);
    if (str(event, 'type') === 'verification_recorded' && detail.passed === undefined && detail.state === undefined) {
      const v = rows.verification.find(r => num(r, 'id') === num(event, 'subjectId'));
      if (v) return { passed: num(v, 'passed'), total: num(v, 'total') };
    }
    return detail;
  };
  const entries = [...rows.event].sort((a, b) => num(b, 'atUs') - num(a, 'atUs')).map(event => {
    const actorName = str(event, 'actor');
    const known = byName.get(actorName.toLowerCase());
    // Only agents get their own avatar; the verifier and reviewer speak for dibs.
    const actorId = known !== undefined && str(rows.participant.find(p => num(p, 'id') === known), 'role') === 'agent' ? known : undefined;
    const actor = actorId !== undefined ? nameOf(actorId) : ['system', 'analysis', 'worker', 'verifier', 'Droid SDK'].includes(actorName) ? 'dibs' : actorName;
    const text = EVENT_TEXT[str(event, 'type')]?.(actor, detailOf(event), subjectKey(event));
    return text ? { event, actorId, text } : null;
  }).filter(Boolean) as { event: Row; actorId?: number; text: string }[];
  const shown = filter === 'all' ? entries : entries.filter(e => e.actorId === filter);
  return <div className="timeline">
    <div className="timeline-filters">
      <button className={filter === 'all' ? 'selected' : ''} onClick={() => setFilter('all')}>Everyone</button>
      {model.agents.map(a => <button key={str(a, 'id')} className={filter === num(a, 'id') ? 'selected' : ''} onClick={() => setFilter(num(a, 'id'))}><span className={`avatar tiny ${str(a, 'provider')}`}>{PROVIDER_MARK[str(a, 'provider')]}</span>{display(str(a, 'name'))}</button>)}
    </div>
    <ol>{shown.map(({ event, actorId, text }) => <li key={str(event, 'id')} className={`${str(event, 'type')} ${onJump ? 'jumpable' : ''}`} onClick={() => onJump?.(num(event, 'atUs'))} title={onJump ? 'Go to this moment' : undefined}>
      <time>{clock(num(event, 'atUs'))}</time>
      {actorId !== undefined ? <span className={`avatar tiny ${providerOf(actorId)}`}>{PROVIDER_MARK[providerOf(actorId)]}</span> : <span className="avatar tiny lobby">d</span>}
      <p>{text}</p>
    </li>)}</ol>
    {!shown.length && <p className="empty">Nothing yet.</p>}
  </div>;
}
