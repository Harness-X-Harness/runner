---------------------- MODULE EnvironmentAdmission ----------------------
EXTENDS Naturals, FiniteSets
CONSTANT EarlyRelease
VARIABLES reserved, issued, live, closing, stopped
vars == <<reserved, issued, live, closing, stopped>>

\* Two competing operations for one owner plus an independent owner.
Environments == {"a1", "a2", "b1"}
Owner(e) == IF e = "b1" THEN "b" ELSE "a"
Limit == 2
Init == /\ reserved = {} /\ issued = {} /\ live = {}
        /\ closing = {} /\ stopped = {}

\* Admission is one atomic authority operation; external dispatch is separate.
Reserve(e) ==
  /\ e \notin issued
  /\ Cardinality(reserved) < Limit
  /\ \A r \in reserved : Owner(r) # Owner(e)
  /\ reserved' = reserved \cup {e}
  /\ issued' = issued \cup {e}
  /\ UNCHANGED <<live, closing, stopped>>

\* Dispatch can become visible after close intent. Each ID has one runtime.
Start(e) ==
  /\ e \in issued \ (live \cup stopped)
  /\ live' = live \cup {e}
  /\ UNCHANGED <<reserved, issued, closing, stopped>>
Close(e) ==
  /\ e \in issued \ (closing \cup stopped)
  /\ closing' = closing \cup {e}
  /\ reserved' = IF EarlyRelease THEN reserved \ {e} ELSE reserved
  /\ UNCHANGED <<issued, live, stopped>>
\* Trusted exact-runtime observation, not a cancel ACK or an observation error.
ConfirmStop(e) ==
  /\ e \in live \cap closing
  /\ live' = live \ {e}
  /\ stopped' = stopped \cup {e}
  /\ reserved' = reserved \ {e}
  /\ UNCHANGED <<issued, closing>>

Next == \E e \in Environments : Reserve(e) \/ Start(e) \/ Close(e) \/ ConfirmStop(e)
Spec == Init /\ [][Next]_vars
TypeOK == /\ reserved \subseteq Environments /\ issued \subseteq Environments
          /\ live \subseteq issued /\ closing \subseteq issued /\ stopped \subseteq issued
          /\ live \cap stopped = {}
RetainResponsibility == issued \ stopped \subseteq reserved
Capacity == /\ Cardinality(live) <= Limit
            /\ \A x,y \in live : Owner(x) = Owner(y) => x = y
=============================================================================
