---- MODULE RemoteEnvironment ----
EXTENDS FiniteSets, Naturals

(***************************************************************************)
(* Requirements model for one authenticated user's current Remote          *)
(* Development Environment. GitHub owns run lifecycle. The control plane   *)
(* owns the current generation, connection delivery, close intent, and       *)
(* pending responsibility for delivery of the exact-run cancel effect.       *)
(* A generation number also names its representative finite run identity.   *)
(***************************************************************************)

VARIABLES generation,
          phase,
          runId,
          descriptorGeneration,
          descriptorRun,
          closeRequested,
          cancelPending,
          dispatchIssued,
          liveRuns,
          cancelledRuns

vars == << generation, phase, runId, descriptorGeneration, descriptorRun,
           closeRequested, cancelPending, dispatchIssued, liveRuns,
           cancelledRuns >>

Phases == {"idle", "dispatching", "starting", "ready", "closing", "offline"}
Runs == 1..2
NoIdentity == 0

Init ==
  /\ generation = NoIdentity
  /\ phase = "idle"
  /\ runId = NoIdentity
  /\ descriptorGeneration = NoIdentity
  /\ descriptorRun = NoIdentity
  /\ closeRequested = FALSE
  /\ cancelPending = FALSE
  /\ dispatchIssued = FALSE
  /\ liveRuns = {}
  /\ cancelledRuns = {}

Open ==
  /\ phase \in {"idle", "offline"}
  /\ generation < 2
  /\ generation' = generation + 1
  /\ phase' = "dispatching"
  /\ runId' = NoIdentity
  /\ descriptorGeneration' = NoIdentity
  /\ descriptorRun' = NoIdentity
  /\ closeRequested' = FALSE
  /\ cancelPending' = FALSE
  /\ dispatchIssued' = TRUE
  /\ UNCHANGED << liveRuns, cancelledRuns >>

CommitDispatch ==
  /\ phase = "dispatching"
  /\ dispatchIssued
  /\ runId' = generation
  /\ phase' = "starting"
  /\ liveRuns' = liveRuns \cup {generation}
  /\ UNCHANGED << generation, descriptorGeneration, descriptorRun,
                  closeRequested, cancelPending, dispatchIssued,
                  cancelledRuns >>

DispatchOutcomeUnknown ==
  /\ phase = "dispatching"
  /\ dispatchIssued
  /\ runId = NoIdentity
  /\ generation \notin liveRuns
  /\ liveRuns' = liveRuns \cup {generation}
  /\ UNCHANGED << generation, phase, runId, descriptorGeneration,
                  descriptorRun, closeRequested, cancelPending, dispatchIssued,
                  cancelledRuns >>

ReadyCallback ==
  /\ phase = "starting"
  /\ ~closeRequested
  /\ runId = generation
  /\ phase' = "ready"
  /\ descriptorGeneration' = generation
  /\ descriptorRun' = runId
  /\ UNCHANGED << generation, runId, closeRequested, dispatchIssued,
                  cancelPending, liveRuns, cancelledRuns >>

Close ==
  /\ phase \in {"dispatching", "starting", "ready"}
  /\ phase' = "closing"
  /\ closeRequested' = TRUE
  /\ cancelPending' = (runId # NoIdentity)
  /\ descriptorGeneration' = NoIdentity
  /\ descriptorRun' = NoIdentity
  /\ UNCHANGED << generation, runId, dispatchIssued, liveRuns,
                  cancelledRuns >>

SendCancel ==
  /\ phase = "closing"
  /\ closeRequested
  /\ cancelPending
  /\ runId # NoIdentity
  /\ cancelledRuns' = cancelledRuns \cup {runId}
  /\ UNCHANGED << generation, phase, runId, descriptorGeneration,
                  descriptorRun, closeRequested, cancelPending,
                  dispatchIssued, liveRuns >>

AcknowledgeCancel ==
  /\ phase = "closing"
  /\ cancelPending
  /\ runId \in cancelledRuns
  /\ cancelPending' = FALSE
  /\ UNCHANGED << generation, phase, runId, descriptorGeneration,
                  descriptorRun, closeRequested, dispatchIssued, liveRuns,
                  cancelledRuns >>

CommitDispatchAfterClose ==
  /\ phase = "closing"
  /\ closeRequested
  /\ dispatchIssued
  /\ runId = NoIdentity
  /\ runId' = generation
  /\ liveRuns' = liveRuns \cup {generation}
  /\ cancelPending' = TRUE
  /\ UNCHANGED << generation, phase, descriptorGeneration, descriptorRun,
                  closeRequested, dispatchIssued, cancelledRuns >>

GitHubTerminates ==
  /\ phase \in {"starting", "ready", "closing"}
  /\ runId # NoIdentity
  /\ phase' = "offline"
  /\ liveRuns' = liveRuns \ {runId}
  /\ cancelPending' = FALSE
  /\ descriptorGeneration' = NoIdentity
  /\ descriptorRun' = NoIdentity
  /\ UNCHANGED << generation, runId, closeRequested, dispatchIssued,
                  cancelledRuns >>

Next ==
  \/ Open
  \/ CommitDispatch
  \/ DispatchOutcomeUnknown
  \/ ReadyCallback
  \/ Close
  \/ SendCancel
  \/ AcknowledgeCancel
  \/ CommitDispatchAfterClose
  \/ GitHubTerminates

Spec == Init /\ [][Next]_vars
             /\ WF_vars(SendCancel)
             /\ WF_vars(AcknowledgeCancel)
             /\ WF_vars(GitHubTerminates)

TypeOK ==
  /\ generation \in 0..2
  /\ phase \in Phases
  /\ runId \in 0..2
  /\ descriptorGeneration \in 0..2
  /\ descriptorRun \in 0..2
  /\ closeRequested \in BOOLEAN
  /\ cancelPending \in BOOLEAN
  /\ dispatchIssued \in BOOLEAN
  /\ liveRuns \subseteq Runs
  /\ cancelledRuns \subseteq Runs

AtMostOneLiveRun == Cardinality(liveRuns) <= 1

DescriptorIsCurrent ==
  descriptorGeneration = NoIdentity \/
    /\ phase = "ready"
    /\ ~closeRequested
    /\ descriptorGeneration = generation
    /\ descriptorRun = runId

CloseHidesDescriptor == closeRequested => descriptorGeneration = NoIdentity

ActiveRunIsCurrent ==
  phase \in {"starting", "ready"} => liveRuns = {runId}

NoFutureRunCancelled == \A cancelled \in cancelledRuns : cancelled <= generation

CancelResponsibilityRetained ==
  (/\ phase = "closing"
   /\ runId # NoIdentity
   /\ runId \in liveRuns
   /\ runId \notin cancelledRuns)
  => cancelPending

ClosingConverges ==
  []((phase = "closing" /\ runId # NoIdentity) => <>(phase = "offline"))

(***************************************************************************)
(* Negative witness: an old generation's ready callback is accepted by a   *)
(* newer generation or after close, and publishes the old descriptor.       *)
(***************************************************************************)
BadReadyCallback ==
  /\ generation = 2
  /\ phase \in {"starting", "closing"}
  /\ phase' = "ready"
  /\ descriptorGeneration' = 1
  /\ descriptorRun' = 1
  /\ UNCHANGED << generation, runId, closeRequested, dispatchIssued,
                  cancelPending, liveRuns, cancelledRuns >>

BadLoseCancelResponsibility ==
  /\ phase = "closing"
  /\ cancelPending
  /\ runId # NoIdentity
  /\ runId \in liveRuns
  /\ runId \notin cancelledRuns
  /\ cancelPending' = FALSE
  /\ UNCHANGED << generation, phase, runId, descriptorGeneration,
                  descriptorRun, closeRequested, dispatchIssued, liveRuns,
                  cancelledRuns >>

BadNext == Next \/ BadReadyCallback
BadSpec == Init /\ [][BadNext]_vars

CancelBadNext == Next \/ BadLoseCancelResponsibility
CancelBadSpec == Init /\ [][CancelBadNext]_vars

====
