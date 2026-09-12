------------------------- MODULE TaskLifecycle -------------------------
EXTENDS Naturals, FiniteSets
CONSTANT FaultyClaim, FaultyFinish, FaultyDeadline
VARIABLES status, binding, released, cancelledBeforeClaim, prompt,
          terminalOutcome, acceptedFinishes, ownerTouched, deadlinePassed, lateRelease
vars == <<status, binding, released, cancelledBeforeClaim, prompt,
          terminalOutcome, acceptedFinishes, ownerTouched, deadlinePassed, lateRelease>>
Executions == {"run1-attempt1", "run1-attempt2", "run2-attempt1"}
Owners == {"owner", "other"}
Terminals == {"completed", "failed", "cancelled"}

Init == /\ status = "queued" /\ binding = "none" /\ released = {}
        /\ cancelledBeforeClaim = FALSE /\ prompt = TRUE
        /\ terminalOutcome = "none" /\ acceptedFinishes = {}
        /\ ownerTouched = {}
        /\ deadlinePassed = FALSE /\ lateRelease = FALSE

Claim(e, actor) ==
  /\ actor = "owner"
  /\ (status \in {"queued", "running"} \/
      (FaultyClaim /\ status = "cancelling"))
  /\ binding \in {"none", e}
  /\ (~deadlinePassed \/ binding = e \/ FaultyDeadline)
  /\ status' = "running" /\ binding' = e /\ released' = released \cup {e}
  /\ lateRelease' = (lateRelease \/ (deadlinePassed /\ binding = "none"))
  /\ UNCHANGED <<cancelledBeforeClaim, prompt, terminalOutcome,
                 acceptedFinishes, ownerTouched, deadlinePassed>>

Cancel(actor) ==
  /\ actor = "owner" /\ status \in {"queued", "running"}
  /\ status' = "cancelling"
  /\ cancelledBeforeClaim' = (cancelledBeforeClaim \/ binding = "none")
  /\ ownerTouched' = ownerTouched \cup {actor}
  /\ UNCHANGED <<binding, released, prompt, terminalOutcome, acceptedFinishes, deadlinePassed, lateRelease>>

Finish(e, outcome) ==
  /\ e = binding /\ outcome \in {"completed", "failed"}
  /\ (status \in {"running", "cancelling"} \/
      (FaultyFinish /\ status \in Terminals))
  /\ status' = outcome /\ prompt' = FALSE
  /\ terminalOutcome' = IF terminalOutcome = "none" THEN outcome ELSE terminalOutcome
  /\ acceptedFinishes' = acceptedFinishes \cup {<<e, outcome>>}
  /\ UNCHANGED <<binding, released, cancelledBeforeClaim, ownerTouched, deadlinePassed, lateRelease>>

SystemEnd(outcome) ==
  /\ status \notin Terminals
  /\ outcome \in {"failed", "cancelled"}
  /\ (outcome = "cancelled" => status = "cancelling" \/ binding # "none")
  /\ status' = outcome /\ prompt' = FALSE /\ terminalOutcome' = outcome
  /\ UNCHANGED <<binding, released, cancelledBeforeClaim,
                 acceptedFinishes, ownerTouched, deadlinePassed, lateRelease>>

Elapsed == /\ ~deadlinePassed /\ deadlinePassed' = TRUE
           /\ UNCHANGED <<status, binding, released, cancelledBeforeClaim, prompt,
                          terminalOutcome, acceptedFinishes, ownerTouched, lateRelease>>

ExpireUnclaimed == /\ deadlinePassed /\ binding = "none"
                   /\ SystemEnd(IF status = "cancelling" THEN "cancelled" ELSE "failed")

Next == (\E e \in Executions, actor \in Owners: Claim(e, actor))
     \/ (\E actor \in Owners: Cancel(actor))
     \/ (\E e \in Executions, outcome \in {"completed", "failed"}: Finish(e, outcome))
     \/ (\E outcome \in {"failed", "cancelled"}: SystemEnd(outcome))
     \/ Elapsed \/ ExpireUnclaimed
     \/ UNCHANGED vars

Spec == Init /\ [][Next]_vars
TypeOK == /\ status \in {"queued", "running", "cancelling"} \cup Terminals
          /\ binding \in Executions \cup {"none"}
          /\ released \subseteq Executions
OneExecution == Cardinality(released) <= 1
NoPromptAfterCancel == cancelledBeforeClaim => released = {}
NoLateFirstClaim == ~lateRelease
TerminalImmutable == terminalOutcome # "none" => status = terminalOutcome
TerminalPrivateDataDeleted == status \in Terminals => ~prompt
FinishBoundToExecution == \A f \in acceptedFinishes: f[1] = binding
OwnerIsolation == ownerTouched \subseteq {"owner"}
=============================================================================
