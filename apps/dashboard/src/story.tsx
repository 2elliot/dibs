// The "story" view: the lobby as a picture a non-engineer can follow. Agents sit around the lobby,
// each with what it says it's building; when dibs finds a contradiction or a redundancy the two
// agents light up with a labelled link between them, a banner shows the vote, and the link turns
// green once everyone agrees. Click an issue for the detail: what each side assumed, why it would
// have broken, the agreed fix and the votes. A timeline view lists the same events in order, for
// everyone or one agent. Reads the same rows as the evidence view (live or replay).
import React, { useMemo, useState } from 'react';
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
    const verification = [...rows.verification].sort((a, b) => num(b, 'id') - num(a, 'id'))[0];
    const review = verification ? rows.review.filter(r => num(r, 'verificationId') === num(verification, 'id')).sort((a, b) => num(b, 'id') - num(a, 'id'))[0] : undefined;
    const analyzing = rows.job.some(j => ['queued', 'leased'].includes(str(j, 'state')));
    return { lobby, describe, agents, items, issues, verification, review, analyzing };
  }, [rows]);
}

type Model = ReturnType<typeof useModel>;

function agentStatus(model: Model, rows: DashboardRows, agent: Row): { label: string; tone: 'working' | 'done' | 'member' } {
  if (rows.head.some(h => num(h, 'participantId') === num(agent, 'id'))) return { label: 'Done', tone: 'done' };
  if (agent.online && str(model.lobby, 'state', 'running') === 'running') return { label: 'Working', tone: 'working' };
  return { label: 'Member', tone: 'member' };
}

// Seats around the lobby, as percentages of the stage: upper left, upper right, bottom, then more.
const SEATS = [[20, 26], [80, 26], [50, 84], [12, 72], [88, 72], [50, 10]] as const;
const HUB = [50, 50] as const;

