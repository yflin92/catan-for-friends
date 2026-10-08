----------------------------- MODULE CatanCore -----------------------------
(***************************************************************************)
(* Turn/phase machine (verification check V38a: AC10, AC11, AC17, AC18)   *)
(* and simultaneous discard (V38b: AC9). Follows design §6.1 (phase names,  *)
(* eligibility, transitions, invariants), §5.3 (seven → discard → robber,   *)
(* friendly-robber fallback) and §5.10 (system skipSeat loop, auto-robber). *)
(* Seats are 0-based as in ADR-0003.                                        *)
(*                                                                         *)
(* Abstractions:                                                           *)
(*  - Geometry is not modelled. Distance rule, connectivity, robber        *)
(*    adjacency and Longest Road length are property-tested (V5–V7).       *)
(*    Production is a nondeterministic claim of 0..1 per resource and seat.*)
(*  - A build costs one of each resource and is worth 1 VP. A build may    *)
(*    move Longest Road to any seat or to nobody (a settlement can break a  *)
(*    road and hand LR to a third seat). A free road may only give LR to    *)
(*    its owner.                                                            *)
(*  - Knights and Road Building cards are dealt to the seats in KnightSeats *)
(*    and RBSeats, one each.                                                *)
(*  - Domestic trade is an "offer open" flag; CatanTrade models its         *)
(*    messages (V38c).                                                      *)
(*  - Friendly robber uses a worst-case board: every hex except the desert  *)
(*    touches every seat.                                                   *)
(*  - skipSeat is one engine command that runs a loop (§5.10). The model    *)
(*    runs the loop as SkipStep micro-steps while `skipping` names the      *)
(*    skipped seat; no other action is enabled until the loop finishes, so  *)
(*    the loop is atomic. Presence and timing checks belong to the server   *)
(*    (V42); here any eligible seat may be skipped when SkipEnabled.        *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS
    N,                     \* number of seats (3 or 4)
    Res,                   \* resource kinds (reduced set)
    TotalPerRes,           \* cards per resource
    DiscardLimit,          \* a 7 forces discard when hand size > DiscardLimit
    VPTarget,              \* config.vpTarget
    MaxBuilt,              \* abstract VP-building supply per seat beyond setup
    Hexes,                 \* abstract robber locations; Desert is CHOOSE h \in Hexes
    KnightSeats,           \* seats dealt one Knight
    RBSeats,               \* seats dealt one Road Building card
    FreeRoadSupply,        \* supply.roads when Road Building is played
    BankRatio,
    FriendlyRobber,        \* config.friendlyRobber.enabled
    FriendlyMaxVp,         \* config.friendlyRobber.maxPublicVp
    LiftFriendlyIfStuck,   \* R9 fallback: lift the friendly restriction when no hex qualifies
    WinCheckAtTurnStart,   \* checkVictory runs inside beginTurn (R14, design §6.2)
    SkipEnabled            \* absencePolicy offers skipSeat (FALSE = pause)

Seats  == 0..N-1
NoSeat == -1
Desert == CHOOSE h \in Hexes : TRUE
Phases == {"setupSettlement", "setupRoad", "preRoll", "discard",
           "moveRobber", "main", "roadBuilding", "gameOver"}
SetupPhases == {"setupSettlement", "setupRoad"}

VARIABLES
    phase, active, setupIdx, hand, bank, owed, thenPhase, robber, returnPhase,
    offerOpen, devPlayed, knights, rbCards, rbLeft, roadsLeft,
    placed, built, lrHolder, skipping

vars == <<phase, active, setupIdx, hand, bank, owed, thenPhase, robber, returnPhase,
          offerOpen, devPlayed, knights, rbCards, rbLeft, roadsLeft,
          placed, built, lrHolder, skipping>>

RECURSIVE SumOver(_, _)
SumOver(f, S) == IF S = {} THEN 0
                 ELSE LET x == CHOOSE x \in S : TRUE IN f[x] + SumOver(f, S \ {x})

Zero      == [r \in Res |-> 0]
Cost      == [r \in Res |-> 1]
Vecs(m)   == [Res -> 0..m]
Leq(v, w) == \A r \in Res : v[r] <= w[r]
Add(v, w) == [r \in Res |-> v[r] + w[r]]
Sub(v, w) == [r \in Res |-> v[r] - w[r]]
Size(v)   == SumOver(v, Res)
Min(a, b) == IF a < b THEN a ELSE b
NextSeat(s)  == (s + 1) % N
SetupSeat(i) == IF i < N THEN i ELSE 2 * N - 1 - i      \* snake: 0..N-1, N-1..0

VPOf(s, pl, bu, lr) == pl[s] + bu[s] + (IF lr = s THEN 2 ELSE 0)
VP(s) == VPOf(s, placed, built, lrHolder)

(* §5.3: friendly robber excludes hexes touching a non-mover seat with      *)
(* public VP <= maxPublicVp; the R9 fallback lifts the exclusion when it    *)
(* leaves no hex.                                                           *)
Touches(h) == IF h = Desert THEN {} ELSE Seats
FriendlyOk(h) == ~FriendlyRobber \/ \A t \in Touches(h) \ {active} : VP(t) > FriendlyMaxVp
RobberTargets ==
    LET strict == {h \in Hexes \ {robber} : FriendlyOk(h)}
    IN IF strict = {} /\ LiftFriendlyIfStuck THEN Hexes \ {robber} ELSE strict

(* §5.10 auto-robber: desert if legal, else a fixed choice (lowest hexIndex). *)
AutoRobberHex == IF Desert \in RobberTargets THEN Desert ELSE CHOOSE h \in RobberTargets : TRUE

(* beginTurn (§6.2): checkVictory runs before preRoll accepts any action.  *)
BeginTurnPhase(nx) == IF WinCheckAtTurnStart /\ VP(nx) >= VPTarget THEN "gameOver" ELSE "preRoll"

(* onPhaseExit (§6.2): leaving main withdraws the open offer (R13).        *)
OfferAfter(p) == offerOpen /\ p = "main"

SevenOwed == [t \in Seats |-> IF Size(hand[t]) > DiscardLimit THEN Size(hand[t]) \div 2 ELSE 0]

(* R8 bank shortage: a short resource pays only when a single seat claims it. *)
Pay(claims) ==
    [t \in Seats |-> [r \in Res |->
        LET want == SumOver([u \in Seats |-> claims[u][r]], Seats)
            claimants == {u \in Seats : claims[u][r] > 0}
        IN IF want <= bank[r] THEN claims[t][r]
           ELSE IF Cardinality(claimants) = 1 THEN Min(claims[t][r], bank[r])
           ELSE 0]]

Production ==
    \E claims \in [Seats -> Vecs(1)] :
        LET p == Pay(claims) IN
        /\ hand' = [t \in Seats |-> Add(hand[t], p[t])]
        /\ bank' = [r \in Res |-> bank[r] - SumOver([t \in Seats |-> p[t][r]], Seats)]

Init ==
    /\ phase = "setupSettlement"
    /\ active = 0
    /\ setupIdx = 0
    /\ hand = [s \in Seats |-> Zero]
    /\ bank = [r \in Res |-> TotalPerRes]
    /\ owed = [s \in Seats |-> 0]
    /\ thenPhase = "moveRobber"
    /\ robber = Desert
    /\ returnPhase = "main"
    /\ offerOpen = FALSE
    /\ devPlayed = FALSE
    /\ knights = [s \in Seats |-> IF s \in KnightSeats THEN 1 ELSE 0]
    /\ rbCards = [s \in Seats |-> IF s \in RBSeats THEN 1 ELSE 0]
    /\ rbLeft = 0
    /\ roadsLeft = [s \in Seats |-> FreeRoadSupply]
    /\ placed = [s \in Seats |-> 0]
    /\ built = [s \in Seats |-> 0]
    /\ lrHolder = NoSeat
    /\ skipping = NoSeat

---------------------------------------------------------------------------
(* Player actions (§6.1 table). All are disabled while a skip loop runs.   *)

SetupSettlement(s) ==
    /\ phase = "setupSettlement" /\ s = active
    /\ placed' = [placed EXCEPT ![s] = @ + 1]
    /\ IF setupIdx >= N /\ \E r \in Res : bank[r] > 0
         THEN \E r \in Res : bank[r] > 0
                /\ hand' = [hand EXCEPT ![s][r] = @ + 1]
                /\ bank' = [bank EXCEPT ![r] = @ - 1]
         ELSE UNCHANGED <<hand, bank>>
    /\ phase' = "setupRoad"
    /\ UNCHANGED <<active, setupIdx, owed, thenPhase, robber, returnPhase, offerOpen,
                   devPlayed, knights, rbCards, rbLeft, roadsLeft, built, lrHolder, skipping>>

SetupRoad(s) ==
    /\ phase = "setupRoad" /\ s = active
    /\ setupIdx' = setupIdx + 1
    /\ IF setupIdx = 2 * N - 1
         THEN active' = 0 /\ phase' = BeginTurnPhase(0)
         ELSE active' = SetupSeat(setupIdx + 1) /\ phase' = "setupSettlement"
    /\ UNCHANGED <<hand, bank, owed, thenPhase, robber, returnPhase, offerOpen, devPlayed,
                   knights, rbCards, rbLeft, roadsLeft, placed, built, lrHolder, skipping>>

RollDice(s) ==
    /\ phase = "preRoll" /\ s = active
    /\ \/ /\ owed' = SevenOwed
          /\ phase' = IF \E t \in Seats : SevenOwed[t] > 0 THEN "discard" ELSE "moveRobber"
          /\ thenPhase' = "moveRobber"
          /\ returnPhase' = "main"
          /\ UNCHANGED <<hand, bank>>
       \/ /\ Production
          /\ phase' = "main"
          /\ UNCHANGED <<owed, thenPhase, returnPhase>>
    /\ UNCHANGED <<active, setupIdx, robber, offerOpen, devPlayed, knights, rbCards,
                   rbLeft, roadsLeft, placed, built, lrHolder, skipping>>

(* After the last owed discard: then=moveRobber ⇒ moveRobber(main);         *)
(* then=autoRobberThenEnd ⇒ auto-robber (no steal) and end of turn.          *)
AfterLastDiscard ==
    IF thenPhase = "moveRobber"
      THEN /\ phase' = "moveRobber"
           /\ UNCHANGED <<robber, active, devPlayed, offerOpen>>
      ELSE /\ robber' = AutoRobberHex
           /\ active' = NextSeat(active)
           /\ phase' = BeginTurnPhase(NextSeat(active))
           /\ devPlayed' = FALSE
           /\ offerOpen' = FALSE

Discard(s) ==
    /\ phase = "discard" /\ owed[s] > 0
    /\ \E d \in Vecs(owed[s]) :
         /\ Size(d) = owed[s] /\ Leq(d, hand[s])
         /\ hand' = [hand EXCEPT ![s] = Sub(@, d)]
         /\ bank' = Add(bank, d)
    /\ owed' = [owed EXCEPT ![s] = 0]
    /\ IF \A t \in Seats \ {s} : owed[t] = 0
         THEN AfterLastDiscard
         ELSE /\ phase' = "discard"
              /\ UNCHANGED <<robber, active, devPlayed, offerOpen>>
    /\ UNCHANGED <<setupIdx, thenPhase, returnPhase, knights, rbCards, rbLeft, roadsLeft,
                   placed, built, lrHolder, skipping>>

(* moveRobber {hex, victim}: move and steal in one action (ADR-0003).      *)
MoveRobber(s) ==
    /\ phase = "moveRobber" /\ s = active
    /\ \E h \in RobberTargets : robber' = h
    /\ \/ UNCHANGED hand
       \/ \E v \in Seats \ {s}, r \in Res :
            /\ hand[v][r] > 0
            /\ hand' = [hand EXCEPT ![v][r] = @ - 1, ![s][r] = @ + 1]
    /\ phase' = returnPhase
    /\ UNCHANGED <<active, setupIdx, bank, owed, thenPhase, returnPhase, offerOpen,
                   devPlayed, knights, rbCards, rbLeft, roadsLeft, placed, built, lrHolder, skipping>>

PlayKnight(s) ==
    /\ phase \in {"preRoll", "main"} /\ s = active
    /\ ~devPlayed /\ knights[s] > 0
    /\ knights' = [knights EXCEPT ![s] = @ - 1]
    /\ devPlayed' = TRUE
    /\ returnPhase' = phase
    /\ phase' = "moveRobber"
    /\ offerOpen' = OfferAfter("moveRobber")
    /\ UNCHANGED <<active, setupIdx, hand, bank, owed, thenPhase, robber, rbCards, rbLeft,
                   roadsLeft, placed, built, lrHolder, skipping>>

(* §6 Road Building: roadBuilding {remaining: min(2, supply.roads), resume};  *)
(* with 0 roads it resolves immediately with 0.                             *)
PlayRoadBuilding(s) ==
    /\ phase \in {"preRoll", "main"} /\ s = active
    /\ ~devPlayed /\ rbCards[s] > 0
    /\ rbCards' = [rbCards EXCEPT ![s] = @ - 1]
    /\ devPlayed' = TRUE
    /\ IF roadsLeft[s] = 0
         THEN UNCHANGED <<phase, returnPhase, rbLeft, offerOpen>>
         ELSE /\ rbLeft' = Min(2, roadsLeft[s])
              /\ returnPhase' = phase
              /\ phase' = "roadBuilding"
              /\ offerOpen' = OfferAfter("roadBuilding")
    /\ UNCHANGED <<active, setupIdx, hand, bank, owed, thenPhase, robber, knights, roadsLeft,
                   placed, built, lrHolder, skipping>>

PlaceFreeRoad(s) ==
    /\ phase = "roadBuilding" /\ s = active /\ rbLeft > 0
    /\ roadsLeft' = [roadsLeft EXCEPT ![s] = @ - 1]
    /\ rbLeft' = rbLeft - 1
    /\ lrHolder' \in {lrHolder, s}
    /\ phase' = IF VPOf(s, placed, built, lrHolder') >= VPTarget THEN "gameOver"
                ELSE IF rbLeft' = 0 THEN returnPhase ELSE "roadBuilding"
    /\ UNCHANGED <<active, setupIdx, hand, bank, owed, thenPhase, robber, returnPhase,
                   offerOpen, devPlayed, knights, rbCards, placed, built, skipping>>

