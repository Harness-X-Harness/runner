---- MODULE PrincipalIsolation ----
EXTENDS FiniteSets, Naturals

(***************************************************************************)
(* Focused obligation model for two authenticated Principals. Each         *)
(* Principal owns one Environment state machine and at most one active     *)
(* GitHub run. Callback and cancellation authority is the tuple            *)
(* <Principal, current run>. External evidence arrival is not fair.        *)
(***************************************************************************)

CONSTANTS Principals, Runs

ASSUME Cardinality(Principals) = 2
ASSUME Cardinality(Runs) = 2

NoRun == "no-run"
Phases == {"offline", "starting", "ready", "closing"}

VARIABLES phase,
          currentRun,
          activeRuns,
          usedRuns,
          runOwner,
          readyEvidence,
          terminalEvidence,
          callbackMutations,
          cancelEffects

vars == << phase, currentRun, activeRuns, usedRuns, runOwner, readyEvidence,
           terminalEvidence, callbackMutations, cancelEffects >>

Init ==
  /\ phase = [p \in Principals |-> "offline"]
  /\ currentRun = [p \in Principals |-> NoRun]
  /\ activeRuns = {}
  /\ usedRuns = {}
  /\ runOwner = [r \in Runs |-> CHOOSE p \in Principals : TRUE]
  /\ readyEvidence = {}
  /\ terminalEvidence = {}
  /\ callbackMutations = {}
  /\ cancelEffects = {}

Open(p, r) ==
  /\ phase[p] = "offline"
  /\ r \in Runs \ usedRuns
  /\ phase' = [phase EXCEPT ![p] = "starting"]
  /\ currentRun' = [currentRun EXCEPT ![p] = r]
  /\ activeRuns' = activeRuns \cup {r}
  /\ usedRuns' = usedRuns \cup {r}
  /\ runOwner' = [runOwner EXCEPT ![r] = p]
  /\ readyEvidence' = readyEvidence \ {p}
  /\ terminalEvidence' = terminalEvidence \ {p}
  /\ UNCHANGED << callbackMutations, cancelEffects >>

SupplyReadyEvidence(p) ==
  /\ phase[p] = "starting"
  /\ readyEvidence' = readyEvidence \cup {p}
  /\ UNCHANGED << phase, currentRun, activeRuns, usedRuns, runOwner,
                  terminalEvidence, callbackMutations, cancelEffects >>

SupplyTerminalEvidence(p) ==
  /\ phase[p] \in {"starting", "ready", "closing"}
  /\ terminalEvidence' = terminalEvidence \cup {p}
  /\ UNCHANGED << phase, currentRun, activeRuns, usedRuns, runOwner,
                  readyEvidence, callbackMutations, cancelEffects >>

CommitReady(p) ==
  LET r == currentRun[p] IN
  /\ phase[p] = "starting"
  /\ p \in readyEvidence
  /\ r \in activeRuns
  /\ runOwner[r] = p
  /\ phase' = [phase EXCEPT ![p] = "ready"]
  /\ callbackMutations' = callbackMutations \cup {[target |-> p, run |-> r]}
  /\ UNCHANGED << currentRun, activeRuns, usedRuns, runOwner, readyEvidence,
                  terminalEvidence, cancelEffects >>

Close(p) ==
  /\ phase[p] \in {"starting", "ready"}
  /\ phase' = [phase EXCEPT ![p] = "closing"]
  /\ UNCHANGED << currentRun, activeRuns, usedRuns, runOwner, readyEvidence,
                  terminalEvidence, callbackMutations, cancelEffects >>

CancelCurrent(p) ==
  LET r == currentRun[p] IN
  /\ phase[p] = "closing"
  /\ r \in activeRuns
  /\ runOwner[r] = p
  /\ cancelEffects' = cancelEffects \cup {[requester |-> p, run |-> r]}
  /\ UNCHANGED << phase, currentRun, activeRuns, usedRuns, runOwner,
                  readyEvidence, terminalEvidence, callbackMutations >>

CommitTerminal(p) ==
  LET r == currentRun[p] IN
  /\ phase[p] \in {"starting", "ready", "closing"}
  /\ p \in terminalEvidence
  /\ r \in activeRuns
  /\ runOwner[r] = p
  /\ phase' = [phase EXCEPT ![p] = "offline"]
  /\ currentRun' = [currentRun EXCEPT ![p] = NoRun]
  /\ activeRuns' = activeRuns \ {r}
  /\ readyEvidence' = readyEvidence \ {p}
  /\ terminalEvidence' = terminalEvidence \ {p}
  /\ UNCHANGED << usedRuns, runOwner, callbackMutations, cancelEffects >>

