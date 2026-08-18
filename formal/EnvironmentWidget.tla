---- MODULE EnvironmentWidget ----

(***************************************************************************)
(* Focused obligation for the Environment Widget while one explicit Open   *)
(* intent remains active. The backend owns Environment lifecycle state.    *)
(* The Widget owns only its displayed snapshot, one timer, and one tool     *)
(* call. An explicit Close supersedes the local Open intent.                *)
(***************************************************************************)

VARIABLES authorityPhase,
          displayedPhase,
          intent,
          timerArmed,
          callPending,
          failureAvailable

vars == << authorityPhase, displayedPhase, intent, timerArmed,
           callPending, failureAvailable >>

Phases == {"closing", "offline", "starting", "ready"}
ObservedOpenPhases == {"closing", "starting"}
Intents == {"open", "closed"}

Init ==
  /\ authorityPhase \in ObservedOpenPhases
  /\ displayedPhase = authorityPhase
  /\ intent = "open"
  /\ timerArmed = TRUE
  /\ callPending = FALSE
  /\ failureAvailable = TRUE

ArmOpenRefresh ==
  /\ intent = "open"
  /\ displayedPhase \in ObservedOpenPhases
  /\ ~timerArmed
  /\ ~callPending
  /\ timerArmed' = TRUE
  /\ UNCHANGED << authorityPhase, displayedPhase, intent, callPending,
                  failureAvailable >>

TimerFires ==
  /\ intent = "open"
  /\ timerArmed
  /\ ~callPending
  /\ timerArmed' = FALSE
  /\ callPending' = TRUE
  /\ UNCHANGED << authorityPhase, displayedPhase, intent,
                  failureAvailable >>

(***************************************************************************)
(* The finite obligation admits one transient MCP failure. The active Open *)
(* intent rearms the timer instead of becoming a stale snapshot.           *)
(***************************************************************************)
OpenCallFails ==
  /\ intent = "open"
  /\ callPending
  /\ failureAvailable
  /\ callPending' = FALSE
  /\ failureAvailable' = FALSE
  /\ UNCHANGED << authorityPhase, displayedPhase, intent, timerArmed >>

OpenReturnsCurrent ==
  /\ intent = "open"
  /\ callPending
  /\ authorityPhase \in {"closing", "starting", "ready"}
  /\ displayedPhase' = authorityPhase
  /\ callPending' = FALSE
  /\ UNCHANGED << authorityPhase, intent, timerArmed, failureAvailable >>

(***************************************************************************)
(* An Open that observes terminal evidence creates one replacement through *)
(* the backend contract. The Widget observes only the resulting Starting   *)
(* phase; replacement dispatch safety remains in EnvironmentReopen.tla.    *)
(***************************************************************************)
OpenStartsReplacement ==
  /\ intent = "open"
  /\ callPending
  /\ authorityPhase = "offline"
  /\ authorityPhase' = "starting"
  /\ displayedPhase' = "starting"
  /\ callPending' = FALSE
  /\ UNCHANGED << intent, timerArmed, failureAvailable >>

GitHubRunTerminates ==
  /\ authorityPhase = "closing"
  /\ authorityPhase' = "offline"
  /\ UNCHANGED << displayedPhase, intent, timerArmed, callPending,
                  failureAvailable >>

ReadyCallback ==
  /\ authorityPhase = "starting"
  /\ authorityPhase' = "ready"
  /\ UNCHANGED << displayedPhase, intent, timerArmed, callPending,
                  failureAvailable >>

ExplicitClose ==
  /\ intent = "open"
  /\ authorityPhase \in {"starting", "ready"}
  /\ ~callPending
  /\ authorityPhase' = "closing"
  /\ displayedPhase' = "closing"
  /\ intent' = "closed"
  /\ timerArmed' = FALSE
  /\ UNCHANGED << callPending, failureAvailable >>

CoreNext ==
  \/ TimerFires
  \/ OpenCallFails
  \/ OpenReturnsCurrent
  \/ OpenStartsReplacement
  \/ GitHubRunTerminates
  \/ ReadyCallback
  \/ ExplicitClose

Next == ArmOpenRefresh \/ CoreNext

Spec == Init /\ [][Next]_vars
               /\ WF_vars(ArmOpenRefresh)
               /\ WF_vars(TimerFires)
               /\ WF_vars(OpenReturnsCurrent)
               /\ WF_vars(OpenStartsReplacement)
               /\ WF_vars(GitHubRunTerminates)
               /\ WF_vars(ReadyCallback)

TypeOK ==
  /\ authorityPhase \in Phases
  /\ displayedPhase \in Phases
  /\ intent \in Intents
  /\ timerArmed \in BOOLEAN
  /\ callPending \in BOOLEAN
  /\ failureAvailable \in BOOLEAN

ClosedIntentHasNoOpenWork ==
  intent = "closed" => ~timerArmed /\ ~callPending

ReadyDisplayHasNoOpenWork ==
  displayedPhase = "ready" => ~timerArmed /\ ~callPending

OpenIntentConverges ==
  []((intent = "open") => <>(displayedPhase = "ready" \/ intent = "closed"))

(***************************************************************************)
(* Historical fault: only Closing rearms. After replacement or an initial  *)
(* Starting result, the display remains Starting even after Ready.         *)
(***************************************************************************)
BadArmOnlyClosing ==
  /\ intent = "open"
  /\ displayedPhase = "closing"
  /\ ~timerArmed
  /\ ~callPending
  /\ timerArmed' = TRUE
  /\ UNCHANGED << authorityPhase, displayedPhase, intent, callPending,
                  failureAvailable >>

BadRefreshNext == BadArmOnlyClosing \/ CoreNext

BadRefreshSpec == Init /\ [][BadRefreshNext]_vars
                         /\ WF_vars(BadArmOnlyClosing)
                         /\ WF_vars(TimerFires)
                         /\ WF_vars(OpenReturnsCurrent)
                         /\ WF_vars(OpenStartsReplacement)
                         /\ WF_vars(GitHubRunTerminates)
                         /\ WF_vars(ReadyCallback)

BadArmAfterClose ==
  /\ intent = "closed"
  /\ displayedPhase = "closing"
  /\ ~timerArmed
  /\ ~callPending
  /\ timerArmed' = TRUE
  /\ UNCHANGED << authorityPhase, displayedPhase, intent, callPending,
                  failureAvailable >>

BadCloseNext == Next \/ BadArmAfterClose
BadCloseSpec == Init /\ [][BadCloseNext]_vars

====