(* No legal edge left: the phase ends early (§6).                          *)
EndRoadBuilding(s) ==
    /\ phase = "roadBuilding" /\ s = active
    /\ rbLeft' = 0
    /\ phase' = returnPhase
    /\ UNCHANGED <<active, setupIdx, hand, bank, owed, thenPhase, robber, returnPhase,
                   offerOpen, devPlayed, knights, rbCards, roadsLeft, placed, built, lrHolder, skipping>>

Build(s) ==
    /\ phase = "main" /\ s = active
    /\ built[s] < MaxBuilt /\ Leq(Cost, hand[s])
    /\ hand' = [hand EXCEPT ![s] = Sub(@, Cost)]
    /\ bank' = Add(bank, Cost)
    /\ built' = [built EXCEPT ![s] = @ + 1]
    /\ lrHolder' \in Seats \cup {NoSeat}
    /\ phase' = IF VPOf(s, placed, built', lrHolder') >= VPTarget THEN "gameOver" ELSE "main"
    /\ offerOpen' = OfferAfter(phase')
    /\ UNCHANGED <<active, setupIdx, owed, thenPhase, robber, returnPhase, devPlayed, knights,
                   rbCards, rbLeft, roadsLeft, placed, skipping>>

BankTrade(s) ==
    /\ phase = "main" /\ s = active
    /\ \E g, t \in Res :
         /\ g # t /\ hand[s][g] >= BankRatio /\ bank[t] >= 1
         /\ hand' = [hand EXCEPT ![s][g] = @ - BankRatio, ![s][t] = @ + 1]
         /\ bank' = [bank EXCEPT ![g] = @ + BankRatio, ![t] = @ - 1]
    /\ UNCHANGED <<phase, active, setupIdx, owed, thenPhase, robber, returnPhase, offerOpen,
                   devPlayed, knights, rbCards, rbLeft, roadsLeft, placed, built, lrHolder, skipping>>

