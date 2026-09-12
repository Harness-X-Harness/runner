--------------------------- MODULE LegacyRetirement ---------------------------
EXTENDS Naturals
CONSTANT AllowRetiredAdmission
VARIABLES draining, pending, remoteRun, released, lateRelease
vars == <<draining, pending, remoteRun, released, lateRelease>>

Init == /\ draining = FALSE /\ pending = FALSE /\ remoteRun = FALSE
        /\ released = FALSE /\ lateRelease = FALSE

Reserve == /\ ~pending /\ ~draining
           /\ pending' = TRUE
           /\ UNCHANGED <<draining, remoteRun, released, lateRelease>>

\* An already issued HTTP operation can finish after the deployment boundary.
Dispatch == /\ pending /\ ~remoteRun
            /\ remoteRun' = TRUE
            /\ UNCHANGED <<draining, pending, released, lateRelease>>

Retire == /\ ~draining /\ draining' = TRUE
          /\ UNCHANGED <<pending, remoteRun, released, lateRelease>>

Claim == /\ remoteRun /\ ~released
         /\ (~draining \/ AllowRetiredAdmission)
         /\ released' = TRUE /\ lateRelease' = draining
         /\ UNCHANGED <<draining, pending, remoteRun>>

Next == Reserve \/ Dispatch \/ Retire \/ Claim
Spec == Init /\ [][Next]_vars
TypeOK == /\ draining \in BOOLEAN /\ pending \in BOOLEAN /\ remoteRun \in BOOLEAN
          /\ released \in BOOLEAN /\ lateRelease \in BOOLEAN
NoLateLegacyAdmission == ~lateRelease
=============================================================================
