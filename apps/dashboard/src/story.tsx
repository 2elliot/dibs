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
const clock = (us: number) => us ? new Date(us / 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';

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
    const verification = [...rows.verification].sort((a, b) => num(b, 'id') - num(a, 'id'))[0];
    const review = verification ? rows.review.filter(r => num(r, 'verificationId') === num(verification, 'id')).sort((a, b) => num(b, 'id') - num(a, 'id'))[0] : undefined;
    const analyzing = rows.job.some(j => ['queued', 'leased'].includes(str(j, 'state')));
    return { lobby, describe, agents, items, issues, contracts, verification, review, analyzing };
  }, [rows]);
}

type Model = ReturnType<typeof useModel>;
type Tone = 'neutral' | Kind | 'agreed' | 'aligned' | 'broken';

function agentStatus(model: Model, rows: DashboardRows, agent: Row): { label: string; tone: 'working' | 'done' | 'member' } {
  if (rows.head.some(h => num(h, 'participantId') === num(agent, 'id'))) return { label: 'done', tone: 'done' };
  if (agent.online && str(model.lobby, 'state', 'running') === 'running') return { label: 'working', tone: 'working' };
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
function useForceGraph(nodeIds: { id: string; type: 'agent' | 'topic'; parent?: string }[], links: { id: string; source: string; target: string; kind: 'produces' | 'requires' }[], w: number, h: number) {
  const sim = useRef<Simulation<GNode, GLink> | null>(null);
  const nodes = useRef(new Map<string, GNode>());
  const [, setTick] = useState(0);
  const signature = JSON.stringify([nodeIds, links]);
  useEffect(() => {
    const s = forceSimulation<GNode, GLink>().velocityDecay(0.35).alphaDecay(0.015).alphaTarget(0.004)
      .force('collide', forceCollide<GNode>(n => n.type === 'agent' ? 90 : 80).strength(0.9))
      // A slow, per-node drift so the graph keeps gently floating instead of freezing.
      .force('float', () => {
        const t = performance.now() / 4000;
        s.nodes().forEach((n, i) => { if (n.fx != null) return; n.vx = (n.vx ?? 0) + Math.sin(t + i * 1.7) * 0.012; n.vy = (n.vy ?? 0) + Math.cos(t * 0.8 + i * 2.3) * 0.012; });
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
        x += Math.cos(angle) * Math.min(w, h) * 0.3; y += Math.sin(angle) * Math.min(w, h) * 0.3;
      } else {
        const parent = spec.parent ? nodes.current.get(spec.parent) ?? next.get(spec.parent) : undefined;
        if (parent?.x !== undefined && parent.y !== undefined) { x = parent.x + (Math.random() - 0.5) * 30; y = parent.y + (Math.random() - 0.5) * 30; }
      }
      next.set(spec.id, { id: spec.id, type: spec.type, x, y });
    });
    nodes.current = next;
    s.nodes([...next.values()]);
    const k = Math.max(0.6, Math.min(w, h) / 1080);
    s.force('charge', forceManyBody<GNode>().strength(n => (n.type === 'agent' ? -2400 : -1000) * k).distanceMax(900 * k));
    s.force('link', forceLink<GNode, GLink>(links.map(l => ({ ...l }))).id(n => n.id).distance(l => (l.kind === 'produces' ? 200 : 250) * k).strength(0.45));
    s.force('x', forceX<GNode>(w / 2).strength(0.03));
    s.force('y', forceY<GNode>(h / 2).strength(0.045));
    s.alpha(0.8).restart();
  }, [signature, w, h]); // eslint-disable-line react-hooks/exhaustive-deps
  const drag = (id: string) => (event: React.PointerEvent) => {
    const node = nodes.current.get(id); const s = sim.current; if (!node || !s) return;
    (event.target as Element).setPointerCapture(event.pointerId);
    s.alphaTarget(0.25).restart();
    const move = (e: PointerEvent) => { node.fx = e.clientX; node.fy = e.clientY; };
    const up = () => { node.fx = null; node.fy = null; s.alphaTarget(0); window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  };
  return { pos: (id: string) => nodes.current.get(id), drag };
}

// ---- View -------------------------------------------------------------------------------------

export function StoryView({ rows, mode, live, replayLabel, countdown, history }: { rows: DashboardRows; mode: string; live: boolean; replayLabel?: string; countdown: number; history?: React.ReactNode }) {
  const model = useModel(rows);
  const { w, h } = useSize();
  const [openIssue, setOpenIssue] = useState<string | null>(null);
  const [focus, setFocus] = useState<string | null>(null);
  const [panel, setPanel] = useState<'closed' | 'timeline' | 'replay'>('closed');
  const [filter, setFilter] = useState<number | 'all'>('all');

  const nameOf = (participantId: number) => str(rows.participant.find(p => num(p, 'id') === participantId), 'name', `#${participantId}`);
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
  const graph = useForceGraph(nodeSpecs, linkSpecs, w, h);

  const clickTopic = (key: string) => {
    if (model.issues.some(i => i.key === key)) { setOpenIssue(key); setFocus(null); }
    else setFocus(focus === `k:${key}` ? null : `k:${key}`);
  };
  const issue = model.issues.find(i => i.key === openIssue);
  const resolved = model.issues.filter(i => i.state === 'accepted').length;

  return <div className="story">
    <svg className="graph" width={w} height={h} onClick={() => setFocus(null)}>
      <defs>
        <filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6" result="b" /><feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge></filter>
      </defs>
      {linkSpecs.map(link => {
        const a = graph.pos(link.source); const b = graph.pos(link.target);
        if (a?.x === undefined || b?.x === undefined) return null;
        const key = link.target.slice(2); const tone = toneOf(key);
        const agentId = Number(link.source.slice(2));
        const involved = model.issues.find(i => i.key === key)?.parties.includes(agentId) ?? true;
        return <line key={link.id} className={`link ${link.kind} tone-${involved ? tone : 'neutral'}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
      })}
      {topicKeys.map(key => {
        const p = graph.pos(`k:${key}`); if (p?.x === undefined || p.y === undefined) return null;
        const tone = toneOf(key);
        const label = model.describe(key);
        // Labels sit on the outside of the graph, so they don't run under the agents.
        const left = p.x < w / 2; const lx = left ? -20 : 20; const anchor = left ? 'end' : 'start';
        return <g key={key} className={`node topic tone-${tone}`} transform={`translate(${p.x},${p.y})`} onPointerDown={graph.drag(`k:${key}`)} onClick={e => { e.stopPropagation(); clickTopic(key); }}>
          <g className="grow">
            {['contradiction', 'redundancy', 'broken'].includes(tone) && <circle className="halo" r={22} />}
            <circle className="dot" r={tone === 'neutral' ? 11 : 14} />
            {(tone === 'agreed' || tone === 'aligned') && <path className="tick" d="M-5 0 L-1.5 4 L5.5 -4" />}
            {(tone === 'contradiction' || tone === 'broken') && <text className="mark" dy="4.5">!</text>}
            {tone === 'redundancy' && <text className="mark" dy="4.5">=</text>}
            <text className="label" x={lx} dy="4" textAnchor={anchor}>{label}</text>
            {tone !== 'neutral' && <text className="sublabel" x={lx} dy="20" textAnchor={anchor}>{tone === 'contradiction' ? 'contradiction · click for detail' : tone === 'redundancy' ? 'redundancy · click for detail' : tone === 'broken' ? "didn't fit · found only by testing" : tone === 'agreed' ? 'agreed by everyone' : 'already compatible'}</text>}
          </g>
        </g>;
      })}
      {model.agents.map(agent => {
        const id = num(agent, 'id'); const p = graph.pos(`a:${id}`); if (p?.x === undefined || p.y === undefined) return null;
        const status = agentStatus(model, rows, agent); const provider = str(agent, 'provider');
        const hot = model.issues.find(i => i.parties.includes(id) && ['proposed', 'escalated', 'rejected'].includes(i.state));
        return <g key={id} className={`node agent ${provider} ${status.tone} ${hot ? `hot-${hot.kind}` : ''}`} transform={`translate(${p.x},${p.y})`} onPointerDown={graph.drag(`a:${id}`)} onClick={e => { e.stopPropagation(); setFocus(focus === `a:${id}` ? null : `a:${id}`); }}>
          <g className="grow">
            <circle className="ring" r={38} />
            <circle className="body" r={30} />
            <text className="mark" dy="7">{PROVIDER_MARK[provider] ?? '?'}</text>
            <text className="name" dy="56">{str(agent, 'name')}</text>
            <text className="status" dy="72">{status.label} · #{id}</text>
          </g>
        </g>;
      })}
    </svg>

    {focus && <FocusCard id={focus} model={model} rows={rows} pos={graph.pos(focus)} nameOf={nameOf} />}

    <header className="overlay top-left">
      <div className="mark-d">d</div>
      <div><b>dibs</b><span>lobby {str(model.lobby, 'id', '–')}</span></div>
      <div className={`mode ${mode === 'dibs' ? 'on' : 'off'}`}>{mode === 'dibs' ? 'dibs on' : 'dibs off'}</div>
    </header>

    <div className="overlay top-right">
      {model.issues.length > 0 && <button className="chip issues" onClick={() => setOpenIssue(model.issues.find(i => i.state !== 'accepted')?.key ?? model.issues[0]!.key)}>{model.issues.length} issue{model.issues.length > 1 ? 's' : ''} · {resolved} resolved</button>}
      <span className={`chip ${live ? 'live' : 'replay'}`}><i />{live ? 'LIVE' : `REPLAY${replayLabel ? ` · ${replayLabel}` : ''}`}</span>
      {countdown > 0 && <span className="chip time">{String(Math.floor(countdown / 60)).padStart(2, '0')}:{String(countdown % 60).padStart(2, '0')}</span>}
      <button className="chip menu" aria-label="History" onClick={() => setPanel(panel === 'closed' ? 'timeline' : 'closed')}>☰</button>
    </div>

    <Narration model={model} mode={mode} nameOf={nameOf} failedRoot={failedRoot} />

    <div className="overlay legend">
      <span><i className="sw solid" />builds</span><span><i className="sw dashed" />needs</span>
      <span><i className="dot-sw contradiction" />contradiction</span><span><i className="dot-sw redundancy" />redundancy</span><span><i className="dot-sw agreed" />agreed</span>
    </div>

    {panel !== 'closed' && <aside className="side-panel">
      <div className="side-tabs">
        <button className={panel === 'timeline' ? 'selected' : ''} onClick={() => setPanel('timeline')}>Timeline</button>
        {history && <button className={panel === 'replay' ? 'selected' : ''} onClick={() => setPanel('replay')}>Replay</button>}
        <a href={location.search.replace(/([?&])view=story&?/, '$1') || '?'} className="side-link">Evidence view</a>
        <button className="close" onClick={() => setPanel('closed')} aria-label="Close">×</button>
      </div>
      {panel === 'timeline' ? <Timeline rows={rows} model={model} filter={filter} setFilter={setFilter} nameOf={nameOf} providerOf={providerOf} /> : <div className="side-replay">{history}</div>}
    </aside>}

    {issue && <Drawer issue={issue} rows={rows} nameOf={nameOf} providerOf={providerOf} close={() => setOpenIssue(null)} />}
  </div>;
}

function FocusCard({ id, model, rows, pos, nameOf }: { id: string; model: Model; rows: DashboardRows; pos?: GNode; nameOf: (id: number) => string }) {
  if (pos?.x === undefined || pos.y === undefined) return null;
  const style = { left: Math.min(pos.x + 46, window.innerWidth - 360), top: Math.max(pos.y - 40, 70) };
  if (id.startsWith('a:')) {
    const pid = Number(id.slice(2));
    const plan = rows.plan.filter(p => num(p, 'participantId') === pid).sort((a, b) => num(b, 'revision') - num(a, 'revision'))[0];
    const agent = rows.participant.find(p => num(p, 'id') === pid);
    return <div className="focus-card" style={style}>
      <b>{nameOf(pid)}</b><span>{PROVIDER_LABEL[str(agent, 'provider')] ?? str(agent, 'provider')} · session #{pid}</span>
      <p>{plan ? str(plan, 'goal') : "Hasn't shared a plan yet."}</p>
      <ul>{model.items.filter(i => num(i, 'participantId') === pid).map(i => <li key={str(i, 'id')}><em>{str(i, 'kind') === 'produces' ? 'builds' : 'needs'}</em>{model.describe(str(i, 'key'))}</li>)}</ul>
    </div>;
  }
  const key = id.slice(2);
  const contract = model.contracts.find(c => str(c, 'key') === key);
  return <div className="focus-card" style={style}>
    <b>{model.describe(key)}</b><span>{key}</span>
    <ul>{model.items.filter(i => str(i, 'key') === key).map(i => <li key={str(i, 'id')}><em>{nameOf(num(i, 'participantId'))} {str(i, 'kind') === 'produces' ? 'builds' : 'needs'}</em>{str(i, 'text')}</li>)}</ul>
    {contract && <p className="agreed-text">{str(contract, 'source') === 'agreed' ? 'Agreed' : 'Compatible'}: {str(contract, 'text')}</p>}
  </div>;
}

function Narration({ model, mode, nameOf, failedRoot }: { model: Model; mode: string; nameOf: (id: number) => string; failedRoot?: Row }) {
  const open = model.issues.find(i => ['proposed', 'escalated'].includes(i.state));
  let tone = 'idle'; let title = 'Waiting for agents to share their plans'; let detail = '';
  if (model.verification) {
    const passed = num(model.verification, 'passed'); const total = num(model.verification, 'total');
    if (passed === total) { tone = 'good'; title = `Works together ✓  all ${total} real-user checks passed`; }
    else { tone = 'bad'; title = `Broken ✗  ${passed} of ${total} checks passed`; detail = str(failedRoot, 'explanation') || str(model.review, 'summary'); }
  } else if (open) {
    tone = open.kind;
    const agreed = open.votes.filter(v => v.decision === 'accept').length;
    title = `${KIND_LABEL[open.kind]}: ${open.label.toLowerCase()}`;
    detail = `Voting on a fix: ${agreed} of ${open.parties.length} agreed · ${open.parties.map(p => `${nameOf(p)} ${open.votes.find(v => v.participantId === p) ? '✓' : '…'}`).join('  ')}`;
  } else if (model.analyzing) {
    tone = 'busy'; title = 'Comparing plans…';
  } else if (model.issues.length) {
    tone = 'good'; title = `Agreed: ${model.issues.map(i => i.label.toLowerCase()).join(', ')}`; detail = 'Everyone involved accepted the fix and is building to it.';
  } else if (model.items.length) {
    title = mode === 'dibs' ? 'Plans shared · no problems so far' : 'Each agent is building on its own guesses';
  }
  return <div key={`${tone}-${title}`} className={`overlay narration ${tone}`}><b>{title}</b>{detail && <span>{detail}</span>}</div>;
}

function Drawer({ issue, rows, nameOf, providerOf, close }: { issue: Issue; rows: DashboardRows; nameOf: (id: number) => string; providerOf: (id: number) => string; close: () => void }) {
  return <div className="drawer-backdrop" onClick={close}>
    <aside className={`drawer ${issue.state === 'accepted' ? 'agreed' : issue.kind}`} onClick={event => event.stopPropagation()}>
      <button className="drawer-close" onClick={close} aria-label="Close">×</button>
      <span className="issue-kind">{KIND_LABEL[issue.kind]} · {issue.state === 'accepted' ? 'resolved' : issue.state === 'proposed' ? 'voting' : issue.state}</span>
      <h2>{issue.label}</h2>
      <p className="drawer-lead">{str(issue.latest, 'rationale')}</p>
      <h3>What each agent assumed</h3>
      <div className="assumptions">{issue.cited.map(item => <div key={str(item, 'id')} className="assumption">
        <div className={`avatar ${providerOf(num(item, 'participantId'))}`}>{PROVIDER_MARK[providerOf(num(item, 'participantId'))] ?? '?'}</div>
        <div><b>{nameOf(num(item, 'participantId'))} {str(item, 'kind') === 'produces' ? 'builds' : 'expects'}</b><p>{str(item, 'text')}</p></div>
      </div>)}</div>
      <h3>If it had carried on</h3>
      <p className="consequence">{CONSEQUENCE[issue.kind]}</p>
      <h3>The fix everyone voted on</h3>
      <p className="fix">{str(issue.latest, 'contractText')}</p>
      <h3>Votes</h3>
      <ol className="history">{issue.revisions.map(rev => {
        const votes = rows.response.filter(r => num(r, 'proposalId') === num(rev, 'id'));
        return <li key={str(rev, 'id')}><b>Proposal {str(rev, 'revision')}</b> <span className={`pill ${str(rev, 'state')}`}>{str(rev, 'state') === 'proposed' ? 'voting' : str(rev, 'state')}</span>
          <ul>{ids(rev.requiredPartyIds).map(p => {
            const vote = votes.find(v => num(v, 'participantId') === p);
            return <li key={p}>{nameOf(p)}: {vote ? (str(vote, 'decision') === 'accept' ? 'agreed' : `pushed back${str(vote, 'reason') ? `: “${str(vote, 'reason')}”` : ''}`) : 'hasn’t voted yet'}</li>;
          })}</ul></li>;
      })}</ol>
    </aside>
  </div>;
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

function Timeline({ rows, model, filter, setFilter, nameOf, providerOf }: { rows: DashboardRows; model: Model; filter: number | 'all'; setFilter: (f: number | 'all') => void; nameOf: (id: number) => string; providerOf: (id: number) => string }) {
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
      {model.agents.map(a => <button key={str(a, 'id')} className={filter === num(a, 'id') ? 'selected' : ''} onClick={() => setFilter(num(a, 'id'))}><span className={`avatar tiny ${str(a, 'provider')}`}>{PROVIDER_MARK[str(a, 'provider')]}</span>{str(a, 'name')}</button>)}
    </div>
    <ol>{shown.map(({ event, actorId, text }) => <li key={str(event, 'id')} className={str(event, 'type')}>
      <time>{clock(num(event, 'atUs'))}</time>
      {actorId !== undefined ? <span className={`avatar tiny ${providerOf(actorId)}`}>{PROVIDER_MARK[providerOf(actorId)]}</span> : <span className="avatar tiny lobby">d</span>}
      <p>{text}</p>
    </li>)}</ol>
    {!shown.length && <p className="empty">Nothing yet.</p>}
  </div>;
}