export function StoryView({ rows, mode, replayLabel }: { rows: DashboardRows; mode: string; replayLabel?: string }) {
  const model = useModel(rows);
  const [view, setView] = useState<'overview' | 'timeline'>('overview');
  const [openIssue, setOpenIssue] = useState<string | null>(null);
  const [filter, setFilter] = useState<number | 'all'>('all');
  const seatOf = (participantId: number) => {
    const index = model.agents.findIndex(a => num(a, 'id') === participantId);
    return index < 0 ? HUB : SEATS[index % SEATS.length]!;
  };
  const nameOf = (participantId: number) => str(model.agents.find(a => num(a, 'id') === participantId) ?? rows.participant.find(p => num(p, 'id') === participantId), 'name', `#${participantId}`);
  const providerOf = (participantId: number) => str(rows.participant.find(p => num(p, 'id') === participantId), 'provider');
  const issue = model.issues.find(i => i.key === openIssue);
  const failedRoot = model.verification && num(model.verification, 'passed') < num(model.verification, 'total')
    ? parse(str(model.review, 'findings', '{}')).rootCause as Row | undefined : undefined;
  const hiddenCulprit = failedRoot && mode !== 'dibs' ? model.agents.find(a => str(a, 'provider') === str(failedRoot, 'violator')) : undefined;
  const hot = new Map<number, Kind | 'agreed' | 'broken'>();
  for (const i of model.issues) for (const p of i.parties) {
    if (['proposed', 'escalated'].includes(i.state)) hot.set(p, i.kind);
    else if (i.state === 'accepted' && !hot.has(p)) hot.set(p, 'agreed');
  }
  if (hiddenCulprit) hot.set(num(hiddenCulprit, 'id'), 'broken');

  return <div className="story">
    <div className="story-toolbar">
      <div className="story-toolbar-left"><div className={`story-mode ${mode === 'dibs' ? 'on' : 'off'}`}><span />{mode === 'dibs' ? 'dibs on: agents share plans and agree first' : 'dibs off: each agent works alone'}</div>
        {replayLabel && <div className="story-replay">REPLAY · {replayLabel}</div>}</div>
      <div className="story-tabs" role="tablist">
        <button role="tab" aria-selected={view === 'overview'} className={view === 'overview' ? 'selected' : ''} onClick={() => setView('overview')}>Overview</button>
        <button role="tab" aria-selected={view === 'timeline'} className={view === 'timeline' ? 'selected' : ''} onClick={() => setView('timeline')}>Timeline</button>
      </div>
    </div>

    {view === 'overview' ? <div className="story-overview">
      <div className="stage">
        <svg className="stage-lines" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden>
          {model.agents.map(agent => {
            const [x, y] = seatOf(num(agent, 'id'));
            const shared = rows.plan.some(p => num(p, 'participantId') === num(agent, 'id'));
            return <line key={`hub-${str(agent, 'id')}`} x1={x} y1={y} x2={HUB[0]} y2={HUB[1]} className={`spoke ${shared ? 'shared' : ''}`} vectorEffect="non-scaling-stroke" />;
          })}
          {model.issues.map(i => {
            const [a, b] = i.parties;
            if (a === undefined || b === undefined) return null;
            const [x1, y1] = seatOf(a); const [x2, y2] = seatOf(b);
            const tone = i.state === 'accepted' ? 'agreed' : i.kind;
            return <line key={`edge-${i.key}`} x1={x1} y1={y1} x2={x2} y2={y2} className={`edge ${tone}`} vectorEffect="non-scaling-stroke" />;
          })}
        </svg>

        <div className={`hub ${model.analyzing ? 'analyzing' : ''}`} style={{ left: `${HUB[0]}%`, top: `${HUB[1]}%` }}>
          <div className="hub-ring" />
          <b>Lobby {str(model.lobby, 'id')}</b>
          <span>{model.analyzing ? 'comparing plans…' : `${model.agents.length} agents`}</span>
        </div>

        {model.issues.map(i => {
          const [a, b] = i.parties;
          if (a === undefined || b === undefined) return null;
          const [x1, y1] = seatOf(a); const [x2, y2] = seatOf(b);
          const agreed = i.state === 'accepted';
          return <button key={`label-${i.key}`} className={`edge-label ${agreed ? 'agreed' : i.kind}`} style={{ left: `${(x1 + x2) / 2}%`, top: `${(y1 + y2) / 2}%` }} onClick={() => setOpenIssue(i.key)}>
            {agreed ? 'Agreed ✓' : KIND_LABEL[i.kind]}<small>{i.label}</small>
          </button>;
        })}

        {model.agents.map(agent => {
          const id = num(agent, 'id');
          const [x, y] = seatOf(id);
          const status = agentStatus(model, rows, agent);
          const provider = str(agent, 'provider');
          const plan = rows.plan.filter(p => num(p, 'participantId') === id).sort((a, b) => num(b, 'revision') - num(a, 'revision'))[0];
          const mine = model.items.filter(item => num(item, 'participantId') === id);
          const state = hot.get(id);
          return <div key={id} className={`agent ${state ?? ''}`} style={{ left: `${x}%`, top: `${y}%` }}>
            <div className="agent-head">
              <div className={`avatar ${provider}`}>{PROVIDER_MARK[provider] ?? '?'}</div>
              <div className="agent-name"><b>{str(agent, 'name')}</b><span>{PROVIDER_LABEL[provider] ?? provider} · #{id}</span></div>
              <div className={`presence ${status.tone}`}><i />{status.label}</div>
            </div>
            {plan ? <p className="intent">{str(plan, 'goal')}</p> : <p className="intent pending">Hasn't shared a plan yet</p>}
            <ul className="claims">{mine.map(item => <li key={str(item, 'id')} className={str(item, 'kind')}>
              <span>{str(item, 'kind') === 'produces' ? 'Builds' : 'Needs'}</span>{model.describe(str(item, 'key'))}
            </li>)}</ul>
            {state === 'broken' && <div className="culprit">Its part didn't fit: {str(failedRoot, 'explanation')}</div>}
          </div>;
        })}
      </div>

      <aside className="issues">
        <div className="issues-head"><b>Issues</b><span>{model.issues.length ? `${model.issues.filter(i => i.state === 'accepted').length} of ${model.issues.length} resolved` : mode === 'dibs' ? 'none found yet' : 'not checked: dibs is off'}</span></div>
        {model.issues.map(i => <button key={i.key} className={`issue-card ${i.state === 'accepted' ? 'agreed' : i.kind}`} onClick={() => setOpenIssue(i.key)}>
          <span className="issue-kind">{i.state === 'accepted' ? 'Resolved' : KIND_LABEL[i.kind]}</span>
          <b>{i.label}</b>
          <p>{str(i.latest, 'rationale') || `${i.parties.map(nameOf).join(' and ')} disagree.`}</p>
          <span className="issue-votes">{i.parties.map(p => {
            const vote = i.votes.find(v => v.participantId === p);
            return <i key={p} className={vote?.decision ?? 'waiting'}>{nameOf(p)} {vote ? (vote.decision === 'accept' ? '✓ agreed' : '✗ pushed back') : '· waiting'}</i>;
          })}</span>
        </button>)}
        {!model.issues.length && <p className="issues-empty">{mode === 'dibs' ? 'When two agents assume different things about a shared part, or plan to build the same thing, it shows up here.' : 'With dibs off, nobody compares the plans. Problems only show up when the code is tested.'}</p>}
      </aside>
    </div> : <Timeline rows={rows} model={model} filter={filter} setFilter={setFilter} nameOf={nameOf} providerOf={providerOf} />}

    <Banner model={model} mode={mode} nameOf={nameOf} failedRoot={failedRoot} />

    {issue && <div className="drawer-backdrop" onClick={() => setOpenIssue(null)}>
      <aside className={`drawer ${issue.state === 'accepted' ? 'agreed' : issue.kind}`} onClick={event => event.stopPropagation()}>
        <button className="drawer-close" onClick={() => setOpenIssue(null)} aria-label="Close">×</button>
        <span className="issue-kind">{KIND_LABEL[issue.kind]} · {issue.state === 'accepted' ? 'resolved' : issue.state === 'proposed' ? 'voting' : issue.state}</span>
        <h2>{issue.label}</h2>
        <p className="drawer-lead">{str(issue.latest, 'rationale')}</p>
        <h3>What each agent assumed</h3>
        <div className="assumptions">{issue.cited.map(item => <div key={str(item, 'id')} className="assumption">
          <div className={`avatar small ${providerOf(num(item, 'participantId'))}`}>{PROVIDER_MARK[providerOf(num(item, 'participantId'))] ?? '?'}</div>
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
    </div>}
  </div>;
}

function Banner({ model, mode, nameOf, failedRoot }: { model: Model; mode: string; nameOf: (id: number) => string; failedRoot?: Row }) {
  const open = model.issues.find(i => ['proposed', 'escalated'].includes(i.state));
  let tone = 'idle'; let title = 'Waiting for agents to share their plans'; let detail = '';
  if (model.verification) {
    const passed = num(model.verification, 'passed'); const total = num(model.verification, 'total');
    if (passed === total) { tone = 'good'; title = `Works together ✓ All ${total} real-user checks passed`; detail = 'A hidden test used the combined app like a person would: log in, register, see the result.'; }
    else { tone = 'bad'; title = `Broken ✗ ${passed} of ${total} checks passed`; detail = str(failedRoot, 'explanation') || str(model.review, 'summary'); }
  } else if (open) {
    tone = open.kind;
    const agreed = open.votes.filter(v => v.decision === 'accept').length;
    title = `Resolving a ${KIND_LABEL[open.kind].toLowerCase()}: ${open.label}`;
    detail = `Voting in progress: ${agreed} of ${open.parties.length} agreed (${open.parties.map(p => `${nameOf(p)} ${open.votes.find(v => v.participantId === p) ? '✓' : '(waiting)'}`).join(', ')})`;
  } else if (model.analyzing) {
    tone = 'busy'; title = 'dibs is comparing the plans…'; detail = 'Looking for agents that assume different things, or plan the same work.';
  } else if (model.issues.length) {
    tone = 'good'; title = `Agreed on ${model.issues.map(i => i.label.toLowerCase()).join(' and ')}`; detail = 'Every agent involved accepted the fix. They are building to it now.';
  } else if (model.items.length) {
    title = mode === 'dibs' ? 'Plans shared. No problems found so far.' : 'Agents are building, each on its own guesses.';
  }
  return <div key={`${tone}-${title}`} className={`banner ${tone}`}><b>{title}</b>{detail && <span>{detail}</span>}</div>;
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
  contract_agreed: (_a, _d, subject) => `Locked in${subject ? `: ${subject.toLowerCase()}` : ''}.`,
  contract_aligned: (_a, _d, subject) => `Already compatible${subject ? `: ${subject.toLowerCase()}` : ''}. Nothing to vote on.`,
  fallback_reached: () => 'Time is up for talking. Anything not yet agreed falls back to sensible defaults.',
  proposal_superseded: () => 'A plan changed, so dibs withdrew an outdated proposal.',
  notice_sent: (_a, detail, subject) => detail.key ? `dibs noticed something nobody is building yet${subject ? `: ${subject.toLowerCase()}` : ''}.` : null,
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
  const entries = [...rows.event].sort((a, b) => num(a, 'atUs') - num(b, 'atUs')).map(event => {
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
    {!shown.length && <p className="issues-empty">Nothing yet.</p>}
  </div>;
}
