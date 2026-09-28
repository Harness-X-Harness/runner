-------------------------- MODULE TaskObservation --------------------------
EXTENDS Naturals

\* Focused obligation: a committed change cannot disappear while an older
\* authority read is in flight. One observer, one Task, two revisions suffice
\* to expose this race. The authority commits state and signals synchronously.
\* A read may never finish (stuttering); no fairness or delivery-time claim.
\* Excludes disconnect, authorization, persistence, and cross-process signals.
CONSTANT LoseInvalidation
VARIABLES current, subscribed, dirty, reading, captured, seen
vars == <<current, subscribed, dirty, reading, captured, seen>>

Init == /\ current = 0 /\ subscribed = FALSE /\ dirty = FALSE
        /\ reading = FALSE /\ captured = 0 /\ seen = 0

Subscribe == /\ ~subscribed
             /\ subscribed' = TRUE /\ dirty' = TRUE
             /\ UNCHANGED <<current, reading, captured, seen>>

Commit == /\ current = 0 /\ current' = 1
          /\ dirty' = IF subscribed THEN TRUE ELSE dirty
          /\ UNCHANGED <<subscribed, reading, captured, seen>>

BeginRead == /\ subscribed /\ dirty /\ ~reading
             /\ reading' = TRUE /\ dirty' = FALSE /\ captured' = current
             /\ UNCHANGED <<subscribed, current, seen>>

FinishRead == /\ reading /\ reading' = FALSE /\ seen' = captured
              /\ dirty' = IF LoseInvalidation THEN FALSE ELSE dirty
              /\ UNCHANGED <<subscribed, current, captured>>

Next == Subscribe \/ Commit \/ BeginRead \/ FinishRead
Spec == Init /\ [][Next]_vars

TypeOK == /\ current \in 0..1 /\ captured \in 0..1 /\ seen \in 0..1
          /\ subscribed \in BOOLEAN /\ dirty \in BOOLEAN /\ reading \in BOOLEAN
NoLostWake == (subscribed /\ current = 1 /\ ~reading /\ seen = 0) => dirty
=============================================================================
