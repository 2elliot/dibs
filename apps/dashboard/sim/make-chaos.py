# Builds public/sim/chaos.json: a deliberately ridiculous SIMULATED lobby (no backend, no real
# agents). Lots of agents, lots of shared topics, and polls overlapping all the time, just to
# stress and show off the story view. Run from the repo root: python3 apps/dashboard/sim/make-chaos.py
import json, os, random

random.seed(13)
T0 = 1793000000_000000
def S(sec): return T0 + int(sec * 1_000_000)
LOBBY = 999
DURATION = 600

topics = [
    ("auth.session", "How users stay logged in"), ("api.orders", "The orders API format"), ("payments.checkout", "Taking payment at checkout"),
    ("search.products", "Product search"), ("notify.email", "Order confirmation emails"), ("db.schema", "The database tables"),
    ("ui.cart", "The shopping cart page"), ("ui.theme", "Colours and fonts"), ("api.users", "The users API"),
    ("inventory.stock", "Stock levels"), ("shipping.rates", "Shipping prices"), ("i18n.strings", "Translations"),
    ("analytics.events", "Tracking events"), ("cache.layer", "The cache"), ("feature.flags", "Feature flags"),
    ("reviews.api", "Product reviews"), ("images.cdn", "Product images"), ("admin.panel", "The admin panel"),
    ("errors.format", "How errors look"), ("rate.limits", "Rate limiting"), ("mobile.api", "The mobile app API"),
    ("tax.rules", "Sales tax"), ("coupons", "Discount codes"), ("audit.log", "The audit log"),
]
keys = [k for k, _ in topics]
providers = ["claude", "codex", "droid"]
letters = "ABCDEFGH"
agents = []
for i in range(18):
    provider = providers[i % 3]
    agents.append((i + 1, f"{provider.capitalize()} {letters[i // 3]}", provider))
name = {a: n for a, n, _ in agents}
join_at = {a: (5 + i * 6 if i < 12 else 150 + (i - 12) * 35) for i, (a, _, _) in enumerate(agents)}

events, plans, items, proposals, responses, contracts, jobs, heads = [], [], [], [], [], [], [], []
counters = dict(event=0, plan=1000, item=5000, job=300, proposal=10000, response=20000, contract=30000)
def nxt(kind):
    counters[kind] += 1
    return counters[kind]
def ev(t, actor, typ, subject, detail=None):
    events.append(dict(id=nxt("event"), lobbyId=LOBBY, atUs=S(t), actor=actor, type=typ, subjectId=subject, detail=json.dumps(detail or {})))

GOALS = ["Build {}.", "Own {} end to end.", "Refactor {}.", "Add tests for {}.", "Speed up {}.", "Make {} work on mobile."]
# Which agents currently claim which topics, as (time, agent) -> {key: (kind, item id)}
current = {}
revision = {a: 0 for a, _, _ in agents}

def publish(t, a):
    revision[a] += 1
    p = nxt("plan")
    chosen = random.sample(keys, random.randint(2, 4))
    main = dict(topics)[chosen[0]].lower()
    plans.append(dict(id=p, lobbyId=LOBBY, participantId=a, revision=revision[a], goal=random.choice(GOALS).format(main), notes="simulated",
                      requestId=f"sim-{p}", current=True, createdAtUs=S(t)))
    mine = {}
    for j, key in enumerate(chosen):
        kind = "produces" if j < 2 or random.random() < 0.4 else "requires"
        i = nxt("item")
        items.append(dict(id=i, planId=p, lobbyId=LOBBY, participantId=a, kind=kind, key=key, text=f"{name[a]} {('builds' if kind == 'produces' else 'needs')} {dict(topics)[key].lower()} its own way (#{i}).", current=True))
        mine[key] = (kind, i)
    current[a] = mine
    ev(t, name[a], "plan_published", p, {"items": len(chosen)})

def holders(key):
    return [(a, v[key]) for a, v in current.items() if key in v]

# Agents join and publish, then republish every 60–140 s (which reshuffles the graph).
schedule = []
for a, _, _ in agents:
    t = join_at[a]
    schedule.append((t, "join", a))
    t += random.uniform(4, 12)
    while t < DURATION - 120:
        schedule.append((t, "plan", a))
        t += random.uniform(60, 140)
# A poll starts somewhere every 4–9 s.
t = 40.0
while t < DURATION - 60:
    schedule.append((t, "poll", None))
    t += random.uniform(4, 9)
schedule.sort(key=lambda x: x[0])

