---- MODULE EnvironmentWidget ----

EXTENDS Naturals

(***************************************************************************)
(* The backend owns the Environment lifecycle. The Widget may observe that *)
(* authority. Only one explicit user Open, or the one replacement reserved *)
(* when that Open first sees Closing, may mutate it.                        *)
(***************************************************************************)

VARIABLES authorityPhase,
          displayedPhase,
          intent,
          timerArmed,
          callKind,
          failureAvailable,
          replacementBudget,
          replacementCount

vars == << authorityPhase, displayedPhase, intent, timerArmed, callKind,
           failureAvailable, replacementBudget, replacementCount >>

Phases == {"closing", "offline", "starting", "ready"}
Intents == {"open", "closed"}
CallKinds == {"none", "observe", "replace"}

Init ==
  /\ authorityPhase \in {"closing", "starting"}
  /\ displayedPhase = authorityPhase
  /\ intent = "open"
  /\ timerArmed = TRUE
  /\ callKind = "none"
  /\ failureAvailable = TRUE
  /\ replacementBudget = IF authorityPhase = "closing" THEN 1 ELSE 0
  /\ replacementCount = 0

CanObserve ==
  intent = "open" /\
    (displayedPhase = "starting" \/
      (displayedPhase = "closing" /\ replacementBudget = 1))

ArmObservation ==
  /\ CanObserve
  /\ ~timerArmed
  /\ callKind = "none"
  /\ timerArmed' = TRUE
  /\ UNCHANGED << authorityPhase, displayedPhase, intent, callKind,
                  failureAvailable, replacementBudget, replacementCount >>

TimerFires ==
  /\ CanObserve
  /\ timerArmed
  /\ callKind = "none"
  /\ timerArmed' = FALSE
  /\ callKind' = "observe"
  /\ UNCHANGED << authorityPhase, displayedPhase, intent,
                  failureAvailable, replacementBudget, replacementCount >>

ObservationFails ==
  /\ intent = "open"
  /\ callKind = "observe"
  /\ failureAvailable
  /\ callKind' = "none"
  /\ failureAvailable' = FALSE
  /\ UNCHANGED << authorityPhase, displayedPhase, intent, timerArmed,
                  replacementBudget, replacementCount >>

ObserveStarting ==
  /\ intent = "open"
  /\ callKind = "observe"
  /\ authorityPhase = "starting"
  /\ displayedPhase' = "starting"
  /\ callKind' = "none"
  /\ UNCHANGED << authorityPhase, intent, timerArmed, failureAvailable,
                  replacementBudget, replacementCount >>

ObserveReady ==
  /\ intent = "open"
  /\ callKind = "observe"
  /\ authorityPhase = "ready"
  /\ displayedPhase' = "ready"
  /\ intent' = "closed"
  /\ timerArmed' = FALSE
  /\ callKind' = "none"
  /\ UNCHANGED << authorityPhase, failureAvailable, replacementBudget,
                  replacementCount >>

ObserveClosing ==
  /\ intent = "open"
  /\ callKind = "observe"
  /\ authorityPhase = "closing"
  /\ displayedPhase' = "closing"
  /\ callKind' = "none"
  /\ IF replacementBudget = 1
       THEN UNCHANGED << intent, timerArmed >>
       ELSE /\ intent' = "closed"
            /\ timerArmed' = FALSE
  /\ UNCHANGED << authorityPhase, failureAvailable, replacementBudget,
                  replacementCount >>

ObserveOffline ==
  /\ intent = "open"
  /\ callKind = "observe"
  /\ authorityPhase = "offline"
  /\ displayedPhase' = "offline"
  /\ timerArmed' = FALSE
  /\ IF replacementBudget = 1
       THEN /\ callKind' = "replace"
            /\ replacementBudget' = 0
            /\ replacementCount' = replacementCount + 1
            /\ UNCHANGED intent
       ELSE /\ callKind' = "none"
            /\ intent' = "closed"
            /\ UNCHANGED << replacementBudget, replacementCount >>
  /\ UNCHANGED << authorityPhase, failureAvailable >>

ReplacementStarts ==
  /\ intent = "open"
  /\ callKind = "replace"
  /\ authorityPhase = "offline"
  /\ authorityPhase' = "starting"
  /\ displayedPhase' = "starting"
  /\ callKind' = "none"
  /\ UNCHANGED << intent, timerArmed, failureAvailable, replacementBudget,
                  replacementCount >>

(***************************************************************************)
(* A GitHub run may terminate before Ready. This production transition was *)
(* missing from the previous model and hid an unbounded replacement loop.  *)
(***************************************************************************)
GitHubRunTerminates ==
  /\ authorityPhase \in {"closing", "starting"}
  /\ authorityPhase' = "offline"
  /\ UNCHANGED << displayedPhase, intent, timerArmed, callKind,
                  failureAvailable, replacementBudget, replacementCount >>

