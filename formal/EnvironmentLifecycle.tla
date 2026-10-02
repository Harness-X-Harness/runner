------------------------ MODULE EnvironmentLifecycle ------------------------
\* Focused safety obligation for one admitted Environment. This is not a
\* refinement of EnvironmentAdmission or OrdinaryReceipt; those models keep
\* their own boundaries. No liveness: start, expiry, disconnect, and stop may
\* never occur. Observation does not release capacity or clear an expiry.
\* One execution incarnation. Stopped cannot start again. Reconnect restores
\* ready only after disconnect, not after startup, idle, or hard expiry.
\* Code seam: EnvironmentObject.readEnvironment status order.
CONSTANT FaultyExpiryCloses, FaultyStaleOpen
VARIABLES phase, reason, held, runtime, closeIntent, openDone, seenPhase, seenOpenDone
vars == <<phase, reason, held, runtime, closeIntent, openDone, seenPhase, seenOpenDone>>

Phases == {"opening", "ready", "unavailable", "closing", "closed"}
Reasons == {"none", "startup", "idle", "hard", "disconnect"}
Expiry == Reasons \ {"none"}

Init == /\ phase = "opening" /\ reason = "none" /\ held = TRUE /\ runtime = "none"
        /\ closeIntent = FALSE /\ openDone = FALSE
        /\ seenPhase = "opening" /\ seenOpenDone = FALSE

BecomeReady == /\ phase = "opening" /\ ~closeIntent
               /\ phase' = "ready" /\ reason' = "none" /\ runtime' = "live" /\ openDone' = TRUE
               /\ UNCHANGED <<held, closeIntent, seenPhase, seenOpenDone>>

\* Dispatch can become live after close intent, until this incarnation stops.
Start == /\ runtime = "none" /\ phase # "closed"
         /\ runtime' = "live"
         /\ UNCHANGED <<phase, reason, held, closeIntent, openDone, seenPhase, seenOpenDone>>

Expire(kind) == /\ kind \in Expiry /\ ~closeIntent
                /\ phase \in {"opening", "ready", "unavailable"}
                /\ (kind = "startup" => phase = "opening" /\ ~openDone)
                /\ (kind = "idle" => openDone /\ phase \in {"ready", "unavailable"})
                /\ (kind = "disconnect" => phase = "ready")
                /\ phase' = IF FaultyExpiryCloses THEN "closed" ELSE "unavailable"
                /\ reason' = kind
                /\ held' = IF FaultyExpiryCloses THEN FALSE ELSE TRUE
                /\ UNCHANGED <<runtime, closeIntent, openDone, seenPhase, seenOpenDone>>

Reconnect == /\ phase = "unavailable" /\ reason = "disconnect" /\ runtime = "live" /\ ~closeIntent
             /\ phase' = "ready" /\ reason' = "none"
             /\ UNCHANGED <<held, runtime, closeIntent, openDone, seenPhase, seenOpenDone>>

RequestClose == /\ phase \in {"opening", "ready", "unavailable"}
                /\ phase' = "closing" /\ closeIntent' = TRUE
                /\ UNCHANGED <<reason, held, runtime, openDone, seenPhase, seenOpenDone>>

\* The only release. A runtime that never became live cannot take this step.
ConfirmStop == /\ closeIntent /\ phase = "closing" /\ runtime = "live"
               /\ phase' = "closed" /\ held' = FALSE /\ runtime' = "stopped"
               /\ UNCHANGED <<reason, closeIntent, openDone, seenPhase, seenOpenDone>>

Observe == /\ seenPhase' = phase
           /\ seenOpenDone' = IF FaultyStaleOpen /\ openDone THEN TRUE ELSE phase = "ready"
           /\ UNCHANGED <<phase, reason, held, runtime, closeIntent, openDone>>

Next == BecomeReady \/ Start \/ Reconnect \/ RequestClose \/ ConfirmStop \/ Observe
     \/ \E kind \in Expiry : Expire(kind)
Spec == Init /\ [][Next]_vars

TypeOK == /\ phase \in Phases /\ reason \in Reasons /\ runtime \in {"none", "live", "stopped"}
          /\ held \in BOOLEAN /\ closeIntent \in BOOLEAN /\ openDone \in BOOLEAN
          /\ seenPhase \in Phases /\ seenOpenDone \in BOOLEAN
\* Expiry never means closure unless stop was later confirmed.
ExpiryIsNotClosure == reason \in Expiry =>
  \/ (phase \in {"unavailable", "closing"} /\ held /\ runtime # "stopped")
  \/ (phase = "closed" /\ closeIntent /\ ~held /\ runtime = "stopped")
ClosingKeepsResponsibility == phase = "closing" => held /\ closeIntent
ReadyIsLive == phase = "ready" => runtime = "live" /\ held /\ reason = "none" /\ ~closeIntent
StaleOpenIsNotReady == seenOpenDone => seenPhase = "ready"
=============================================================================
