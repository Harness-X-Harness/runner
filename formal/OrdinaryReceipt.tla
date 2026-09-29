-------------------------- MODULE OrdinaryReceipt --------------------------
EXTENDS Naturals

\* Focused safety obligation for one ordinary receipt. The receipt is one cut:
\* open is currently finished only when that cut says ready, and cleanup is
\* confirmed only when that cut says closed. A historical selection must still
\* show an active input question from the same cut.
\* FaultyOpenSummary repeats the verified summary defect: a completed open
\* operation marks the receipt finished after the environment is unavailable.
\* FaultyHideQuestion repeats the verified inspect defect: selecting history
\* hides the active question.
\* No fairness and no client polling obligation. This is not a refinement of
\* TaskLifecycle or TaskObservation. It does not model two storage reads, owner
\* checks, Tasks selection, idempotency, or external cleanup.
CONSTANT FaultyOpenSummary, FaultyHideQuestion
VARIABLES env, openOp, active, selected, seen, recEnv, openFinished,
          cleanupConfirmed, cutWaiting, cutHistorical, showsQuestion
vars == <<env, openOp, active, selected, seen, recEnv, openFinished,
          cleanupConfirmed, cutWaiting, cutHistorical, showsQuestion>>
Env == {"opening", "ready", "unavailable", "closing", "closed"}
receipt == <<seen, recEnv, openFinished, cleanupConfirmed, cutWaiting, cutHistorical, showsQuestion>>

Init == /\ env = "opening" /\ openOp = "working" /\ active = "none" /\ selected = "current"
        /\ seen = FALSE /\ recEnv = "opening" /\ openFinished = FALSE
        /\ cleanupConfirmed = FALSE /\ cutWaiting = FALSE /\ cutHistorical = FALSE
        /\ showsQuestion = FALSE

BecomeReady == /\ env = "opening" /\ env' = "ready" /\ openOp' = "completed"
               /\ UNCHANGED <<active, selected, receipt>>

Disconnect == /\ env = "ready" /\ env' = "unavailable"
              /\ UNCHANGED <<openOp, active, selected, receipt>>

StartClose == /\ env \in {"opening", "ready", "unavailable"} /\ env' = "closing"
              /\ UNCHANGED <<openOp, active, selected, receipt>>

ConfirmClose == /\ env = "closing" /\ env' = "closed" /\ active' = "none"
                /\ UNCHANGED <<openOp, selected, receipt>>

Ask == /\ env = "ready" /\ active = "none" /\ active' = "waiting"
       /\ UNCHANGED <<env, openOp, selected, receipt>>

SelectHistorical == /\ selected = "current" /\ selected' = "historical"
                    /\ UNCHANGED <<env, openOp, active, receipt>>

Observe == /\ seen' = TRUE /\ recEnv' = env
           /\ openFinished' = IF FaultyOpenSummary /\ openOp = "completed" THEN TRUE ELSE env = "ready"
           /\ cleanupConfirmed' = (env = "closed")
           /\ cutWaiting' = (active = "waiting")
           /\ cutHistorical' = (selected = "historical")
           /\ showsQuestion' = IF FaultyHideQuestion /\ selected = "historical"
                               THEN FALSE ELSE active = "waiting"
           /\ UNCHANGED <<env, openOp, active, selected>>

Next == BecomeReady \/ Disconnect \/ StartClose \/ ConfirmClose \/ Ask
     \/ SelectHistorical \/ Observe
Spec == Init /\ [][Next]_vars

TypeOK == /\ env \in Env /\ recEnv \in Env
          /\ openOp \in {"working", "completed"}
          /\ active \in {"none", "waiting"} /\ selected \in {"current", "historical"}
          /\ seen \in BOOLEAN /\ openFinished \in BOOLEAN /\ cleanupConfirmed \in BOOLEAN
          /\ cutWaiting \in BOOLEAN /\ cutHistorical \in BOOLEAN /\ showsQuestion \in BOOLEAN
OpenFinishedMeansReady == seen => (openFinished => recEnv = "ready")
CleanupMeansClosed == seen => (cleanupConfirmed => recEnv = "closed")
ActiveQuestionVisible == seen => (cutHistorical /\ cutWaiting => showsQuestion)
=============================================================================
