# Builds public/sim/team.json: a SIMULATED lobby (no backend, no real agents) in the replay
# export format, so the story view can show a bigger team with several polls.
# Run from the repo root: python3 apps/dashboard/sim/make-team.py
import json, os

T0 = 1792900000_000000
def S(sec): return T0 + int(sec * 1_000_000)
LOBBY = 900
vocab = [
    ("auth.session", "How users stay logged in"), ("api.orders", "The orders API format"),
    ("payments.checkout", "Taking payment at checkout"), ("search.products", "Product search"),
    ("notify.email", "Order confirmation emails"), ("db.schema", "The database tables"),
    ("ui.cart", "The shopping cart page"),
]
agents = [(1, "Claude A", "claude"), (2, "Codex A", "codex"), (3, "Droid A", "droid"),
          (4, "Claude B", "claude"), (5, "Codex B", "codex"), (6, "Droid B", "droid"), (7, "Claude C", "claude")]
name = {i: n for i, n, _ in agents}
participants = [dict(id=i, identity=f"sim-{i}", name=n, provider=p, role="agent", online=True, buildHash="sim", currentLobbyId=LOBBY) for i, n, p in agents]
events, plans, items, proposals, responses, contracts, jobs, heads = [], [], [], [], [], [], [], []
counters = dict(event=0, plan=100, item=200, job=300, proposal=400, response=500, contract=600)

def nxt(kind):
    counters[kind] += 1
    return counters[kind]

def ev(t, actor, typ, subject, detail=None):
    events.append(dict(id=nxt("event"), lobbyId=LOBBY, atUs=S(t), actor=actor, type=typ, subjectId=subject, detail=json.dumps(detail or {})))

def plan(t, a, goal, produces=(), requires=(), rev=1):
    p = nxt("plan")
    plans.append(dict(id=p, lobbyId=LOBBY, participantId=a, revision=rev, goal=goal, notes="simulated", requestId=f"sim-{p}", current=True, createdAtUs=S(t)))
    out = {}
    for kind, lst in (("produces", produces), ("requires", requires)):
        for key, text in lst:
            i = nxt("item")
            items.append(dict(id=i, planId=p, lobbyId=LOBBY, participantId=a, kind=kind, key=key, text=text, current=True))
            out[(kind, key)] = i
    ev(t, name[a], "plan_published", p, {"items": len(produces) + len(requires)})
    return out

def job(t0, t1):
    j = nxt("job")
    jobs.append(dict(id=j, slot=str(LOBBY), lobbyId=LOBBY, kind="analyze", state="done", inputKey="sim", leaseToken="", leaseExpiresUs=0, attempts=1, calls=1, error="", updatedAtUs=S(t1)))
    ev(t0, "system", "job_queued", j)
    ev(t0 + 1.5, "worker", "job_leased", j)
    ev(t1, "worker", "analysis_submitted", j)

def proposal(t, key, rev, relation, parties, cited, text, rationale, votes, close_state, close_t):
    p = nxt("proposal")
    proposals.append(dict(id=p, slot=f"closed/{p}", lobbyId=LOBBY, key=key, revision=rev, relation=relation, contractText=text, rationale=rationale,
                          citedItemIds=cited, requiredPartyIds=parties, state=close_state, inputKey="sim", createdAtUs=S(t), closedAtUs=S(close_t)))
    ev(t, "worker", "proposal_created", p, {"key": key, "revision": rev})
    for vt, a, decision, reason in votes:
        r = nxt("response")
        responses.append(dict(id=r, lobbyId=LOBBY, proposalId=p, revision=rev, participantId=a, decision=decision, reason=reason, requestId=f"r{r}", createdAtUs=S(vt)))
        ev(vt, name[a], "response_recorded", p, {"participantId": a, "decision": decision, "revision": rev})
    if close_state == "accepted":
        ev(close_t, "system", "proposal_accepted", p, {"handshake": f"{len(parties)}/{len(parties)}"})
        c = nxt("contract")
        contracts.append(dict(id=c, lobbyId=LOBBY, key=key, revision=rev, text=text, source="agreed", proposalId=p, basisItemIds=cited, current=True, createdAtUs=S(close_t)))
        ev(close_t, "system", "contract_agreed", c, {"key": key})
    else:
        no = next((v for v in votes if v[2] == "reject"), None)
        ev(close_t, name[no[1]] if no else "system", "proposal_rejected", p, {"reason": no[3] if no else ""})

ev(0, "system", "lobby_started", LOBBY)
for i, (a, _, _) in enumerate(agents[:6]):
    ev(4 + i * 3, name[a], "joined_lobby", a)
A = plan(20, 1, "Build the orders API and the database tables.",
         [("api.orders", "Orders API returns snake_case JSON: order_id, line_items, total_cents."), ("db.schema", "orders and order_items tables, money stored as integer cents.")],
         [("auth.session", "Requests carry the logged-in user.")])
B = plan(32, 2, "Build the shopping cart page and checkout screens.",
         [("ui.cart", "Cart page lists items and totals; Checkout button.")], [("api.orders", "Orders API returns camelCase JSON: orderId, lineItems, total in dollars.")])
C = plan(45, 3, "Handle payments at checkout.",
         [("payments.checkout", "POST /api/checkout charges the cart with the test payment provider.")], [("api.orders", "Read orders as orderId + lineItems.")])
D = plan(58, 4, "Build login and sessions.", [("auth.session", "httpOnly cookie session set by POST /api/login.")])
E = plan(70, 5, "Build checkout payments and the receipt.",
         [("payments.checkout", "POST /api/pay charges the card and returns a receipt.")], [("ui.cart", "Cart exposes a pay() hook.")])
