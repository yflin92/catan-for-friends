--------------------------- MODULE CatanLifecycle ---------------------------
(***************************************************************************)
(* Game lifecycle (verification check V38d: AC29, AC18 terminal states),  *)
(* design §5.7 / §6.1: lobby → active ⇄ abandoned → finished |              *)
(* expired, plus lobby → expired. `evaluate` is a pure function of persisted *)
(* timestamps with ≥ comparisons; it runs on every job tick (the check      *)
(* interval is one tick) and before every hello or game action.             *)
(* Time is discrete ticks; thresholds are scaled-down CFG values.           *)
(***************************************************************************)
EXTENDS Integers

CONSTANTS InactivityT, AllDiscT, ResumeW, LobbyExp, MaxTime,
          StrictThreshold   \* TRUE compares inactivity with > instead of >= (mutant; must fail)

None == -1
States == {"lobby", "active", "abandoned", "finished", "expired"}
Edges  == {<<"lobby", "active">>, <<"lobby", "expired">>, <<"active", "abandoned">>,
           <<"abandoned", "active">>, <<"active", "finished">>, <<"abandoned", "expired">>}

VARIABLES now, lc, lastLobbyAct, lastAction, allDiscSince, abandonedAt, connected, hist

vars == <<now, lc, lastLobbyAct, lastAction, allDiscSince, abandonedAt, connected, hist>>

(* evaluate(game, t): the lifecycle after applying the §5.7 table at time t. *)
Eval(t) ==
    CASE lc = "lobby" /\ t - lastLobbyAct >= LobbyExp -> "expired"
      [] lc = "active" /\ (t - lastAction >= InactivityT
                           \/ (allDiscSince # None /\ t - allDiscSince >= AllDiscT)) -> "abandoned"
      [] lc = "abandoned" /\ t - abandonedAt >= ResumeW -> "expired"
      [] OTHER -> lc

Record(from, to) == hist' = IF from = to THEN hist ELSE hist \cup {<<from, to>>}

Init ==
    /\ now = 0 /\ lc = "lobby" /\ lastLobbyAct = 0 /\ lastAction = None
    /\ allDiscSince = None /\ abandonedAt = None /\ connected = TRUE /\ hist = {}

(* Inactivity threshold reached at time t (design §5.7 uses >=).           *)
InactivityDue(t) == IF StrictThreshold THEN t - lastAction > InactivityT
                    ELSE t - lastAction >= InactivityT

(* Job tick: time advances and the abandonment job runs evaluate.          *)
Tick ==
    /\ now < MaxTime
    /\ now' = now + 1
    /\ LET e == CASE lc = "lobby" /\ now + 1 - lastLobbyAct >= LobbyExp -> "expired"
                  [] lc = "active" /\ (InactivityDue(now + 1)
                                       \/ (allDiscSince # None /\ now + 1 - allDiscSince >= AllDiscT)) -> "abandoned"
                  [] lc = "abandoned" /\ now + 1 - abandonedAt >= ResumeW -> "expired"
                  [] OTHER -> lc
       IN /\ lc' = e
          /\ abandonedAt' = IF e = "abandoned" /\ lc = "active" THEN now + 1 ELSE abandonedAt
          /\ Record(lc, e)
    /\ UNCHANGED <<lastLobbyAct, lastAction, allDiscSince, connected>>

LobbyActivity ==
    /\ lc = "lobby" /\ Eval(now) = "lobby"
    /\ lastLobbyAct' = now
    /\ UNCHANGED <<now, lc, lastAction, allDiscSince, abandonedAt, connected, hist>>

Start ==
    /\ lc = "lobby" /\ Eval(now) = "lobby" /\ connected
    /\ lc' = "active" /\ lastAction' = now /\ allDiscSince' = None
    /\ Record("lobby", "active")
    /\ UNCHANGED <<now, lastLobbyAct, abandonedAt, connected>>

(* A seated hello or game action: evaluate first; abandoned within the      *)
(* window resumes (stateHash unchanged, timers reset); expired rejects.     *)
SeatedContact(isAction) ==
    /\ lc \in {"active", "abandoned"}
    /\ LET e == Eval(now) IN
       IF e = "expired"
         THEN /\ lc' = "expired" /\ Record(lc, "expired")
              /\ UNCHANGED <<lastAction, allDiscSince, abandonedAt, connected>>
         ELSE /\ lc' = "active"
              /\ hist' = hist \cup (IF lc = "active" /\ e = "abandoned"
                                      THEN {<<"active", "abandoned">>, <<"abandoned", "active">>}
                                    ELSE IF lc = "abandoned" THEN {<<"abandoned", "active">>}
                                    ELSE {})
              /\ lastAction' = IF isAction \/ e = "abandoned" THEN now ELSE lastAction
              /\ allDiscSince' = None
              /\ connected' = TRUE
              /\ abandonedAt' = abandonedAt
    /\ UNCHANGED <<now, lastLobbyAct>>

Hello      == SeatedContact(FALSE)
GameAction == connected /\ SeatedContact(TRUE)

DisconnectAll ==
    /\ connected /\ lc \in {"lobby", "active", "abandoned"}
    /\ connected' = FALSE
    /\ allDiscSince' = IF lc = "active" THEN now ELSE allDiscSince
    /\ UNCHANGED <<now, lc, lastLobbyAct, lastAction, abandonedAt, hist>>

Win ==
    /\ lc = "active" /\ Eval(now) = "active" /\ connected
    /\ lc' = "finished" /\ Record("active", "finished")
    /\ UNCHANGED <<now, lastLobbyAct, lastAction, allDiscSince, abandonedAt, connected>>

Done == now = MaxTime /\ UNCHANGED vars

Next == Tick \/ LobbyActivity \/ Start \/ Hello \/ GameAction \/ DisconnectAll \/ Win \/ Done

Spec == Init /\ [][Next]_vars

---------------------------------------------------------------------------
TypeOK == lc \in States /\ now \in 0..MaxTime

OnlyDesignedEdges == hist \subseteq Edges

(* With the job running every tick, nothing is ever overdue (AC29:          *)
(* transition within threshold + one check interval).                       *)
NothingOverdue ==
    /\ lc = "lobby"     => now - lastLobbyAct < LobbyExp
    /\ lc = "active"    => (now - lastAction < InactivityT
                            /\ (allDiscSince = None \/ now - allDiscSince < AllDiscT))
    /\ lc = "abandoned" => now - abandonedAt < ResumeW

TerminalAbsorbing == [][(lc \in {"finished", "expired"}) => lc' = lc]_vars

(* Never early: abandonment only at or after a threshold (30:00, not 29:59). *)
NeverEarly ==
    [][(lc = "active" /\ lc' = "abandoned") =>
         (now' - lastAction >= InactivityT \/ (allDiscSince # None /\ now' - allDiscSince >= AllDiscT))]_vars

ResumeOnlyInWindow ==
    [][(lc = "abandoned" /\ lc' = "active") => now - abandonedAt < ResumeW]_vars
=============================================================================