OpenOffer(s) ==
    /\ phase = "main" /\ s = active /\ ~offerOpen
    /\ offerOpen' = TRUE
    /\ UNCHANGED <<phase, active, setupIdx, hand, bank, owed, thenPhase, robber, returnPhase,
                   devPlayed, knights, rbCards, rbLeft, roadsLeft, placed, built, lrHolder, skipping>>

CloseOffer(s) ==
    /\ offerOpen /\ s = active
    /\ offerOpen' = FALSE
    /\ UNCHANGED <<phase, active, setupIdx, hand, bank, owed, thenPhase, robber, returnPhase,
                   devPlayed, knights, rbCards, rbLeft, roadsLeft, placed, built, lrHolder, skipping>>

EndTurn(s) ==
    /\ phase = "main" /\ s = active
    /\ active' = NextSeat(s)
    /\ phase' = BeginTurnPhase(NextSeat(s))
    /\ offerOpen' = FALSE
    /\ devPlayed' = FALSE
    /\ UNCHANGED <<setupIdx, hand, bank, owed, thenPhase, robber, returnPhase, knights,
                   rbCards, rbLeft, roadsLeft, placed, built, lrHolder, skipping>>

Act(s) ==
    /\ skipping = NoSeat
    /\ \/ SetupSettlement(s) \/ SetupRoad(s) \/ RollDice(s) \/ Discard(s)
       \/ MoveRobber(s) \/ PlayKnight(s) \/ PlayRoadBuilding(s) \/ PlaceFreeRoad(s)
       \/ EndRoadBuilding(s) \/ Build(s) \/ BankTrade(s) \/ OpenOffer(s)
       \/ CloseOffer(s) \/ EndTurn(s)

