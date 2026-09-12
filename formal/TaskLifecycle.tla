------------------------- MODULE TaskLifecycle -------------------------
EXTENDS Naturals, FiniteSets
CONSTANT FaultyClaim, FaultyFinish
VARIABLES status, binding, released, cancelledBeforeClaim, prompt,
          terminalOutcome, acceptedFinishes, ownerTouched
vars == <<status, binding, released, cancelledBeforeClaim, prompt,
          terminalOutcome, acceptedFinishes, ownerTouched>>
Executions == {"run1-attempt1", "run1-attempt2", "run2-attempt1"}
Owners == {"owner", "other"}
Terminals == {"completed", "failed", "cancelled"}

Init == /\ status = "queued" /\ binding = "none" /\ released = {}
        /\ cancelledBeforeClaim = FALSE /\ prompt = TRUE
        /\ terminalOutcome = "none" /\ acceptedFinishes = {}
        /\ ownerTouched = {}

Claim(e, actor) ==
  /\ actor = "owner"
  /\ (status \in {"queued", "running"} \/
      (FaultyClaim /\ status = "cancelling"))
  /\ binding \in {"none", e}
  /\ status' = "running" /\ binding' = e /\ released' = released \cup {e}
  /\ UNCHANGED <<cancelledBeforeClaim, prompt, terminalOutcome,
                 acceptedFinishes, ownerTouched>>

Cancel(actor) ==
  /\ actor = "owner" /\ status \in {"queued", "running"}
  /\ status' = "cancelling"
  /\ cancelledBeforeClaim' = (cancelledBeforeClaim \/ binding = "none")
  /\ ownerTouched' = ownerTouched \cup {actor}
  /\ UNCHANGED <<binding, released, prompt, terminalOutcome, acceptedFinishes>>

Finish(e, outcome) ==
  /\ e = binding /\ outcome \in {"completed", "failed"}
  /\ (status \in {"running", "cancelling"} \/
      (FaultyFinish /\ status \in Terminals))
  /\ status' = outcome /\ prompt' = FALSE
  /\ terminalOutcome' = IF terminalOutcome = "none" THEN outcome ELSE terminalOutcome
  /\ acceptedFinishes' = acceptedFinishes \cup {<<e, outcome>>}
  /\ UNCHANGED <<binding, released, cancelledBeforeClaim, ownerTouched>>

SystemEnd(outcome) ==
  /\ status \notin Terminals
  /\ outcome \in {"failed", "cancelled"}
  /\ (outcome = "cancelled" => status = "cancelling" \/ binding # "none")
  /\ status' = outcome /\ prompt' = FALSE /\ terminalOutcome' = outcome
  /\ UNCHANGED <<binding, released, cancelledBeforeClaim,
                 acceptedFinishes, ownerTouched>>

Next == (\E e \in Executions, actor \in Owners: Claim(e, actor))
     \/ (\E actor \in Owners: Cancel(actor))
     \/ (\E e \in Executions, outcome \in {"completed", "failed"}: Finish(e, outcome))
     \/ (\E outcome \in {"failed", "cancelled"}: SystemEnd(outcome))
     \/ UNCHANGED vars

Spec == Init /\ [][Next]_vars
TypeOK == /\ status \in {"queued", "running", "cancelling"} \cup Terminals
          /\ binding \in Executions \cup {"none"}
          /\ released \subseteq Executions
OneExecution == Cardinality(released) <= 1
NoPromptAfterCancel == cancelledBeforeClaim => released = {}
TerminalImmutable == terminalOutcome # "none" => status = terminalOutcome
TerminalPrivateDataDeleted == status \in Terminals => ~prompt
FinishBoundToExecution == \A f \in acceptedFinishes: f[1] = binding
OwnerIsolation == ownerTouched \subseteq {"owner"}
=============================================================================