Next ==
  \/ \E p \in Principals, r \in Runs : Open(p, r)
  \/ \E p \in Principals : SupplyReadyEvidence(p)
  \/ \E p \in Principals : SupplyTerminalEvidence(p)
  \/ \E p \in Principals : CommitReady(p)
  \/ \E p \in Principals : Close(p)
  \/ \E p \in Principals : CancelCurrent(p)
  \/ \E p \in Principals : CommitTerminal(p)

Spec == Init /\ [][Next]_vars
             /\ (\A p \in Principals : WF_vars(CommitReady(p)))
             /\ (\A principal \in Principals : WF_vars(CommitTerminal(principal)))

TypeOK ==
  /\ phase \in [Principals -> Phases]
  /\ currentRun \in [Principals -> Runs \cup {NoRun}]
  /\ activeRuns \subseteq Runs
  /\ usedRuns \subseteq Runs
  /\ runOwner \in [Runs -> Principals]
  /\ readyEvidence \subseteq Principals
  /\ terminalEvidence \subseteq Principals
  /\ callbackMutations \subseteq [target : Principals, run : Runs]
  /\ cancelEffects \subseteq [requester : Principals, run : Runs]

NoCrossOwnerMutation ==
  \A mutation \in callbackMutations : runOwner[mutation.run] = mutation.target

ExactOwnerCancel ==
  \A effect \in cancelEffects : runOwner[effect.run] = effect.requester

OneActiveRunPerOwner ==
  \A p \in Principals : Cardinality({r \in activeRuns : runOwner[r] = p}) <= 1

(***************************************************************************)
(* This does not require GitHub to produce evidence. Once appropriate      *)
(* ready or terminal evidence exists, weak fairness covers only the local  *)
(* commit action. A concurrent Close can supersede Ready; reaching Offline *)
(* after that still requires separate terminal evidence from GitHub.       *)
(***************************************************************************)
EnvironmentEvidenceConverges ==
  /\ \A p \in Principals :
       []((phase[p] = "starting" /\ p \in readyEvidence) ~>
          phase[p] \in {"ready", "closing", "offline"})
  /\ \A p \in Principals :
       []((phase[p] \in {"starting", "ready", "closing"} /\
           p \in terminalEvidence) ~> phase[p] = "offline")

(***************************************************************************)
(* Fault actions are excluded from Spec and retained as negative witnesses. *)
(***************************************************************************)
MisrouteCallback ==
  \E owner \in Principals, target \in Principals, r \in Runs :
    /\ owner # target
    /\ phase[target] = "offline"
    /\ r \in activeRuns
    /\ runOwner[r] = owner
    /\ phase' = [phase EXCEPT ![target] = "ready"]
    /\ currentRun' = [currentRun EXCEPT ![target] = r]
    /\ callbackMutations' = callbackMutations \cup {[target |-> target, run |-> r]}
    /\ UNCHANGED << activeRuns, usedRuns, runOwner, readyEvidence, terminalEvidence,
                    cancelEffects >>

MisrouteCancel ==
  \E owner \in Principals, requester \in Principals, r \in Runs :
    /\ owner # requester
    /\ r \in activeRuns
    /\ runOwner[r] = owner
    /\ cancelEffects' = cancelEffects \cup {[requester |-> requester, run |-> r]}
    /\ activeRuns' = activeRuns \ {r}
    /\ UNCHANGED << phase, currentRun, usedRuns, runOwner, readyEvidence,
                    terminalEvidence, callbackMutations >>

DuplicateOwnerRun ==
  \E p \in Principals, r \in Runs :
    /\ Cardinality({existing \in activeRuns : runOwner[existing] = p}) = 1
    /\ r \in Runs \ usedRuns
    /\ activeRuns' = activeRuns \cup {r}
    /\ usedRuns' = usedRuns \cup {r}
    /\ runOwner' = [runOwner EXCEPT ![r] = p]
    /\ UNCHANGED << phase, currentRun, readyEvidence, terminalEvidence,
                    callbackMutations, cancelEffects >>

CallbackFaultSpec == Init /\ [][Next \/ MisrouteCallback]_vars
CancelFaultSpec == Init /\ [][Next \/ MisrouteCancel]_vars
DuplicateFaultSpec == Init /\ [][Next \/ DuplicateOwnerRun]_vars

====