---------------------------------------------------------------------------
(* System skipSeat (§5.10, §6.1).                                          *)

SkipEligible(s) ==
    \/ phase = "discard" /\ owed[s] > 0
    \/ phase \in {"preRoll", "moveRobber", "main", "roadBuilding"} /\ s = active

SkipSeat(s) ==
    /\ SkipEnabled /\ skipping = NoSeat /\ SkipEligible(s)
    /\ skipping' = s
    /\ UNCHANGED <<phase, active, setupIdx, hand, bank, owed, thenPhase, robber, returnPhase,
                   offerOpen, devPlayed, knights, rbCards, rbLeft, roadsLeft, placed, built, lrHolder>>

(* One iteration of the skip loop for seat k = skipping.                    *)
SkipStep ==
    LET k == skipping IN
    /\ k # NoSeat
    /\ CASE phase = "discard" /\ owed[k] > 0 ->
              \* 1. auto-discard from the absence stream; a non-active seat stops here
              /\ \E d \in Vecs(owed[k]) :
                   /\ Size(d) = owed[k] /\ Leq(d, hand[k])
                   /\ hand' = [hand EXCEPT ![k] = Sub(@, d)]
                   /\ bank' = Add(bank, d)
              /\ owed' = [owed EXCEPT ![k] = 0]
              /\ IF \A t \in Seats \ {k} : owed[t] = 0
                   THEN /\ AfterLastDiscard
                        /\ skipping' = IF thenPhase = "moveRobber" /\ k = active THEN k ELSE NoSeat
                   ELSE /\ phase' = "discard"
                        /\ UNCHANGED <<robber, active, devPlayed, offerOpen>>
                        /\ skipping' = NoSeat
              /\ UNCHANGED <<setupIdx, thenPhase, returnPhase, knights, rbCards, rbLeft,
                             roadsLeft, placed, built, lrHolder>>
         [] phase = "moveRobber" /\ k = active ->
              \* 2. auto-robber: deterministic, no RNG, no steal, always moves
              /\ robber' = AutoRobberHex
              /\ phase' = returnPhase
              /\ skipping' = k
              /\ UNCHANGED <<active, setupIdx, hand, bank, owed, thenPhase, returnPhase, offerOpen,
                             devPlayed, knights, rbCards, rbLeft, roadsLeft, placed, built, lrHolder>>
         [] phase = "preRoll" /\ k = active ->
              \* 3. auto-roll from the dice stream
              \/ /\ Production
                 /\ phase' = "main"
                 /\ skipping' = k
                 /\ UNCHANGED <<active, setupIdx, owed, thenPhase, robber, returnPhase, offerOpen,
                                devPlayed, knights, rbCards, rbLeft, roadsLeft, placed, built, lrHolder>>
              \/ LET o == SevenOwed
                     others == \E t \in Seats \ {k} : o[t] > 0
                 IN
                 /\ \E d \in Vecs(o[k]) :
                      /\ Size(d) = o[k] /\ Leq(d, hand[k])
                      /\ hand' = [hand EXCEPT ![k] = Sub(@, d)]
                      /\ bank' = Add(bank, d)
                 /\ owed' = [o EXCEPT ![k] = 0]
                 /\ IF others
                      THEN /\ phase' = "discard"
                           /\ thenPhase' = "autoRobberThenEnd"
                           /\ UNCHANGED <<robber, active, devPlayed, offerOpen>>
                      ELSE /\ robber' = AutoRobberHex
                           /\ active' = NextSeat(k)
                           /\ phase' = BeginTurnPhase(NextSeat(k))
                           /\ devPlayed' = FALSE
                           /\ offerOpen' = FALSE
                           /\ UNCHANGED thenPhase
                 /\ skipping' = NoSeat
                 /\ UNCHANGED <<setupIdx, returnPhase, knights, rbCards, rbLeft, roadsLeft,
                                placed, built, lrHolder>>
         [] phase = "roadBuilding" /\ k = active ->
              \* 4. remaining free roads are forfeited
              /\ rbLeft' = 0
              /\ phase' = returnPhase
              /\ skipping' = k
              /\ UNCHANGED <<active, setupIdx, hand, bank, owed, thenPhase, robber, returnPhase,
                             offerOpen, devPlayed, knights, rbCards, roadsLeft, placed, built, lrHolder>>
         [] phase = "main" /\ k = active ->
              \* 5. end the turn via beginTurn; onPhaseExit withdraws the offer
              /\ active' = NextSeat(k)
              /\ phase' = BeginTurnPhase(NextSeat(k))
              /\ offerOpen' = FALSE
              /\ devPlayed' = FALSE
              /\ skipping' = NoSeat
              /\ UNCHANGED <<setupIdx, hand, bank, owed, thenPhase, robber, returnPhase, knights,
                             rbCards, rbLeft, roadsLeft, placed, built, lrHolder>>
         [] OTHER ->
              /\ skipping' = NoSeat
              /\ UNCHANGED <<phase, active, setupIdx, hand, bank, owed, thenPhase, robber,
                             returnPhase, offerOpen, devPlayed, knights, rbCards, rbLeft,
                             roadsLeft, placed, built, lrHolder>>

