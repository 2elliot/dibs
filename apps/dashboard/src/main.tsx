import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DELIVERY_STAGES, MODES, PROVIDERS, RELATIONS, type AssembledFrom, type DibsConfig, type EventsExport, type Mode, type Provider, type Relation, type ReviewFindings } from '@dibs/protocol';
import { createLiveSource, emptyRows, loadReplay, ReplayLobbySource, type DashboardRows, type LobbySource } from './source';
import dibsFixture from '../fixtures/s2-dibs.json';
import noneFixture from '../fixtures/s2-none.json';
import './style.css';
import './evidence.css';

const providers = PROVIDERS;
const providerNames: Record<Provider,string> = { claude: 'Claude', codex: 'Codex', droid: 'Droid' };
const modeNames: Record<Mode,string> = { none: 'None', chat: 'Chat', dibs: 'dibs' };
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const str = (row: Record<string, unknown>, key: string, fallback = '') => String(row[key] ?? fallback);
const num = (row: Record<string, unknown>, key: string) => Number(row[key] ?? 0);
// A lobby can be verified more than once (lobby 7: a premature run before every head was pushed);
// the newest verification is the result, older ones are shown as superseded.
const latestVerification = (rows: Record<string, unknown>[]) => rows.reduce((a, b) => (num(b,'id') > num(a,'id') ? b : a));
const parseJson = <T,>(value: unknown, fallback: T): T => { try { return typeof value === 'string' ? JSON.parse(value) as T : (value as T) ?? fallback; } catch { return fallback; } };
const timeLabel = (us: number) => new Date(us / 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

function useSource(source: LobbySource | null): DashboardRows {
  const [rows, setRows] = useState<DashboardRows>(emptyRows);
  useEffect(() => {
    if (!source) { setRows(emptyRows()); return; }
    const refresh = () => setRows(source.getSnapshot());
    refresh();
    return source.subscribe(refresh);
  }, [source]);
  return rows;
}

function App() {
  const params = new URLSearchParams(location.search);
  const replayUrl = params.get('replay');
  const [source, setSource] = useState<LobbySource | null>(null);
  const [error, setError] = useState('');
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [clock, setClock] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [panelView, setPanelView] = useState<'contracts' | 'proof'>('contracts');
  const rows = useSource(source);
  const replay = source instanceof ReplayLobbySource ? source : null;
  const snapshot = replay ? replay.getSnapshot(clock || replay.startUs) : rows;
  const lobby = obj(snapshot.lobby[0]);
  const events = [...snapshot.event].sort((a,b) => num(b,'atUs') - num(a,'atUs'));
  const participants = snapshot.participant;
  // The worker heartbeats under its own participant name (the module only accepts the caller's
  // name), so the live row is `worker`; older replay exports call it `analysis`.
  const service = snapshot.service.find(row => row.name === 'worker') ?? snapshot.service.find(row => row.name === 'analysis');
  const mode = MODES.find(candidate => candidate === str(lobby,'mode'));
  const replayTimeUs = replay ? (clock || replay.endUs) : Date.now() * 1000;
  const analysisOnline = Boolean(service && num(service,'lastBeatUs') > 0 && Math.abs(replayTimeUs-num(service,'lastBeatUs')) < 60_000_000);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (replayUrl) {
          const loaded = await loadReplay(replayUrl);
          if (active) { setSource(loaded); setClock(loaded.endUs); }
          return;
        }
        const config = await fetch('/config.json').then(response => response.ok ? response.json() : {}) as Partial<DibsConfig> & { uri?: string; db?: string; lobby?: string | number };
        const uri = params.get('uri') || config.uri || config.dbUri;
        const db = params.get('db') || config.db || config.dbName;
        const requestedLobby = params.get('lobby') || config.lobby;
        const lobbyId = requestedLobby == null || requestedLobby === '' ? undefined : Number(requestedLobby);
        const requestedLive = params.has('uri') || params.has('db') || params.has('lobby') || Boolean(uri || db || requestedLobby);
        if (lobbyId !== undefined && (!Number.isInteger(lobbyId) || lobbyId <= 0 || lobbyId > 0xffffffff)) {
          throw new Error('Lobby must be a positive integer ID.');
        }
        if (!uri || !db) {
          if (requestedLive) throw new Error('Set uri and db to connect to live lobbies.');
          const fixture = location.hash === '#none' ? noneFixture : dibsFixture;
          const local = new ReplayLobbySource(fixture as EventsExport);
          if (active) { setSource(local); setClock(local.endUs); }
          return;
        }
        const live = await createLiveSource(uri, db, lobbyId);
        if (active) setSource(live); else live.disconnect();
      } catch (cause) {
        if (!active) return;
        if (replayUrl) setError(cause instanceof Error ? cause.message : String(cause));
        else setError(`Not connected: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    })();
    return () => { active = false; };
  }, []);

  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => {
    if (!playing || !replay) return;
    const timer = window.setInterval(() => setClock(current => {
      const next = current + 5_000_000 * speed;
      if (next >= replay.endUs) { setPlaying(false); return replay.endUs; }
      return next;
    }), 250);
    return () => clearInterval(timer);
  }, [playing, replay, speed]);
  useEffect(() => () => source?.disconnect(), [source]);

  const keys = useMemo(() => [...new Set(snapshot.plan_item.map(item => str(item, 'key')))], [snapshot.plan_item]);
  const endAt = num(lobby, 'endsAtUs') / 1000;
  const displayedNow = replay ? (clock || replay.endUs) / 1000 : now;
  const countdown = endAt ? Math.max(0, Math.ceil((endAt - displayedNow) / 1000)) : 0;

  return <main className="dashboard">
    {source?.mode === 'replay' && <div className="replay-ribbon"><span>REPLAY</span><b>{source.label}</b></div>}
    <header className="lobby-header">
      <div className="brand-lockup"><div className="brand-mark">d</div><div><div className="eyebrow">COORDINATION, VERIFIED</div><h1>{str(lobby, 'scenario', 'dibs lobby')}</h1></div></div>
      <div className="header-right"><div className="mode-chip"><span className="live-dot" />{mode ? modeNames[mode] : 'Not connected'}</div><div className="countdown"><span>TIME REMAINING</span><strong>{String(Math.floor(countdown/60)).padStart(2,'0')}:{String(countdown%60).padStart(2,'0')}</strong></div></div>
      <div className="header-status"><div className="provider-list">{providers.map(provider => {
        const person = participants.find(p => p.provider === provider);
        return <div className={`provider-pill ${person?.online ? 'online' : 'offline'}`} key={provider}><i className={`provider-icon ${provider}`} />{providerNames[provider]}<span>{person?.online ? 'ONLINE' : 'OFFLINE'}</span></div>;
      })}</div><div className={`analysis-status ${analysisOnline ? 'online' : ''}`}><span className="status-led"/>Analysis {analysisOnline ? 'online' : 'offline'}</div></div>
    </header>

    {error && <div className="error-banner">{error}</div>}
    {!source && <div className="loading-card">Connecting to the lobby…</div>}
    <nav className="panel-tabs" role="tablist" aria-label="Dashboard panels"><button role="tab" aria-selected={panelView==='contracts'} className={panelView==='contracts'?'selected':''} onClick={()=>setPanelView('contracts')}>Contracts</button><button role="tab" aria-selected={panelView==='proof'} className={panelView==='proof'?'selected':''} onClick={()=>setPanelView('proof')}>Handoff + Scorecard{snapshot.verification.length>0&&<i/>}</button></nav>
    <section className={`content-grid ${panelView==='proof'?'proof-view':''}`}>
      <section className={`panel timeline-panel ${panelView==='proof'?'hidden-for-proof':''}`} id="timeline"><div className="panel-heading"><div><span className="eyebrow">01 / ACTIVITY</span><h2>Timeline</h2></div><span className="count-badge">{events.length} events</span></div>
        <div className="timeline-list">{events.slice(0,8).map(event => <div className="timeline-entry" key={String(event.id)}><span className="timeline-time">{timeLabel(num(event,'atUs'))}</span><span className="timeline-dot"/><div><strong>{str(event,'actor')}</strong><span>{str(event,'type').replaceAll('_',' ')}</span></div></div>)}</div>
      </section>

      <section className={`panel contracts-panel ${panelView==='proof'?'hidden-for-proof':''}`}><div className="panel-heading"><div><span className="eyebrow">02 / AGREEMENT</span><h2>Contracts</h2></div><span className="hero-tag">THE HANDSHAKE</span></div>
        {keys.length ? keys.map(key => <ContractCard key={key} name={key} rows={snapshot} />) : <div className="empty-state"><span className="empty-icon">↗</span><h3>Plans are taking shape</h3><p>Published assumptions will appear here, side by side.</p></div>}
      </section>

      <section className={`panel handoff-panel ${panelView==='contracts'?'hidden-for-proof':''}`}><div className="panel-heading"><div><span className="eyebrow">03 / PROOF</span><h2>Handoff</h2></div><span className="count-badge">{snapshot.head.length} heads</span></div>
        <div className="handoff-flow"><div className="handoff-step"><b className="handoff-number">01</b><div><strong>Agent heads</strong><span>{snapshot.head.length ? snapshot.head.map(head => `${providerNames[str(participants.find(p => p.id === head.participantId) ?? {},'provider') as keyof typeof providerNames] ?? 'Agent'} · ${str(head,'sha').slice(0,7)}`).join(' · ') : 'Waiting for reports'}</span></div></div><div className="handoff-step"><b className="handoff-number">02</b><div><strong>Assembled tree</strong><span>{snapshot.verification.length ? 'Provider areas assembled from recorded heads' : 'Awaiting verification'}</span></div></div></div>
        {[...snapshot.verification].sort((x, y) => num(y,'id') - num(x,'id')).map((verification, index) => { const assembled = parseJson<AssembledFrom>(verification.assembledFrom, {}); const resultEvent=snapshot.event.find(event=>event.type==='verification_recorded'&&event.subjectId===verification.id);const resultDetail=obj(resultEvent?.detail);return <div className="verification-result" key={String(verification.id)} style={index ? {opacity:0.55} : undefined}>{index>0&&<span className="eyebrow">SUPERSEDED · VERIFICATION {num(verification,'id')}</span>}<div className="assembled-roots">{providers.map(provider=><span key={provider}>{providerNames[provider]} · {(assembled[provider] ?? 'pending').slice(0,7)}</span>)}</div><div className="result-top"><div><span className="eyebrow">MERGE TREE</span><strong>{verification.mergeTreeClean ? 'CLEAN' : 'CONFLICTS'}</strong></div><div className="oracle-score"><strong>{num(verification,'passed')}/{num(verification,'total')}</strong><span>ORACLE CHECKS</span></div></div><div className="oracle-meter"><i style={{width:`${num(verification,'total') ? num(verification,'passed')/num(verification,'total')*100 : 0}%`}}/></div>{typeof resultDetail.statusText==='string'&&<div className="failed-check">CHECK {str(resultDetail,'failingCheck')} · UI · {str(resultDetail,'statusText')}</div>}</div>})}
        {snapshot.review.map(review => <ReviewCard key={String(review.id)} review={review} />)}
      </section>

      <section className={`panel scorecard-panel ${panelView==='contracts'?'hidden-for-proof':''}`}><div className="panel-heading"><div><span className="eyebrow">04 / RUN RECORD</span><h2>Scorecard</h2></div><a href="#timeline" className="trace-link">VIEW TRACE ↗</a></div>
        <div className="score-row"><span className="run-label">1 run</span><div className="score-scenario"><strong>{str(lobby,'scenario','S2 — auth session transport')}</strong><span>{str(lobby,'mode','none').toUpperCase()} MODE</span></div><div className="score-checks"><strong>{snapshot.verification.length ? `${num(latestVerification(snapshot.verification),'passed')}/6` : '—'}</strong><span>CHECKS</span></div><div className="score-overhead"><strong>{elapsed(snapshot)}</strong><span>OVERHEAD</span></div></div>
      </section>
    </section>
    {replay && <ReplayControls replay={replay} time={clock || replay.startUs} playing={playing} setPlaying={setPlaying} setClock={setClock} speed={speed} setSpeed={setSpeed}/>}
  </main>;
}

function elapsed(rows: DashboardRows) { const first = rows.event.reduce((n,row)=>Math.min(n,num(row,'atUs')||Infinity),Infinity); const last = rows.event.reduce((n,row)=>Math.max(n,num(row,'atUs')),0); return Number.isFinite(first) && last ? `${Math.max(0,Math.round((last-first)/60_000_000))}m` : '—'; }

function ContractCard({name, rows}:{name:string;rows:DashboardRows}) {
  const items = rows.plan_item.filter(item => item.key === name);
  const parties = items.map(item => ({item, person: rows.participant.find(p => p.id === item.participantId)}));
  const proposal = [...rows.proposal].filter(p => p.key === name && RELATIONS.includes(str(p,'relation') as Relation)).sort((a,b)=>num(b,'revision')-num(a,'revision'))[0];
  const responses = proposal ? rows.response.filter(r => r.proposalId === proposal.id) : [];
  const priorRejection = [...rows.response].filter(response => response.decision === 'reject' && rows.proposal.some(previous => previous.id === response.proposalId && previous.key === name)).sort((a,b)=>num(b,'createdAtUs')-num(a,'createdAtUs'))[0];
  const required = proposal ? parseJson<number[]>(proposal.requiredPartyIds, []) : [];
  const accepted = responses.filter(response => response.decision === 'accept').length;
  const contract = rows.contract.find(c => c.key === name && c.current) ?? rows.contract.find(c => c.key === name);
  const cited = proposal ? parseJson<number[]>(proposal.citedItemIds, []) : [];
  return <article className="contract-card"><div className="key-label"><span className="key-dot"/>{name}<span className="key-conflict">{str(proposal??{},'relation',contract ? 'AGREED' : 'PLANS')}</span></div>
    <div className="plans-grid">{parties.map(({item,person})=><div className="plan-quote" key={String(item.id)}><span className="author-label"><i className={`provider-icon ${str(person ?? {},'provider')}`}/>{str(person ?? {},'name','Agent')} <em>{str(item,'kind')}</em></span><p>{str(item,'text')}</p></div>)}</div>
    {proposal && <div className="proposal-block"><div className="block-caption"><span>PROPOSAL · REV {num(proposal,'revision')}</span><span className={`proposal-state ${str(proposal,'state')}`}>{str(proposal,'state')}</span></div><div className="proposal-body"><div><span className="micro-label">RELATION</span><strong>{str(proposal,'relation')}</strong></div><div className="proposal-copy"><p>{str(proposal,'contractText')}</p><span>{str(proposal,'rationale')}</span></div></div><div className="citations">CITED {parties.filter(({item})=>cited.includes(num(item,'id'))).map(({person})=>str(person ?? {},'name')).join(' · ') || 'PLAN ITEMS'}</div>{priorRejection&&<div className="revision-note">↻ REV {num(priorRejection,'revision')} REJECTED · {str(rows.participant.find(p=>p.id===priorRejection.participantId)??{},'name','Agent')}: “{str(priorRejection,'reason')}”</div>}</div>}
    {proposal && <div className="handshake-row"><div className="handshake-count"><strong>HANDSHAKE {Math.min(accepted,required.length)}/{required.length || parties.length}</strong><span>{responses.some(r=>r.decision==='reject') ? 'REJECTION → REVISED' : 'REQUIRED PARTIES'}</span></div><div className="response-dots">{required.map(id=>{const person=rows.participant.find(p=>p.id===id);const response=responses.find(r=>r.participantId===id);return <span className={response?.decision==='accept'?'accepted':response?.decision==='reject'?'rejected':'pending'} title={str(person ?? {},'name')} key={id}>{response?.decision==='accept'?'✓':response?.decision==='reject'?'×':'·'}</span>})}</div></div>}
    {contract && <div className="final-contract"><div className="final-heading"><span>{str(contract,'source')==='aligned'?'ALIGNED CONTRACT':'FINAL CONTRACT'}</span><strong>✓ {str(contract,'source')==='aligned'?'ALIGNED':'AGREED'}</strong></div><p>{str(contract,'text')}</p><div className="delivery-stages">{parties.map(({person})=>{const targetId=num(person??{},'id');const deliveryKind=str(contract,'source')==='aligned'?'aligned':'contract';const delivery=rows.delivery.find(d=>d.targetId===targetId&&d.kind===deliveryKind&&d.refId===num(contract,'id'));const reached=DELIVERY_STAGES.indexOf(str(delivery??{},'stage') as typeof DELIVERY_STAGES[number]);return <div className="delivery-party" key={targetId}><span>{str(person??{},'name')}</span><div>{DELIVERY_STAGES.map((stage,index)=><React.Fragment key={stage}><i className={index<=reached?'reached':''} title={stage}/>{index<DELIVERY_STAGES.length-1&&<b className={index<reached?'reached':''}/>}</React.Fragment>)}</div><small>{reached>=0?DELIVERY_STAGES[reached]:'queued'}</small></div>})}</div></div>}
  </article>;
}

function ReviewCard({review}:{review:Record<string,unknown>}) {
  const findings=parseJson<ReviewFindings>(review.findings,{summary:str(review,'summary'),clauses:[],rootCause:null});
  return <div className="review-card"><div className="review-heading"><span className="droid-seal">D</span><div><span className="eyebrow">DROID SDK REVIEW</span><strong>{findings.summary || str(review,'summary')}</strong></div><span className="advisory">ADVISORY</span></div>{findings.clauses.map((clause,index)=><div className="clause-row" key={index}><span className={`clause-verdict ${clause.verdict}`}>{clause.verdict==='conforms'?'✓ conforms':clause.verdict==='violates'?'! violates':'— n/a'}</span><div><strong>{clause.key}</strong><span>{clause.clause}</span>{clause.evidence.map((evidence,i)=><small key={i}>{evidence.file}:{evidence.line} — {evidence.note}</small>)}</div></div>)}{findings.rootCause&&<div className="root-cause"><span>ROOT CAUSE · {findings.rootCause.violator.toUpperCase()}</span><p>{findings.rootCause.explanation}</p></div>}</div>;
}

function ReplayControls({replay,time,playing,setPlaying,setClock,speed,setSpeed}:{replay:ReplayLobbySource;time:number;playing:boolean;setPlaying:(v:boolean)=>void;setClock:(v:number)=>void;speed:number;setSpeed:(v:number)=>void}) {
  const percent=replay.endUs===replay.startUs?100:(time-replay.startUs)/(replay.endUs-replay.startUs)*100;
  return <footer className="replay-controls"><button className="play-button" onClick={()=>setPlaying(!playing)} aria-label={playing?'Pause replay':'Play replay'}>{playing?'Ⅱ':'▶'}</button><button className="step-button" onClick={()=>{setPlaying(false);setClock(Math.min(replay.endUs,time+60_000_000))}}>+1 MIN</button><span className="replay-time">{timeLabel(time)}</span><input aria-label="Replay timeline" type="range" min={replay.startUs} max={replay.endUs} value={time} onChange={event=>{setPlaying(false);setClock(Number(event.target.value))}} style={{'--progress':`${percent}%`} as React.CSSProperties}/><span className="replay-time">{timeLabel(replay.endUs)}</span><label className="speed-picker">SPEED <select value={speed} onChange={event=>setSpeed(Number(event.target.value))}><option value={0.5}>0.5×</option><option value={1}>1×</option><option value={2}>2×</option><option value={4}>4×</option></select></label></footer>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