open_until = {}  # key -> time the current poll on it finishes
for t, what, a in schedule:
    if what == "join":
        ev(t, name[a], "joined_lobby", a)
    elif what == "plan":
        publish(t, a)
    else:
        candidates = [k for k in keys if len(holders(k)) >= 2 and open_until.get(k, 0) < t]
        if not candidates:
            continue
        key = random.choice(candidates)
        hs = holders(key)[:6]
        parties = [h[0] for h in hs]
        cited = [h[1][1] for h in hs]
        produces = [h for h in hs if h[1][0] == "produces"]
        relation = "duplicate" if len(produces) >= 2 and random.random() < 0.45 else random.choice(["conflict", "conflict", "dependency"])
        label = dict(topics)[key].lower()
        j = nxt("job"); jobs.append(dict(id=j, slot=str(LOBBY), lobbyId=LOBBY, kind="analyze", state="done", inputKey="sim", leaseToken="", leaseExpiresUs=0,
                                           attempts=1, calls=1, error="", updatedAtUs=S(t - 0.5)))
        ev(t - 3, "system", "job_queued", j); ev(t - 2.5, "worker", "job_leased", j); ev(t - 0.5, "worker", "analysis_submitted", j)
        rev, start = 1, t
        while True:
            p = nxt("proposal")
            winner = name[parties[0]]
            text = {"duplicate": f"{winner} keeps {label}; the others move on.", "conflict": f"Everyone follows {winner}'s version of {label}.",
                    "dependency": f"{winner} publishes {label} first; the others build against it."}[relation]
            rationale = {"duplicate": f"{len(parties)} agents are building {label}.", "conflict": f"{len(parties)} agents assume different things about {label}.",
                         "dependency": f"{len(parties) - 1} agents need {label} before it exists."}[relation]
            reject = rev == 1 and random.random() < 0.35
            votes, vt = [], start
            order = parties[:]; random.shuffle(order)
            for k, v in enumerate(order):
                vt += random.uniform(2.5, 7)
                no = reject and k == len(order) - 1
                votes.append((vt, v, "reject" if no else "accept", random.choice(["Not like that.", "Mine is better.", "That breaks my part.", "Need a different shape."]) if no else ""))
            close = vt + 1
            proposals.append(dict(id=p, slot=f"closed/{p}", lobbyId=LOBBY, key=key, revision=rev, relation=relation, contractText=text, rationale=rationale,
                                  citedItemIds=cited, requiredPartyIds=parties, state="rejected" if reject else "accepted", inputKey="sim", createdAtUs=S(start), closedAtUs=S(close)))
            ev(start, "worker", "proposal_created", p, {"key": key, "revision": rev})
            for vtime, v, decision, reason in votes:
                r = nxt("response")
                responses.append(dict(id=r, lobbyId=LOBBY, proposalId=p, revision=rev, participantId=v, decision=decision, reason=reason, requestId=f"r{r}", createdAtUs=S(vtime)))
                ev(vtime, name[v], "response_recorded", p, {"participantId": v, "decision": decision, "revision": rev})
            if reject:
                ev(close, name[votes[-1][1]], "proposal_rejected", p, {"reason": votes[-1][3]})
                rev, start = 2, close + 4
                continue
            ev(close, "system", "proposal_accepted", p, {"handshake": f"{len(parties)}/{len(parties)}"})
            c = nxt("contract")
            contracts.append(dict(id=c, lobbyId=LOBBY, key=key, revision=rev, text=text, source="agreed", proposalId=p, basisItemIds=cited, current=True, createdAtUs=S(close)))
            ev(close, "system", "contract_agreed", c, {"key": key})
            open_until[key] = close
            break

for a, _, _ in agents:
    if random.random() < 0.8:
        t = random.uniform(DURATION - 110, DURATION - 10)
        heads.append(dict(id=900 + a, lobbyId=LOBBY, participantId=a, sha=format(a, "x") * 40, outOfAreaFiles=[], createdAtUs=S(t)))
        ev(t, name[a], "head_reported", 900 + a)
ev(DURATION, "system", "lobby_stopped", LOBBY)

participants = [dict(id=a, identity=f"sim-{a}", name=n, provider=p, role="agent", online=True, buildHash="sim", currentLobbyId=LOBBY) for a, n, p in agents]
lobby = dict(id=LOBBY, scenario="Simulated chaos", mode="dibs", baseSha="0" * 40, vocabulary=keys, vocabularyJson=json.dumps([{"key": k, "description": d} for k, d in topics]),
             charter="Simulated.", buildHash="sim", state="stopped", analyzeAnywayFired=False, createdAtUs=S(0), startedAtUs=S(0), fallbackAtUs=S(360), endsAtUs=S(DURATION))
out = dict(protocolVersion=1, label="SIMULATION · chaos mode, not a real run", lobbyId=LOBBY, exportedAtUs=S(DURATION + 5), tables=dict(
    lobby=[lobby], participant=participants, plan=plans, plan_item=items, message=[], job=jobs, proposal=proposals, response=responses, contract=contracts,
    delivery=[], event=sorted(events, key=lambda e: (e["atUs"], e["id"])), head=heads, verification=[], review=[], service=[dict(name="worker", lastBeatUs=S(DURATION), detail="{}")]))
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "sim", "chaos.json")
with open(path, "w") as f:
    json.dump(out, f)
print("wrote", os.path.normpath(path), len(agents), "agents,", len(plans), "plans,", len(proposals), "proposals,", len(events), "events")