ReadyCallback ==
  /\ authorityPhase = "starting"
  /\ authorityPhase' = "ready"
  /\ UNCHANGED << displayedPhase, intent, timerArmed, callKind,
                  failureAvailable, replacementBudget, replacementCount >>

(***************************************************************************)
(* A Close from this or another client revokes automatic replacement. The  *)
(* Widget can learn an external Close on its next observation.              *)
(***************************************************************************)
ExternalClose ==
  /\ authorityPhase \in {"starting", "ready"}
  /\ authorityPhase' = "closing"
  /\ replacementBudget' = 0
  /\ UNCHANGED << displayedPhase, intent, timerArmed, callKind,
                  failureAvailable, replacementCount >>

ExplicitClose ==
  /\ intent = "open"
  /\ authorityPhase \in {"starting", "ready", "closing"}
  /\ callKind = "none"
  /\ authorityPhase' = "closing"
  /\ displayedPhase' = "closing"
  /\ intent' = "closed"
  /\ timerArmed' = FALSE
  /\ replacementBudget' = 0
  /\ UNCHANGED << callKind, failureAvailable, replacementCount >>

CoreNext ==
  \/ TimerFires
  \/ ObservationFails
  \/ ObserveStarting
  \/ ObserveReady
  \/ ObserveClosing
  \/ ObserveOffline
  \/ ReplacementStarts
  \/ GitHubRunTerminates
  \/ ReadyCallback
  \/ ExternalClose
  \/ ExplicitClose

Next == ArmObservation \/ CoreNext

Spec == Init /\ [][Next]_vars
               /\ WF_vars(ArmObservation)
               /\ WF_vars(TimerFires)
               /\ WF_vars(ObserveStarting)
               /\ WF_vars(ObserveReady)
               /\ WF_vars(ObserveClosing)
               /\ WF_vars(ObserveOffline)
               /\ WF_vars(ReplacementStarts)
               /\ WF_vars(GitHubRunTerminates)
               /\ WF_vars(ReadyCallback)

TypeOK ==
  /\ authorityPhase \in Phases
  /\ displayedPhase \in Phases
  /\ intent \in Intents
  /\ timerArmed \in BOOLEAN
  /\ callKind \in CallKinds
  /\ failureAvailable \in BOOLEAN
  /\ replacementBudget \in 0..1
  /\ replacementCount \in 0..2

ClosedIntentHasNoOpenWork ==
  intent = "closed" => ~timerArmed /\ callKind = "none"

ReadyDisplayHasNoOpenWork ==
  displayedPhase = "ready" => ~timerArmed /\ callKind = "none"

AtMostOneReplacement == replacementCount <= 1

OpenIntentConverges ==
  []((intent = "open") => <>(displayedPhase = "ready" \/ intent = "closed"))

(***************************************************************************)
(* Historical fault: only Closing rearms, so Starting can stay stale.      *)
(***************************************************************************)
BadArmOnlyClosing ==
  /\ intent = "open"
  /\ displayedPhase = "closing"
  /\ replacementBudget = 1
  /\ ~timerArmed
  /\ callKind = "none"
  /\ timerArmed' = TRUE
  /\ UNCHANGED << authorityPhase, displayedPhase, intent, callKind,
                  failureAvailable, replacementBudget, replacementCount >>

BadRefreshNext == BadArmOnlyClosing \/ CoreNext
BadRefreshSpec == Init /\ [][BadRefreshNext]_vars
                         /\ WF_vars(BadArmOnlyClosing)
                         /\ WF_vars(TimerFires)
                         /\ WF_vars(ObserveStarting)
                         /\ WF_vars(ObserveReady)
                         /\ WF_vars(ObserveClosing)
                         /\ WF_vars(ObserveOffline)
                         /\ WF_vars(ReplacementStarts)
                         /\ WF_vars(GitHubRunTerminates)
                         /\ WF_vars(ReadyCallback)

BadArmAfterClose ==
  /\ intent = "closed"
  /\ displayedPhase = "closing"
  /\ ~timerArmed
  /\ callKind = "none"
  /\ timerArmed' = TRUE
  /\ UNCHANGED << authorityPhase, displayedPhase, intent, callKind,
                  failureAvailable, replacementBudget, replacementCount >>

BadCloseNext == Next \/ BadArmAfterClose
BadCloseSpec == Init /\ [][BadCloseNext]_vars

(***************************************************************************)
(* Production fault: an observation was implemented as a mutating Open. It *)
(* could dispatch another replacement after the first replacement failed.  *)
(***************************************************************************)
BadRepeatReplacement ==
  /\ intent = "open"
  /\ callKind = "observe"
  /\ authorityPhase = "offline"
  /\ replacementBudget = 0
  /\ authorityPhase' = "starting"
  /\ displayedPhase' = "starting"
  /\ callKind' = "none"
  /\ replacementCount' = replacementCount + 1
  /\ UNCHANGED << intent, timerArmed, failureAvailable, replacementBudget >>

BadReplacementNext == Next \/ BadRepeatReplacement
BadReplacementSpec == Init /\ [][BadReplacementNext]_vars

====
