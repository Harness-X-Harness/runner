---- MODULE SessionWidgetTakeover ----
EXTENDS Naturals, FiniteSets

(***************************************************************************)
(* Focused obligation for one Session Widget per MCP Client. The Durable   *)
(* Object owns Controller authority and a monotonic event cursor. A client *)
(* click can wait indefinitely for host approval or request delivery. A    *)
(* committed response can be delayed or lost while another client commits *)
(* and a stream observation arrives first.                                *)
(*                                                                         *)
(* This is not a refinement of the complete AgentSessions model. It checks *)
(* only that lower-cursor snapshots cannot regress one client's displayed  *)
(* Controller after a newer observation.                                  *)
(***************************************************************************)

CONSTANTS Clients, InitialController, MaxCursor

ASSUME /\ Cardinality(Clients) = 2
       /\ InitialController \in Clients
       /\ MaxCursor = 2

OpPhases == {
  "idle", "awaitingApproval", "approved", "committed",
  "responded", "denied", "failed", "unknown"
}

VARIABLES controller,
          authorityCursor,
          sessionMutable,
          opPhase,
          responseController,
          responseCursor,
          viewController,
          viewCursor,
          regressed

vars == << controller, authorityCursor, sessionMutable, opPhase,
           responseController, responseCursor, viewController, viewCursor,
           regressed >>

Init ==
  /\ controller = InitialController
  /\ authorityCursor = 0
  /\ sessionMutable = TRUE
  /\ opPhase = [c \in Clients |-> "idle"]
  /\ responseController = [c \in Clients |-> InitialController]
  /\ responseCursor = [c \in Clients |-> 0]
  /\ viewController = [c \in Clients |-> InitialController]
  /\ viewCursor = [c \in Clients |-> 0]
  /\ regressed = FALSE

Invoke(c) ==
  /\ opPhase[c] = "idle"
  /\ opPhase' = [opPhase EXCEPT ![c] = "awaitingApproval"]
  /\ UNCHANGED << controller, authorityCursor, sessionMutable,
                  responseController, responseCursor, viewController,
                  viewCursor, regressed >>

Approve(c) ==
  /\ opPhase[c] = "awaitingApproval"
  /\ opPhase' = [opPhase EXCEPT ![c] = "approved"]
  /\ UNCHANGED << controller, authorityCursor, sessionMutable,
                  responseController, responseCursor, viewController,
                  viewCursor, regressed >>

Deny(c) ==
  /\ opPhase[c] = "awaitingApproval"
  /\ opPhase' = [opPhase EXCEPT ![c] = "denied"]
  /\ UNCHANGED << controller, authorityCursor, sessionMutable,
                  responseController, responseCursor, viewController,
                  viewCursor, regressed >>

Commit(c) ==
  /\ opPhase[c] = "approved"
  /\ sessionMutable
  /\ IF c = controller
        THEN /\ controller' = controller
             /\ authorityCursor' = authorityCursor
        ELSE /\ authorityCursor < MaxCursor
             /\ controller' = c
             /\ authorityCursor' = authorityCursor + 1
  /\ opPhase' = [opPhase EXCEPT ![c] = "committed"]
  /\ responseController' = [responseController EXCEPT ![c] = controller']
  /\ responseCursor' = [responseCursor EXCEPT ![c] = authorityCursor']
  /\ UNCHANGED << sessionMutable, viewController, viewCursor, regressed >>

RejectAfterTerminal(c) ==
  /\ opPhase[c] = "approved"
  /\ ~sessionMutable
  /\ opPhase' = [opPhase EXCEPT ![c] = "failed"]
  /\ UNCHANGED << controller, authorityCursor, sessionMutable,
                  responseController, responseCursor, viewController,
                  viewCursor, regressed >>

LoseResponse(c) ==
  /\ opPhase[c] = "committed"
  /\ opPhase' = [opPhase EXCEPT ![c] = "unknown"]
  /\ UNCHANGED << controller, authorityCursor, sessionMutable,
                  responseController, responseCursor, viewController,
                  viewCursor, regressed >>

ObserveStream(c) ==
  /\ viewCursor[c] < authorityCursor
  /\ viewController' = [viewController EXCEPT ![c] = controller]
  /\ viewCursor' = [viewCursor EXCEPT ![c] = authorityCursor]
  /\ UNCHANGED << controller, authorityCursor, sessionMutable, opPhase,
                  responseController, responseCursor, regressed >>

DeliverFreshResponse(c) ==
  /\ opPhase[c] = "committed"
  /\ opPhase' = [opPhase EXCEPT ![c] = "responded"]
  /\ IF responseCursor[c] >= viewCursor[c]
        THEN /\ viewController' = [viewController EXCEPT
                                     ![c] = responseController[c]]
             /\ viewCursor' = [viewCursor EXCEPT ![c] = responseCursor[c]]
        ELSE /\ UNCHANGED << viewController, viewCursor >>
  /\ UNCHANGED << controller, authorityCursor, sessionMutable,
                  responseController, responseCursor, regressed >>

Terminate ==
  /\ sessionMutable
  /\ sessionMutable' = FALSE
  /\ UNCHANGED << controller, authorityCursor, opPhase,
                  responseController, responseCursor, viewController,
                  viewCursor, regressed >>

CoreNext ==
  \/ \E c \in Clients: Invoke(c)
  \/ \E c \in Clients: Approve(c)
  \/ \E c \in Clients: Deny(c)
  \/ \E c \in Clients: Commit(c)
  \/ \E c \in Clients: RejectAfterTerminal(c)
  \/ \E c \in Clients: LoseResponse(c)
  \/ \E c \in Clients: ObserveStream(c)
  \/ Terminate

Next == CoreNext \/ \E c \in Clients: DeliverFreshResponse(c)

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ controller \in Clients
  /\ authorityCursor \in 0..MaxCursor
  /\ sessionMutable \in BOOLEAN
  /\ opPhase \in [Clients -> OpPhases]
  /\ responseController \in [Clients -> Clients]
  /\ responseCursor \in [Clients -> 0..MaxCursor]
  /\ viewController \in [Clients -> Clients]
  /\ viewCursor \in [Clients -> 0..MaxCursor]
  /\ regressed \in BOOLEAN

ResponseDoesNotLeadAuthority ==
  \A c \in Clients: responseCursor[c] <= authorityCursor

LatestViewIsAuthoritative ==
  \A c \in Clients:
    viewCursor[c] = authorityCursor => viewController[c] = controller

ViewCursorNeverRegresses == ~regressed

(***************************************************************************)
(* Historical fault: a delayed tools/call response overwrites a newer      *)
(* stream snapshot without checking its cursor.                            *)
(***************************************************************************)
BadDeliverResponse(c) ==
  /\ opPhase[c] = "committed"
  /\ opPhase' = [opPhase EXCEPT ![c] = "responded"]
  /\ viewController' = [viewController EXCEPT
                          ![c] = responseController[c]]
  /\ viewCursor' = [viewCursor EXCEPT ![c] = responseCursor[c]]
  /\ regressed' = (regressed \/ responseCursor[c] < viewCursor[c])
  /\ UNCHANGED << controller, authorityCursor, sessionMutable,
                  responseController, responseCursor >>

BadNext == CoreNext \/ \E c \in Clients: BadDeliverResponse(c)
BadSpec == Init /\ [][BadNext]_vars

====