F = plan(84, 6, "Send order confirmation emails.",
         [("notify.email", "Email on order placed, using the orders API.")], [("api.orders", "Order has an email field and total in dollars.")])
c = nxt("contract")
contracts.append(dict(id=c, lobbyId=LOBBY, key="db.schema", revision=1, text="orders and order_items tables, money in integer cents.", source="aligned",
                      proposalId=None, basisItemIds=[A[("produces", "db.schema")]], current=True, createdAtUs=S(110)))
ev(110, "worker", "contract_aligned", c, {"key": "db.schema"})

orders_cited = [A[("produces", "api.orders")], B[("requires", "api.orders")], C[("requires", "api.orders")], F[("requires", "api.orders")]]
# Poll 1: the orders API format. Four parties, one pushback, then a revised fix everyone accepts.
job(96, 108)
proposal(110, "api.orders", 1, "conflict", [1, 2, 3, 6], orders_cited,
         "Orders API uses camelCase JSON (orderId, lineItems) and money in dollars.",
         "Claude A returns snake_case and cents; Codex A, Droid A and Droid B expect camelCase, and two expect dollars.",
         [(124, 2, "accept", ""), (131, 3, "accept", ""), (139, 6, "accept", ""), (147, 1, "reject", "Money must stay in integer cents to avoid rounding errors.")], "rejected", 147)
job(148, 156)
proposal(158, "api.orders", 2, "conflict", [1, 2, 3, 6], orders_cited,
         "Orders API uses camelCase JSON (orderId, lineItems, email) and money as integer cents (totalCents); the UI formats dollars.",
         "Revised after Claude A's objection: keep cents, switch to camelCase, add email for Droid B.",
         [(170, 1, "accept", ""), (176, 6, "accept", ""), (183, 3, "accept", ""), (191, 2, "accept", "")], "accepted", 191)

# Poll 2: two agents both building checkout payments (redundancy). Droid A claimed it first.
job(160, 168)
proposal(172, "payments.checkout", 1, "duplicate", [3, 5], [C[("produces", "payments.checkout")], E[("produces", "payments.checkout")]],
         "Droid A keeps checkout payments (it claimed them first). Codex B moves to product search.", "Droid A and Codex B are both building checkout payments.",
         [(186, 3, "accept", ""), (199, 5, "accept", "")], "accepted", 199)
E2 = plan(212, 5, "Build product search.", [("search.products", "GET /api/search?q= returns products ranked by name match.")], rev=2)

# A late joiner: Claude C plans token login, contradicting Claude B's cookie session.
ev(250, "Claude C", "joined_lobby", 7)
G = plan(262, 7, "Add the mobile app login.", [("auth.session", "Login returns a bearer token for the mobile app.")], [("api.orders", "Orders API in camelCase.")])
job(268, 279)
proposal(281, "auth.session", 1, "conflict", [1, 4, 7], [D[("produces", "auth.session")], G[("produces", "auth.session")], A[("requires", "auth.session")]],
         "Keep the httpOnly cookie for the web app; the mobile app exchanges it for a short-lived token at /api/token.",
         "Claude B built cookie sessions; Claude C plans bearer tokens for the same login.",
         [(293, 4, "accept", ""), (301, 1, "accept", ""), (318, 7, "accept", "Fine, as long as /api/token exists for mobile.")], "accepted", 318)

# Poll 3: Claude B's next task duplicates Codex B's search.
H = plan(340, 4, "Build login and sessions, then product search.",
         [("auth.session", "httpOnly cookie session set by POST /api/login."), ("search.products", "Search inside the orders API.")], rev=2)
job(345, 353)
proposal(355, "search.products", 1, "duplicate", [4, 5], [H[("produces", "search.products")], E2[("produces", "search.products")]],
         "Codex B owns product search; Claude B stays on sessions and adds /api/token.", "Claude B and Codex B are both building product search.",
         [(368, 5, "accept", ""), (382, 4, "accept", "")], "accepted", 382)
plan(395, 4, "Build login, sessions and the mobile token exchange.", [("auth.session", "Cookie session plus /api/token for mobile.")], rev=3)

for t, a in [(640, 3), (655, 1), (670, 5), (688, 2), (701, 6), (716, 4), (734, 7)]:
    heads.append(dict(id=800 + a, lobbyId=LOBBY, participantId=a, sha=str(a) * 40, outOfAreaFiles=[], createdAtUs=S(t)))
    ev(t, name[a], "head_reported", 800 + a)
ev(900, "system", "lobby_stopped", LOBBY)

lobby = dict(id=LOBBY, scenario="Simulated team: online shop", mode="dibs", baseSha="0" * 40, vocabulary=[k for k, _ in vocab],
             vocabularyJson=json.dumps([{"key": k, "description": d} for k, d in vocab]), charter="Simulated.", buildHash="sim", state="stopped",
             analyzeAnywayFired=False, createdAtUs=S(0), startedAtUs=S(0), fallbackAtUs=S(360), endsAtUs=S(900))
out = dict(protocolVersion=1, label="SIMULATION · not a real run", lobbyId=LOBBY, exportedAtUs=S(905), tables=dict(
    lobby=[lobby], participant=participants, plan=plans, plan_item=items, message=[], job=jobs, proposal=proposals, response=responses,
    contract=contracts, delivery=[], event=sorted(events, key=lambda e: (e["atUs"], e["id"])), head=heads, verification=[], review=[],
    service=[dict(name="worker", lastBeatUs=S(900), detail="{}")]))
path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public", "sim", "team.json")
with open(path, "w") as f:
    json.dump(out, f, indent=1)
print("wrote", os.path.normpath(path), len(events), "events")