Terminated == phase = "gameOver" /\ skipping = NoSeat /\ UNCHANGED vars

Next == (\E s \in Seats : Act(s) \/ SkipSeat(s)) \/ SkipStep \/ Terminated

(* Liveness assumption (§6.1): weak fairness on each eligible seat's action *)
(* or skipSeat, and on completing a running skip loop.                       *)
Fairness ==
    /\ \A s \in Seats : WF_vars(Discard(s) \/ SkipSeat(s))
    /\ \A s \in Seats : WF_vars(MoveRobber(s) \/ SkipSeat(s))
    /\ WF_vars(SkipStep)

Spec == Init /\ [][Next]_vars /\ Fairness

---------------------------------------------------------------------------
(* Invariants (§6.1). TLC deadlock checking stays on: a non-gameOver state *)
(* with no enabled step is a stuck state (AC11).                            *)
TypeOK ==
    /\ phase \in Phases /\ active \in Seats
    /\ hand \in [Seats -> Vecs(TotalPerRes)]
    /\ bank \in Vecs(TotalPerRes)
    /\ owed \in [Seats -> Nat]
    /\ thenPhase \in {"moveRobber", "autoRobberThenEnd"}
    /\ robber \in Hexes /\ returnPhase \in {"preRoll", "main"}
    /\ offerOpen \in BOOLEAN /\ devPlayed \in BOOLEAN
    /\ rbLeft \in 0..2 /\ roadsLeft \in [Seats -> 0..FreeRoadSupply]
    /\ lrHolder \in Seats \cup {NoSeat}
    /\ skipping \in Seats \cup {NoSeat}

Conservation ==
    \A r \in Res : bank[r] + SumOver([s \in Seats |-> hand[s][r]], Seats) = TotalPerRes

PieceLimits == \A s \in Seats : placed[s] <= 2 /\ built[s] <= MaxBuilt

SetupOrder == phase \in SetupPhases => active = SetupSeat(setupIdx)

DiscardIffOwed == (phase = "discard") <=> (\E s \in Seats : owed[s] > 0)

OwedIsHalf == \A s \in Seats : owed[s] > 0 => owed[s] * 2 <= Size(hand[s]) + 1

(* §6.1: trade ≠ null ⇒ phase = main ∧ trade.from = active (from = active by construction). *)
OfferOnlyInMain == offerOpen => phase = "main"

RoadBuildingConsistent == (phase = "roadBuilding") => rbLeft > 0

(* §6.1 / AC10: in moveRobber, robberTargets ≠ ∅.                           *)
RobberMoveExists == phase = "moveRobber" => RobberTargets # {}

WinnerIsActive == phase = "gameOver" => VP(active) >= VPTarget

(* R14: while a turn is in progress the active seat is below vpTarget.      *)
NoUnclaimedWin == phase \notin SetupPhases \cup {"gameOver"} => VP(active) < VPTarget

SkipOnlyWhenAllowed == skipping # NoSeat => phase \notin SetupPhases

(* Action properties *)
RobberMovesToNewHex ==
    [][(phase = "moveRobber" /\ phase' # "moveRobber") => robber' # robber]_vars

(* Auto-robber after an all-present discard also moves the robber.          *)
AutoRobberMoves ==
    [][(phase = "discard" /\ thenPhase = "autoRobberThenEnd" /\ phase' # "discard") => robber' # robber]_vars

OnlyEligibleSeatsAct ==
    [][\A s \in Seats : Act(s) => (s = active \/ (phase = "discard" /\ owed[s] > 0))]_vars

(* Skipping a non-active discarder never ends the active turn (AC28 (d)).   *)
(* Exception by design (§5.10): under then = autoRobberThenEnd the active    *)
(* seat was itself skipped, and the last discard ends that skipped turn.     *)
NonActiveSkipKeepsTurn ==
    [][(skipping # NoSeat /\ skipping # active /\ thenPhase # "autoRobberThenEnd")
         => active' = active]_vars

(* Liveness                                                                *)
DiscardTerminates   == (phase = "discard") ~> (phase # "discard")
RobberTerminates    == (phase = "moveRobber") ~> (phase # "moveRobber")
SkipLoopTerminates  == (skipping # NoSeat) ~> (skipping = NoSeat)

(* Cover properties for trace export (CoreCover*.cfg): each must FAIL, so   *)
(* TLC prints the shortest completed skip loop of that kind, SkipSeat then *)
(* SkipStep* until skipping = NoSeat (the V39 SkipSeat-SkipStep* relation).  *)
NeverSkipTurnEnds == [][~(skipping # NoSeat /\ skipping = active /\ skipping' = NoSeat /\ active' # active)]_vars
(* DR4: the active seat's skip auto-rolled a 7 and others still owe, so the *)
(* loop stops in discard with then = autoRobberThenEnd; the turn ends after *)
(* the last discard (deferred completion).                                   *)
NeverSkipAutoRobberThenEnd ==
    [][~(skipping # NoSeat /\ skipping = active /\ skipping' = NoSeat /\ phase' = "discard"
         /\ thenPhase' = "autoRobberThenEnd")]_vars
NeverSkipNonActiveDiscard ==
    [][~(phase = "discard" /\ skipping # NoSeat /\ skipping # active /\ skipping' = NoSeat)]_vars
(* One cover per §5.10 entry phase: the shortest SkipSeat entered from that *)
(* phase. The trace ends at SkipSeat; the importer's skip-loop relation runs *)
(* SkipStep* from that pre-state against the engine's single skipSeat.      *)
NeverSkipFrom(ph) == [][~((\E s \in Seats : SkipSeat(s)) /\ phase = ph)]_vars
NeverSkipFromPreRoll     == NeverSkipFrom("preRoll")
NeverSkipFromMain        == NeverSkipFrom("main")
NeverSkipFromMoveRobber  == NeverSkipFrom("moveRobber")
NeverSkipFromRoadBuilding == NeverSkipFrom("roadBuilding")
NeverSkipFromDiscardActive    == [][~((\E s \in Seats : SkipSeat(s)) /\ phase = "discard" /\ skipping' = active)]_vars
NeverSkipFromDiscardNonActive == [][~((\E s \in Seats : SkipSeat(s)) /\ phase = "discard" /\ skipping' # active)]_vars
=============================================================================
