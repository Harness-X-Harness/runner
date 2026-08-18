---- MODULE EnvironmentReopen ----
EXTENDS Naturals, FiniteSets

(***************************************************************************)
(* Focused obligation for concurrent Open requests while one Environment   *)
(* has a known run. GitHub owns the exact run's terminal reality. A         *)
(* replacement                                                             *)
(* generation is authorized only after the control plane commits a         *)
(* terminal observation. Live and unknown observations retain the current  *)
(* active phase.                                                           *)
(***************************************************************************)

CONSTANT Requests

NoRequest == "noRequest"

ASSUME /\ Requests # {}
       /\ Cardinality(Requests) = 2
       /\ NoRequest \notin Requests

VARIABLES runState,
          phase,
          requestPhase,
          observation,
          response,
          terminalEvidence,
          generation,
          dispatchCount,
          dispatchOwner

vars == << runState, phase, requestPhase, observation, response, terminalEvidence,
           generation, dispatchCount, dispatchOwner >>

RunStates == {"live", "terminal"}
ActivePhases == {"starting", "ready", "closing"}
Phases == ActivePhases \cup {"offline", "dispatching"}
RequestPhases == {
  "idle", "observing", "held", "terminalObserved", "opening", "done"
}
Observations == {"none", "live", "terminal", "unknown"}
Responses == {"none", "current", "replacement"}

Init ==
  /\ runState = "live"
  /\ phase \in ActivePhases
  /\ requestPhase = [r \in Requests |-> "idle"]
  /\ observation = [r \in Requests |-> "none"]
  /\ response = [r \in Requests |-> "none"]
  /\ terminalEvidence = FALSE
  /\ generation = 1
  /\ dispatchCount = 0
  /\ dispatchOwner = NoRequest

StartOpen(r) ==
  /\ phase \in ActivePhases
  /\ requestPhase[r] = "idle"
  /\ requestPhase' = [requestPhase EXCEPT ![r] = "observing"]
  /\ UNCHANGED << runState, phase, observation, response, terminalEvidence, generation,
                  dispatchCount, dispatchOwner >>

GitHubTerminates ==
  /\ runState = "live"
  /\ runState' = "terminal"
  /\ UNCHANGED << phase, requestPhase, observation, response, terminalEvidence,
                  generation, dispatchCount, dispatchOwner >>

ObserveLive(r) ==
  /\ requestPhase[r] = "observing"
  /\ runState = "live"
  /\ requestPhase' = [requestPhase EXCEPT ![r] = "held"]
  /\ observation' = [observation EXCEPT ![r] = "live"]
  /\ UNCHANGED << runState, phase, response, terminalEvidence, generation,
                  dispatchCount, dispatchOwner >>

ObserveUnknown(r) ==
  /\ requestPhase[r] = "observing"
  /\ requestPhase' = [requestPhase EXCEPT ![r] = "held"]
  /\ observation' = [observation EXCEPT ![r] = "unknown"]
  /\ UNCHANGED << runState, phase, response, terminalEvidence, generation,
                  dispatchCount, dispatchOwner >>

ObserveTerminal(r) ==
  /\ requestPhase[r] = "observing"
  /\ runState = "terminal"
  /\ requestPhase' = [requestPhase EXCEPT ![r] = "terminalObserved"]
  /\ observation' = [observation EXCEPT ![r] = "terminal"]
  /\ UNCHANGED << runState, phase, response, terminalEvidence, generation,
                  dispatchCount, dispatchOwner >>

ReturnCurrent(r) ==
  /\ requestPhase[r] = "held"
  /\ requestPhase' = [requestPhase EXCEPT ![r] = "done"]
  /\ response' = [response EXCEPT ![r] = "current"]
  /\ UNCHANGED << runState, phase, observation, terminalEvidence, generation,
                  dispatchCount, dispatchOwner >>

(***************************************************************************)
(* The owner Durable Object commits terminal evidence before any request    *)
(* can create the replacement generation. Duplicate commits are harmless.  *)
(***************************************************************************)
CommitTerminal(r) ==
  /\ requestPhase[r] = "terminalObserved"
  /\ phase \in ActivePhases \cup {"offline"}
  /\ phase' = "offline"
  /\ requestPhase' = [requestPhase EXCEPT ![r] = "opening"]
  /\ terminalEvidence' = TRUE
  /\ UNCHANGED << runState, observation, response, generation, dispatchCount,
                  dispatchOwner >>

(***************************************************************************)
(* Another request may already have created the replacement before this     *)
(* request commits its terminal observation. The stale commit is rejected.  *)
(***************************************************************************)
RejectStaleTerminalCommit(r) ==
  /\ requestPhase[r] = "terminalObserved"
  /\ phase = "dispatching"
  /\ requestPhase' = [requestPhase EXCEPT ![r] = "done"]
  /\ response' = [response EXCEPT ![r] = "replacement"]
  /\ UNCHANGED << runState, phase, observation, terminalEvidence, generation,
                  dispatchCount, dispatchOwner >>

(***************************************************************************)
(* A request that reads the committed Offline state inherits its authority  *)
(* without repeating the external GitHub observation.                       *)
(***************************************************************************)
OpenCommittedOffline(r) ==
  /\ requestPhase[r] = "idle"
  /\ phase = "offline"
  /\ terminalEvidence
  /\ requestPhase' = [requestPhase EXCEPT ![r] = "opening"]
  /\ UNCHANGED << runState, phase, observation, response, terminalEvidence, generation,
                  dispatchCount, dispatchOwner >>

SerializeReplacement(r) ==
  /\ requestPhase[r] = "opening"
  /\ phase = "offline"
  /\ terminalEvidence
  /\ generation = 1
  /\ dispatchCount = 0
  /\ phase' = "dispatching"
  /\ requestPhase' = [requestPhase EXCEPT ![r] = "done"]
  /\ generation' = 2
  /\ dispatchCount' = 1
  /\ dispatchOwner' = r
  /\ response' = [response EXCEPT ![r] = "replacement"]
  /\ UNCHANGED << runState, observation, terminalEvidence >>

JoinReplacement(r) ==
  /\ requestPhase[r] \in {"idle", "opening"}
  /\ phase = "dispatching"
  /\ requestPhase' = [requestPhase EXCEPT ![r] = "done"]
  /\ response' = [response EXCEPT ![r] = "replacement"]
  /\ UNCHANGED << runState, phase, observation, terminalEvidence, generation,
                  dispatchCount, dispatchOwner >>

Next ==
  \/ GitHubTerminates
  \/ \E r \in Requests:
       \/ StartOpen(r)
       \/ ObserveLive(r)
       \/ ObserveUnknown(r)
       \/ ObserveTerminal(r)
       \/ ReturnCurrent(r)
       \/ CommitTerminal(r)
       \/ RejectStaleTerminalCommit(r)
       \/ OpenCommittedOffline(r)
       \/ SerializeReplacement(r)
       \/ JoinReplacement(r)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ runState \in RunStates
  /\ phase \in Phases
  /\ requestPhase \in [Requests -> RequestPhases]
  /\ observation \in [Requests -> Observations]
  /\ response \in [Requests -> Responses]
  /\ terminalEvidence \in BOOLEAN
  /\ generation \in 1..2
  /\ dispatchCount \in 0..2
  /\ dispatchOwner \in Requests \cup {NoRequest}

ReplacementHasTerminalEvidence ==
  dispatchCount = 1 =>
    /\ terminalEvidence
    /\ runState = "terminal"
    /\ generation = 2
    /\ dispatchOwner \in Requests

AtMostOneReplacementDispatch == dispatchCount <= 1

TerminalObservationNeverReturnsCurrent ==
  \A r \in Requests: observation[r] = "terminal" => response[r] # "current"

(***************************************************************************)
(* Negative witnesses preserve both correctness boundaries.                 *)
(***************************************************************************)
BadReopenWithoutEvidence(r) ==
  /\ requestPhase[r] = "held"
  /\ phase \in ActivePhases
  /\ generation = 1
  /\ dispatchCount = 0
  /\ phase' = "dispatching"
  /\ requestPhase' = [requestPhase EXCEPT ![r] = "done"]
  /\ generation' = 2
  /\ dispatchCount' = 1
  /\ dispatchOwner' = r
  /\ response' = [response EXCEPT ![r] = "replacement"]
  /\ UNCHANGED << runState, observation, terminalEvidence >>

BadDuplicateDispatch(r) ==
  /\ requestPhase[r] = "opening"
  /\ phase = "dispatching"
  /\ dispatchCount = 1
  /\ dispatchOwner # r
  /\ requestPhase' = [requestPhase EXCEPT ![r] = "done"]
  /\ dispatchCount' = 2
  /\ dispatchOwner' = r
  /\ response' = [response EXCEPT ![r] = "replacement"]
  /\ UNCHANGED << runState, phase, observation, terminalEvidence, generation >>

BadReturnTerminalAsCurrent(r) ==
  /\ requestPhase[r] = "terminalObserved"
  /\ phase \in ActivePhases
  /\ requestPhase' = [requestPhase EXCEPT ![r] = "done"]
  /\ response' = [response EXCEPT ![r] = "current"]
  /\ UNCHANGED << runState, phase, observation, terminalEvidence, generation,
                  dispatchCount, dispatchOwner >>

ObservationBadNext ==
  Next \/ \E r \in Requests: BadReopenWithoutEvidence(r)

ObservationBadSpec == Init /\ [][ObservationBadNext]_vars

DuplicateBadNext ==
  Next \/ \E r \in Requests: BadDuplicateDispatch(r)

DuplicateBadSpec == Init /\ [][DuplicateBadNext]_vars

StaleReturnBadNext ==
  Next \/ \E r \in Requests: BadReturnTerminalAsCurrent(r)

StaleReturnBadSpec == Init /\ [][StaleReturnBadNext]_vars

====
