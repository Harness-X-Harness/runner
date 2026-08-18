---- MODULE RemoteEnvironment ----
EXTENDS Naturals

(***************************************************************************)
(* Requirements model for one authenticated user's current private         *)
(* development Environment. GitHub owns workflow-run lifecycle. The        *)
(* control plane owns one current generation, admission at the early OIDC  *)
(* claim gate, private descriptor delivery, and exact-run cancellation.     *)
(*                                                                         *)
(* A GitHub dispatch can have an unknown outcome. A created run therefore  *)
(* has to claim its exact GitHub run identity before it receives secrets,  *)
(* joins the private network, or starts T3. Closing an unclaimed generation *)
(* invalidates that gate. A delayed run from the invalid generation exits   *)
(* at the gate instead of becoming an Environment.                          *)
(***************************************************************************)

VARIABLES generation,
          validGeneration,
          phase,
          runId,
          liveRun,
          admittedRun,
          descriptorGeneration,
          descriptorRun,
          closeRequested,
          cancelPending,
          dispatchIssued,
          cancelledRuns

vars == << generation, validGeneration, phase, runId, liveRun, admittedRun,
           descriptorGeneration, descriptorRun, closeRequested,
           cancelPending, dispatchIssued, cancelledRuns >>

Phases == {"idle", "dispatching", "starting", "ready", "closing", "offline"}
Runs == 1..2
NoIdentity == 0

Init ==
  /\ generation = NoIdentity
  /\ validGeneration = NoIdentity
  /\ phase = "idle"
  /\ runId = NoIdentity
  /\ liveRun = NoIdentity
  /\ admittedRun = NoIdentity
  /\ descriptorGeneration = NoIdentity
  /\ descriptorRun = NoIdentity
  /\ closeRequested = FALSE
  /\ cancelPending = FALSE
  /\ dispatchIssued = FALSE
  /\ cancelledRuns = {}

Open ==
  /\ phase \in {"idle", "offline"}
  /\ generation < 2
  /\ generation' = generation + 1
  /\ validGeneration' = generation + 1
  /\ phase' = "dispatching"
  /\ runId' = NoIdentity
  /\ admittedRun' = NoIdentity
  /\ descriptorGeneration' = NoIdentity
  /\ descriptorRun' = NoIdentity
  /\ closeRequested' = FALSE
  /\ cancelPending' = FALSE
  /\ dispatchIssued' = TRUE
  /\ UNCHANGED << liveRun, cancelledRuns >>

(***************************************************************************)
(* One Open request can observe that the exact known GitHub run is         *)
(* terminal and create the next generation. A failed or non-terminal       *)
(* observation does not enable this action.                                *)
(***************************************************************************)
ReopenAfterTerminal ==
  /\ phase \in {"starting", "ready", "closing"}
  /\ runId # NoIdentity
  /\ liveRun = NoIdentity
  /\ generation < 2
  /\ generation' = generation + 1
  /\ validGeneration' = generation + 1
  /\ phase' = "dispatching"
  /\ runId' = NoIdentity
  /\ admittedRun' = NoIdentity
  /\ descriptorGeneration' = NoIdentity
  /\ descriptorRun' = NoIdentity
  /\ closeRequested' = FALSE
  /\ cancelPending' = FALSE
  /\ dispatchIssued' = TRUE
  /\ UNCHANGED << liveRun, cancelledRuns >>

(***************************************************************************)
(* A response proving rejection means no run was created for this request. *)
(* An older unclaimed run can still exist and remains unable to pass the    *)
(* now-invalid claim gate.                                                  *)
(***************************************************************************)
DispatchRejected ==
  /\ phase = "dispatching"
  /\ dispatchIssued
  /\ runId = NoIdentity
  /\ phase' = "offline"
  /\ validGeneration' = NoIdentity
  /\ dispatchIssued' = FALSE
  /\ UNCHANGED << generation, runId, liveRun, admittedRun,
                  descriptorGeneration, descriptorRun, closeRequested,
                  cancelPending, cancelledRuns >>

(***************************************************************************)
(* A successful dispatch response admits the exact run. Workflow           *)
(* concurrency makes this generation the selected live run for the owner.  *)
(***************************************************************************)
CommitDispatch ==
  /\ phase = "dispatching"
  /\ dispatchIssued
  /\ runId = NoIdentity
  /\ liveRun' = generation
  /\ runId' = generation
  /\ phase' = "starting"
  /\ dispatchIssued' = FALSE
  /\ UNCHANGED << generation, validGeneration, admittedRun,
                  descriptorGeneration, descriptorRun, closeRequested,
                  cancelPending, cancelledRuns >>

(***************************************************************************)
(* GitHub may have accepted the request even though the Worker got no       *)
(* usable response. No retry is issued. The early runner claim can still    *)
(* establish the exact identity.                                            *)
(***************************************************************************)
DispatchOutcomeUnknown ==
  /\ phase = "dispatching"
  /\ dispatchIssued
  /\ runId = NoIdentity
  /\ liveRun' = generation
  /\ dispatchIssued' = FALSE
  /\ UNCHANGED << generation, validGeneration, phase, runId, admittedRun,
                  descriptorGeneration, descriptorRun, closeRequested,
                  cancelPending, cancelledRuns >>

EarlyRunnerClaim ==
  /\ phase \in {"dispatching", "starting"}
  /\ validGeneration = generation
  /\ liveRun = generation
  /\ admittedRun = NoIdentity
  /\ runId \in {NoIdentity, liveRun}
  /\ runId' = generation
  /\ admittedRun' = liveRun
  /\ phase' = "starting"
  /\ UNCHANGED << generation, validGeneration, liveRun,
                  descriptorGeneration, descriptorRun, closeRequested,
                  cancelPending, dispatchIssued, cancelledRuns >>

ReadyCallback ==
  /\ phase = "starting"
  /\ validGeneration = generation
  /\ admittedRun = generation
  /\ runId = generation
  /\ liveRun = runId
  /\ ~closeRequested
  /\ phase' = "ready"
  /\ descriptorGeneration' = generation
  /\ descriptorRun' = runId
  /\ UNCHANGED << generation, validGeneration, runId, liveRun, admittedRun,
                  closeRequested, cancelPending, dispatchIssued,
                  cancelledRuns >>

(***************************************************************************)
(* Before admission, Close is a generation revocation. A delayed workflow  *)
(* can execute only the non-sensitive bootstrap and is rejected by claim.   *)
(***************************************************************************)
CloseUnclaimed ==
  /\ phase = "dispatching"
  /\ runId = NoIdentity
  /\ phase' = "offline"
  /\ validGeneration' = NoIdentity
  /\ closeRequested' = TRUE
  /\ descriptorGeneration' = NoIdentity
  /\ descriptorRun' = NoIdentity
  /\ dispatchIssued' = FALSE
  /\ UNCHANGED << generation, runId, liveRun, admittedRun, cancelPending,
                  cancelledRuns >>

CloseKnownRun ==
  /\ phase = "starting"
  /\ runId # NoIdentity
  /\ admittedRun = NoIdentity
  /\ phase' = "closing"
  /\ validGeneration' = NoIdentity
  /\ closeRequested' = TRUE
  /\ cancelPending' = TRUE
  /\ descriptorGeneration' = NoIdentity
  /\ descriptorRun' = NoIdentity
  /\ UNCHANGED << generation, runId, liveRun, admittedRun, dispatchIssued,
                  cancelledRuns >>

CloseAdmitted ==
  /\ phase \in {"starting", "ready"}
  /\ runId # NoIdentity
  /\ admittedRun = runId
  /\ phase' = "closing"
  /\ validGeneration' = NoIdentity
  /\ closeRequested' = TRUE
  /\ cancelPending' = TRUE
  /\ descriptorGeneration' = NoIdentity
  /\ descriptorRun' = NoIdentity
  /\ UNCHANGED << generation, runId, liveRun, admittedRun, dispatchIssued,
                  cancelledRuns >>

SendCancel ==
  /\ phase = "closing"
  /\ closeRequested
  /\ cancelPending
  /\ runId # NoIdentity
  /\ cancelledRuns' = cancelledRuns \cup {runId}
  /\ UNCHANGED << generation, validGeneration, phase, runId, liveRun,
                  admittedRun, descriptorGeneration, descriptorRun,
                  closeRequested, cancelPending, dispatchIssued >>

AcknowledgeCancel ==
  /\ phase = "closing"
  /\ cancelPending
  /\ runId \in cancelledRuns
  /\ cancelPending' = FALSE
  /\ UNCHANGED << generation, validGeneration, phase, runId, liveRun,
                  admittedRun, descriptorGeneration, descriptorRun,
                  closeRequested, dispatchIssued, cancelledRuns >>

(***************************************************************************)
(* A delayed run from an invalid generation is rejected at the early claim *)
(* gate and exits before sensitive Environment setup.                       *)
(***************************************************************************)
StaleRunStopsAtClaim ==
  /\ liveRun # NoIdentity
  /\ liveRun # validGeneration
  /\ liveRun # admittedRun
  /\ liveRun' = NoIdentity
  /\ UNCHANGED << generation, validGeneration, phase, runId, admittedRun,
                  descriptorGeneration, descriptorRun, closeRequested,
                  cancelPending, dispatchIssued, cancelledRuns >>

GitHubRunTerminates ==
  /\ phase \in {"starting", "ready", "closing"}
  /\ runId # NoIdentity
  /\ admittedRun \in {NoIdentity, runId}
  /\ liveRun = runId
  /\ liveRun' = NoIdentity
  /\ UNCHANGED << generation, validGeneration, phase, runId, admittedRun,
                  descriptorGeneration, descriptorRun, closeRequested,
                  cancelPending, dispatchIssued, cancelledRuns >>

(***************************************************************************)
(* Terminal reality and control-plane observation are distinct. The stable *)
(* browser entry can commit Offline; Open can instead take the direct       *)
(* ReopenAfterTerminal path above.                                          *)
(***************************************************************************)
ObserveTerminal ==
  /\ phase \in {"starting", "ready", "closing"}
  /\ runId # NoIdentity
  /\ liveRun = NoIdentity
  /\ phase' = "offline"
  /\ validGeneration' = NoIdentity
  /\ admittedRun' = NoIdentity
  /\ cancelPending' = FALSE
  /\ descriptorGeneration' = NoIdentity
  /\ descriptorRun' = NoIdentity
  /\ UNCHANGED << generation, runId, liveRun, closeRequested, dispatchIssued,
                  cancelledRuns >>

Next ==
  \/ Open
  \/ ReopenAfterTerminal
  \/ DispatchRejected
  \/ CommitDispatch
  \/ DispatchOutcomeUnknown
  \/ EarlyRunnerClaim
  \/ ReadyCallback
  \/ CloseUnclaimed
  \/ CloseKnownRun
  \/ CloseAdmitted
  \/ SendCancel
  \/ AcknowledgeCancel
  \/ StaleRunStopsAtClaim
  \/ GitHubRunTerminates
  \/ ObserveTerminal

Spec == Init /\ [][Next]_vars
             /\ WF_vars(SendCancel)
             /\ WF_vars(AcknowledgeCancel)
             /\ WF_vars(StaleRunStopsAtClaim)
             /\ WF_vars(GitHubRunTerminates)

TypeOK ==
  /\ generation \in 0..2
  /\ validGeneration \in 0..2
  /\ phase \in Phases
  /\ runId \in 0..2
  /\ liveRun \in 0..2
  /\ admittedRun \in 0..2
  /\ descriptorGeneration \in 0..2
  /\ descriptorRun \in 0..2
  /\ closeRequested \in BOOLEAN
  /\ cancelPending \in BOOLEAN
  /\ dispatchIssued \in BOOLEAN
  /\ cancelledRuns \subseteq Runs

AdmittedRunIsCurrent ==
  admittedRun = NoIdentity \/
    /\ admittedRun = generation
    /\ runId = admittedRun
    /\ phase \in {"starting", "ready", "closing"}

DescriptorIsCurrent ==
  descriptorGeneration = NoIdentity \/
    /\ phase = "ready"
    /\ ~closeRequested
    /\ descriptorGeneration = generation
    /\ descriptorRun = runId
    /\ admittedRun = runId

CloseHidesDescriptor == closeRequested => descriptorGeneration = NoIdentity

KnownRunIsCurrent ==
  phase \in {"starting", "ready"} =>
    /\ validGeneration = generation
    /\ runId = generation
    /\ liveRun \in {NoIdentity, generation}

ReadyRunIsAdmitted == phase = "ready" => admittedRun = runId

CancelResponsibilityRetained ==
  (/\ phase = "closing"
   /\ runId # NoIdentity
   /\ liveRun = runId
   /\ runId \notin cancelledRuns)
  => cancelPending

ClosingRunTerminates ==
  []((phase = "closing" /\ runId # NoIdentity /\ liveRun = runId) =>
    <>(liveRun = NoIdentity))

InvalidGenerationRunStops ==
  []((liveRun # NoIdentity /\ liveRun # validGeneration /\
      liveRun # admittedRun) =>
    <>(liveRun = NoIdentity \/ liveRun = validGeneration))

(***************************************************************************)
(* Negative witnesses preserve the concrete classes of historical defects. *)
(***************************************************************************)
BadReadyCallback ==
  /\ generation = 2
  /\ phase \in {"starting", "closing", "offline"}
  /\ phase' = "ready"
  /\ descriptorGeneration' = 1
  /\ descriptorRun' = 1
  /\ UNCHANGED << generation, validGeneration, runId, liveRun, admittedRun,
                  closeRequested, cancelPending, dispatchIssued,
                  cancelledRuns >>

BadAdmitStaleRun ==
  /\ generation = 2
  /\ validGeneration = 2
  /\ phase = "dispatching"
  /\ liveRun = 1
  /\ phase' = "starting"
  /\ runId' = 1
  /\ admittedRun' = 1
  /\ UNCHANGED << generation, validGeneration, liveRun,
                  descriptorGeneration, descriptorRun, closeRequested,
                  cancelPending, dispatchIssued, cancelledRuns >>

BadLoseCancelResponsibility ==
  /\ phase = "closing"
  /\ cancelPending
  /\ runId # NoIdentity
  /\ liveRun = runId
  /\ runId \notin cancelledRuns
  /\ cancelPending' = FALSE
  /\ UNCHANGED << generation, validGeneration, phase, runId, liveRun,
                  admittedRun, descriptorGeneration, descriptorRun,
                  closeRequested, dispatchIssued, cancelledRuns >>

ReadyBadNext == Next \/ BadReadyCallback
ReadyBadSpec == Init /\ [][ReadyBadNext]_vars

ClaimBadNext == Next \/ BadAdmitStaleRun
ClaimBadSpec == Init /\ [][ClaimBadNext]_vars

CancelBadNext == Next \/ BadLoseCancelResponsibility
CancelBadSpec == Init /\ [][CancelBadNext]_vars

====
