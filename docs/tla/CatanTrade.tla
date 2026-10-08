----------------------------- MODULE CatanTrade -----------------------------
(***************************************************************************)
(* Player-to-player trading over an unreliable client→server channel       *)
(* (verification check V38c: AC17 and the idempotency part of AC21), per    *)
(* design §5.2 (commit path, actionId dedupe), §5.4 (offer id, replacement) *)
(* and ADR-0004/ADR-0008.                                                   *)
(*                                                                         *)
(* - Clients send intents that carry an actionId and may reference any      *)
(*   offer id seen so far. The network is a set that never forgets, so a    *)
(*   message can be delivered late, out of order, or many times.            *)
(* - The server records exactly one outcome per actionId. A redelivery      *)
(*   of a known actionId replays that outcome and changes nothing.          *)
(* - Offer flow follows R13: the active seat proposes {give, get}; other    *)
(*   seats accept (holding `get`); the proposer confirms with one accepting *)
(*   seat; holdings are validated at confirmation time. A new proposal      *)
(*   replaces the open offer under a fresh offer id. Accept, confirm and    *)
(*   cancel name the offer id; a non-open id → trade_not_found. End of turn *)
(*   withdraws the offer.                                                   *)
(* - Hands change outside trading through Spend (an abstract build or      *)
(*   maritime trade by the active seat in main), which makes offers stale.  *)
(* - Restart (design §5.2, §5.9): committed outcomes survive via            *)
(*   UNIQUE(game_id, action_id); cached rejections live in memory only      *)
(*   (PersistRejections = FALSE matches the design). `delivered` records    *)
(*   every outcome sent; AppliedAtMostOnce and OkOutcomeFinal check AC21.   *)
(* - Counter-offers (open question Q10) are not specified; the ASSUME       *)
(*   below keeps CounterOffers FALSE.                                       *)
(* - Phases (design §3.8, D18a/D18b): the turn moves through preRoll,       *)
(*   discard, moveRobber, main and gameOver. Rolls, discards, the robber,   *)
(*   a Knight from main and a win are abstract PhaseSteps. Leaving main     *)
(*   withdraws the open offer (OfferOnlyInMain). roadBuilding is not a     *)
(*   separate phase here: like moveRobber it leaves main with the same      *)
(*   active seat, so trade intents there get not_your_turn or wrong_phase   *)
(*   exactly as in moveRobber. Every intent is dispatched in the engine's   *)
(*   order: game_over → discard_pending → not_your_turn (role: accept from  *)
(*   a non-active seat, everything else from the active seat) →            *)
(*   wrong_phase (trade intents and endTurn are main-only) → the handler   *)
(*   codes. Design's delayed-trade traces (a)–(f) are action properties.    *)
(***************************************************************************)
EXTENDS Integers, FiniteSets, TLC

CONSTANTS N, Res, TotalPerRes, MaxOffers, ProposerMsgs, OtherMsgs, MaxSpends, CounterOffers,
          CheckOfferId,      \* TRUE: respond/confirm/cancel must name the open offer id
          PersistRejections, \* TRUE: rejected outcomes also survive a restart
          DurableCommits,    \* TRUE: committed actionIds survive a restart (UNIQUE(game_id, action_id))
          MaxRestarts,
          MaxPhaseSteps,     \* bound on abstract phase steps (roll, discards, robber, knight, win)
          RoleFirst          \* TRUE: D18a (role before phase); FALSE: the swapped order (mutant)

ASSUME CounterOffers = FALSE

Seats  == 0..N-1
NoSeat == -1

(* Seat 0 holds the first turn and sends ProposerMsgs messages; others send OtherMsgs. *)
MsgBudget == [s \in Seats |-> IF s = 0 THEN ProposerMsgs ELSE OtherMsgs]
NoOffer0 == 0   \* offer id meaning "no open offer"

VARIABLES phase, phaseSteps,
          hand, bank, active, offer, nextOfferId, net, outcome, sent, execs, spends,
          acceptLog,  \* history: <<seat, offer id named in the accept>> for every accepted accept
          delivered,  \* history: every <<actionId, outcome>> sent to a client
          restarts,
          committedSet, commitCount   \* history: actionIds applied, and how many applications

vars == <<phase, phaseSteps, hand, bank, active, offer, nextOfferId, net, outcome, sent, execs, spends, acceptLog,
          delivered, restarts, committedSet, commitCount>>

RECURSIVE SumOver(_, _)
SumOver(f, S) == IF S = {} THEN 0
                 ELSE LET x == CHOOSE x \in S : TRUE IN f[x] + SumOver(f, S \ {x})

Zero      == [r \in Res |-> 0]
Vecs      == [Res -> 0..1]
Leq(v, w) == \A r \in Res : v[r] <= w[r]
Add(v, w) == [r \in Res |-> v[r] + w[r]]
Sub(v, w) == [r \in Res |-> v[r] - w[r]]
Disjoint(v, w) == \A r \in Res : v[r] = 0 \/ w[r] = 0
NoOffer   == [id |-> NoOffer0, from |-> NoSeat, give |-> Zero, get |-> Zero, accepted |-> {}]
OfferIds  == 1..MaxOffers

(* Intents a client can compose. Seat 0 (active first) proposes, confirms, *)
(* cancels and ends the turn; other seats accept, which is enough to cover  *)
(* concurrent accepts. Malformed payloads and wrong-seat intents are       *)
(* covered by the fuzz and property checks (V11, V12, V21). MsgBudget[s]   *)
(* bounds how many messages seat s sends, keeping the model finite.        *)
ResponderIntents ==
    {[kind |-> "accept", oid |-> o, give |-> Zero, get |-> Zero, with |-> NoSeat] : o \in OfferIds}

ProposerIntents(s) ==
       {[kind |-> "propose", oid |-> NoOffer0, give |-> gh[1], get |-> gh[2], with |-> NoSeat] :
            gh \in {gh \in (Vecs \ {Zero}) \X (Vecs \ {Zero}) : Disjoint(gh[1], gh[2])}}
  \cup {[kind |-> "confirm", oid |-> o, give |-> Zero, get |-> Zero, with |-> t] :
            o \in OfferIds, t \in Seats \ {s}}
  \cup {[kind |-> "cancel",  oid |-> o, give |-> Zero, get |-> Zero, with |-> NoSeat] : o \in OfferIds}
  \cup {[kind |-> "endTurn", oid |-> NoOffer0, give |-> Zero, get |-> Zero, with |-> NoSeat]}
  \cup ResponderIntents   \* the proposer's own accept (D18 (3): not_your_turn)

Intents(s) == IF s = 0 THEN ProposerIntents(s) ELSE ResponderIntents

Phases == {"preRoll", "discard", "moveRobber", "main", "gameOver"}

Init ==
    /\ phase = "main"
    /\ phaseSteps = 0
    /\ hand = [s \in Seats |-> [r \in Res |-> 1]]
    /\ bank = [r \in Res |-> TotalPerRes - N]
    /\ active = 0
    /\ offer = NoOffer
    /\ nextOfferId = 1
    /\ net = {}
    /\ outcome = [a \in {} |-> "ok"]
    /\ sent = [s \in Seats |-> 0]
    /\ execs = [o \in OfferIds |-> 0]
    /\ spends = 0
    /\ acceptLog = {}
    /\ delivered = {}
    /\ restarts = 0
    /\ committedSet = {}
    /\ commitCount = 0

Send(s) ==
    /\ sent[s] < MsgBudget[s]
    /\ \E i \in Intents(s) :
         net' = net \cup {[aid |-> <<s, sent[s] + 1>>, seat |-> s, act |-> i]}
    /\ sent' = [sent EXCEPT ![s] = @ + 1]
    /\ UNCHANGED <<phase, phaseSteps, hand, bank, active, offer, nextOfferId, outcome, execs, spends, acceptLog,
                   delivered, restarts, committedSet, commitCount>>

(* Server-side effect of a fresh intent. Each disjunct either commits the   *)
(* change and records "ok", or records a rejection and changes nothing.     *)
Reject(m, code) ==
    /\ outcome' = outcome @@ (m.aid :> code)
    /\ UNCHANGED <<phase, hand, bank, active, offer, nextOfferId, execs>>

(* Role (engine maySubmit, D18a/D18b): accept from a non-active seat only;  *)
(* propose, confirm, cancel and endTurn from the active seat only.          *)
MaySubmit(s, kind) == IF kind = "accept" THEN s # active ELSE s = active

(* Phase table (engine PHASE_ACTIONS): every modelled intent is main-only.  *)
AllowedInPhase(kind, ph) == ph = "main"

(* The turn-level code of an intent, or "none" when it reaches its handler: *)
(* game_over → discard_pending → not_your_turn → wrong_phase (D18a). With   *)
(* RoleFirst = FALSE the role and phase checks are swapped (a mutant).      *)
TurnCode(m) ==
    LET s == m.seat
        k == m.act.kind
    IN  IF phase = "gameOver" THEN "game_over"
        ELSE IF phase = "discard" THEN "discard_pending"
        ELSE IF RoleFirst
             THEN IF ~MaySubmit(s, k) THEN "not_your_turn"
                  ELSE IF ~AllowedInPhase(k, phase) THEN "wrong_phase" ELSE "none"
             ELSE IF ~AllowedInPhase(k, phase) THEN "wrong_phase"
                  ELSE IF ~MaySubmit(s, k) THEN "not_your_turn" ELSE "none"

(* The handlers, reached only after the turn checks pass (main, right role). *)
Handle(m) ==
    LET s == m.seat
        a == m.act
    IN
    CASE a.kind = "propose" ->
           IF ~Disjoint(a.give, a.get) \/ ~Leq(a.give, hand[s]) THEN Reject(m, "invalid_trade")
           ELSE IF nextOfferId > MaxOffers THEN Reject(m, "model_bound")
           ELSE /\ offer' = [id |-> nextOfferId, from |-> s, give |-> a.give,
                             get |-> a.get, accepted |-> {}]
                /\ nextOfferId' = nextOfferId + 1
                /\ outcome' = outcome @@ (m.aid :> "ok")
                /\ UNCHANGED <<phase, hand, bank, active, execs>>
      [] a.kind = "accept" ->
           IF offer.id = NoOffer0 \/ (CheckOfferId /\ a.oid # offer.id) THEN Reject(m, "trade_not_found")
           ELSE IF ~Leq(offer.get, hand[s]) THEN Reject(m, "insufficient_resources")
           ELSE /\ offer' = [offer EXCEPT !.accepted = @ \cup {s}]
                /\ acceptLog' = acceptLog \cup {<<s, a.oid>>}
                /\ outcome' = outcome @@ (m.aid :> "ok")
                /\ UNCHANGED <<phase, hand, bank, active, nextOfferId, execs>>
      [] a.kind = "confirm" ->
           IF offer.id = NoOffer0 \/ a.oid # offer.id THEN Reject(m, "trade_not_found")
           ELSE IF a.with \notin offer.accepted THEN Reject(m, "trade_not_accepted")
           ELSE IF ~Leq(offer.give, hand[s]) \/ ~Leq(offer.get, hand[a.with]) THEN Reject(m, "trade_stale")
           ELSE /\ hand' = [hand EXCEPT ![s]      = Add(Sub(@, offer.give), offer.get),
                                        ![a.with] = Add(Sub(@, offer.get), offer.give)]
                /\ execs' = [execs EXCEPT ![offer.id] = @ + 1]
                /\ offer' = NoOffer
                /\ outcome' = outcome @@ (m.aid :> "ok")
                /\ UNCHANGED <<phase, bank, active, nextOfferId>>
      [] a.kind = "cancel" ->
           IF offer.id = NoOffer0 \/ a.oid # offer.id THEN Reject(m, "trade_not_found")
           ELSE /\ offer' = NoOffer
                /\ outcome' = outcome @@ (m.aid :> "ok")
                /\ UNCHANGED <<phase, hand, bank, active, nextOfferId, execs>>
      [] a.kind = "endTurn" ->
           (* The next seat's turn starts in preRoll; leaving main withdraws the offer. *)
           /\ active' = (s + 1) % N
           /\ phase' = "preRoll"
           /\ offer' = NoOffer
           /\ outcome' = outcome @@ (m.aid :> "ok")
           /\ UNCHANGED <<hand, bank, nextOfferId, execs>>

Apply(m) == IF TurnCode(m) # "none" THEN Reject(m, TurnCode(m)) ELSE Handle(m)

Deliver ==
    \E m \in net :
       /\ m.aid \notin DOMAIN outcome
       /\ Apply(m)
       /\ IF m.act.kind = "accept" /\ outcome'[m.aid] = "ok" THEN TRUE ELSE UNCHANGED acceptLog
       /\ delivered' = delivered \cup {<<m.aid, outcome'[m.aid]>>}
       /\ IF outcome'[m.aid] = "ok"
            THEN /\ committedSet' = committedSet \cup {m.aid}
                 /\ commitCount' = commitCount + 1
            ELSE UNCHANGED <<committedSet, commitCount>>
       /\ UNCHANGED <<phaseSteps, net, sent, spends, restarts>>

(* Redelivery of a decided actionId replays the stored outcome. It is a     *)
(* stuttering step for game state and is listed to make the case explicit.  *)
Redeliver ==
    \E m \in net : m.aid \in DOMAIN outcome /\ UNCHANGED vars

(* Process restart: game state and committed outcomes are durable; cached  *)
(* rejections are lost unless PersistRejections.                           *)
Restart ==
    /\ restarts < MaxRestarts
    /\ restarts' = restarts + 1
    /\ outcome' = IF PersistRejections THEN outcome
                  ELSE IF DurableCommits THEN [a \in {x \in DOMAIN outcome : outcome[x] = "ok"} |-> "ok"]
                  ELSE [a \in {} |-> "ok"]
    /\ UNCHANGED <<phase, phaseSteps, hand, bank, active, offer, nextOfferId, net, sent, execs, spends,
                   acceptLog, delivered, committedSet, commitCount>>

(* The active seat spends cards outside trading (build or maritime trade).  *)
Spend ==
    /\ phase = "main"
    /\ spends < MaxSpends
    /\ \E r \in Res :
         /\ hand[active][r] > 0
         /\ hand' = [hand EXCEPT ![active][r] = @ - 1]
         /\ bank' = [bank EXCEPT ![r] = @ + 1]
    /\ spends' = spends + 1
    /\ UNCHANGED <<phase, phaseSteps, active, offer, nextOfferId, net, outcome, sent, execs, acceptLog,
                   delivered, restarts, committedSet, commitCount>>

(* Abstract phase steps (CatanCore has the details): a roll from preRoll    *)
(* (main, or a 7 into discard or straight to moveRobber), the last discard, *)
(* the robber move back to main, a Knight from main, and a win from main.   *)
(* Leaving main withdraws the open offer.                                   *)
PhaseNext ==
    { <<"preRoll", "main">>, <<"preRoll", "discard">>, <<"preRoll", "moveRobber">>,
      <<"discard", "moveRobber">>, <<"moveRobber", "main">>,
      <<"main", "moveRobber">>, <<"main", "gameOver">> }

PhaseStep ==
    /\ phaseSteps < MaxPhaseSteps
    /\ \E t \in PhaseNext :
         /\ t[1] = phase
         /\ phase' = t[2]
         /\ offer' = IF t[1] = "main" THEN NoOffer ELSE offer
    /\ phaseSteps' = phaseSteps + 1
    /\ UNCHANGED <<hand, bank, active, nextOfferId, net, outcome, sent, execs, spends, acceptLog,
                   delivered, restarts, committedSet, commitCount>>

Next == (\E s \in Seats : Send(s)) \/ Deliver \/ Redeliver \/ Spend \/ Restart \/ PhaseStep

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
TypeOK ==
    /\ phase \in Phases
    /\ hand \in [Seats -> [Res -> 0..TotalPerRes]]
    /\ active \in Seats
    /\ offer.id \in OfferIds \cup {NoOffer0}
    /\ execs \in [OfferIds -> Nat]

Conservation ==
    \A r \in Res : bank[r] + SumOver([s \in Seats |-> hand[s][r]], Seats) = TotalPerRes

AtMostOneExecutionPerOffer == \A o \in OfferIds : execs[o] <= 1

OpenOfferBelongsToActive == offer.id # NoOffer0 => offer.from = active

(* An offer is open only in main (§6.2: leaving main withdraws it).        *)
OfferOnlyInMain == offer.id # NoOffer0 => phase = "main"


AcceptorsAreOthers == offer.accepted \subseteq Seats \ {offer.from}

(* Every seat counted as accepting the open offer accepted that exact offer. *)
AcceptBoundToOffer == \A s \in offer.accepted : <<s, offer.id>> \in acceptLog

(* No gifts: an open offer always has both sides non-empty and disjoint.   *)
OfferWellFormed ==
    offer.id # NoOffer0 => /\ offer.give # Zero /\ offer.get # Zero
                       /\ Disjoint(offer.give, offer.get)

(* Strict form: a client never sees two different outcomes for one actionId. *)
(* AC21 does not require it: it holds only with PersistRejections, and      *)
(* TradeRestart.cfg shows the trace where a re-evaluated rejection differs. *)
OneOutcomePerActionId ==
    \A x, y \in delivered : x[1] = y[1] => x[2] = y[2]

(* AC21: an actionId is applied at most once, and once it has an ok        *)
(* outcome every later outcome for it is ok. A rejected actionId may be      *)
(* re-evaluated after a restart or cache eviction.                          *)
AppliedAtMostOnce == Cardinality(committedSet) = commitCount

OkOutcomeFinal ==
    [][\A a \in DOMAIN outcome :
         outcome[a] = "ok" => \A d \in delivered' \ delivered : d[1] = a => d[2] = "ok"]_vars

(* An actionId is committed (applied) at most once: execs ≤ 1 per offer and *)
(* committed outcomes are never dropped.                                   *)
CommittedOutcomesDurable ==
    [][\A a \in DOMAIN outcome : outcome[a] = "ok" => (a \in DOMAIN outcome' /\ outcome'[a] = "ok")]_vars
---------------------------------------------------------------------------
(* Design's delayed-trade traces (D18a/D18b), as action properties over the *)
(* outcome a message receives when it is first decided. Each is stated     *)
(* from the trace, independently of TurnCode/Handle above.                  *)
Decided(m) == m.aid \notin DOMAIN outcome /\ m.aid \in DOMAIN outcome'
Got(m)     == outcome'[m.aid]
Turnish(ph) == ph \notin {"discard", "gameOver"}

(* (a) a respond from a non-active seat in a turn phase other than main    *)
(* (preRoll, moveRobber) → wrong_phase.                                     *)
TraceA == [][\A m \in net : (Decided(m) /\ m.act.kind = "accept" /\ Turnish(phase) /\ phase # "main" /\ m.seat # active)
                              => Got(m) = "wrong_phase"]_vars
(* (b) anything delivered during discard → discard_pending.                 *)
TraceB == [][\A m \in net : (Decided(m) /\ phase = "discard") => Got(m) = "discard_pending"]_vars
(* (c) + self-accept: a respond from the active seat (the proposer or a     *)
(* former addressee whose turn it now is), in any turn phase → not_your_turn.*)
TraceC == [][\A m \in net : (Decided(m) /\ m.act.kind = "accept" /\ m.seat = active /\ Turnish(phase))
                              => Got(m) = "not_your_turn"]_vars
(* (d) a respond in main from a non-active seat naming no open offer →      *)
(* trade_not_found.                                                         *)
TraceD == [][\A m \in net : (Decided(m) /\ m.act.kind = "accept" /\ phase = "main" /\ m.seat # active
                               /\ (offer.id = NoOffer0 \/ (CheckOfferId /\ m.act.oid # offer.id)))
                              => Got(m) = "trade_not_found"]_vars
(* (e) a confirm or cancel from a seat that is not active (e.g. the old     *)
(* proposer after endTurn), in any turn phase → not_your_turn.              *)
TraceE == [][\A m \in net : (Decided(m) /\ m.act.kind \in {"confirm", "cancel"} /\ m.seat # active /\ Turnish(phase))
                              => Got(m) = "not_your_turn"]_vars
(* (f) the active seat's confirm in main: trade_not_found → trade_not_accepted → trade_stale. *)
TraceF == [][\A m \in net : (Decided(m) /\ m.act.kind = "confirm" /\ m.seat = active /\ phase = "main")
                              => Got(m) = IF offer.id = NoOffer0 \/ m.act.oid # offer.id THEN "trade_not_found"
                                          ELSE IF m.act.with \notin offer.accepted THEN "trade_not_accepted"
                                          ELSE IF ~Leq(offer.give, hand[m.seat]) \/ ~Leq(offer.get, hand[m.act.with])
                                               THEN "trade_stale" ELSE "ok"]_vars
(* game_over precedes everything.                                           *)
TraceGameOver == [][\A m \in net : (Decided(m) /\ phase = "gameOver") => Got(m) = "game_over"]_vars

(* Cover properties: each must FAIL (TLC prints a trace), showing that the   *)
(* corresponding trace is reachable. Checked by the Cover*.cfg models.     *)
NeverA == [][~\E m \in net : Decided(m) /\ m.act.kind = "accept" /\ phase = "preRoll" /\ m.seat # active]_vars
NeverB == [][~\E m \in net : Decided(m) /\ phase = "discard"]_vars
NeverSelfAccept == [][~\E m \in net : Decided(m) /\ m.act.kind = "accept" /\ m.seat = active /\ m.seat = 0 /\ phase = "main"]_vars
NeverC == [][~\E m \in net : Decided(m) /\ m.act.kind = "accept" /\ m.seat = active /\ m.seat # 0 /\ phase = "main"]_vars
NeverD == [][~\E m \in net : Decided(m) /\ m.act.kind = "accept" /\ phase = "main" /\ m.seat # active /\ offer.id = NoOffer0 /\ active # 0]_vars
NeverE == [][~\E m \in net : Decided(m) /\ m.act.kind \in {"confirm", "cancel"} /\ m.seat # active /\ phase = "preRoll"]_vars
NeverFStale == [][~\E m \in net : Decided(m) /\ Got(m) = "trade_stale"]_vars
NeverGameOver == [][~\E m \in net : Decided(m) /\ phase = "gameOver"]_vars
(* An offer is open when the turn leaves main: by endTurn (to preRoll), or by *)
(* a PhaseStep (to moveRobber or gameOver). The engine must withdraw it.      *)
NeverWithdrawEnd == [][~(offer.id # NoOffer0 /\ phase = "main" /\ phase' = "preRoll")]_vars
NeverWithdrawStep == [][~(offer.id # NoOffer0 /\ phase = "main" /\ phase' \notin {"main", "preRoll"})]_vars
=============================================================================
