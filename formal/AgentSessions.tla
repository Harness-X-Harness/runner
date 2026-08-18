---- MODULE AgentSessions ----
EXTENDS Naturals, Sequences, FiniteSets

(***************************************************************************)
(* Focused obligation for one representative Agent Session. The model      *)
(* covers controller authority, FIFO queued turns, exact Environment        *)
(* generation, terminal monotonicity, and at-most-once native effects over  *)
(* an at-least-once runner control channel. It intentionally does not model *)
(* OAuth, GitHub dispatch, T3, Tailscale, text content, or driver payloads.  *)
(***************************************************************************)

CONSTANTS Grants,
          Turns,
          Commands,
          Generations,
          FirstGeneration,
          SecondGeneration,
          InitialController

NoTurn == "noTurn"
NoGeneration == "noGeneration"
NoGrant == "noGrant"

ASSUME /\ Cardinality(Grants) = 2
       /\ Cardinality(Turns) = 2
       /\ Cardinality(Commands) = 2
       /\ Cardinality(Generations) = 2
       /\ FirstGeneration \in Generations
       /\ SecondGeneration \in Generations
       /\ FirstGeneration # SecondGeneration
       /\ InitialController \in Grants
       /\ NoTurn \notin Turns
       /\ NoGeneration \notin Generations
       /\ NoGrant \notin Grants

VARIABLES envPhase,
          envGeneration,
          channelState,
          channelGeneration,
          sessionPhase,
          sessionGeneration,
          controller,
          activeTurn,
          queue,
          knownTurns,
          cancelledTurns,
          enqueueHistory,
          queuedStartedHistory,
          accepted,
          processed,
          commandKind,
          commandGrant,
          commandTurn,
          commandGeneration,
          commandAuthorized,
          deliveryCount,
          effectCount,
          eventCount,
          lastEventGeneration,
          everTerminal,
          lastMutationAuthorized

vars == << envPhase, envGeneration, channelState, channelGeneration,
           sessionPhase, sessionGeneration, controller, activeTurn, queue,
           knownTurns, cancelledTurns, enqueueHistory, queuedStartedHistory,
           accepted, processed, commandKind, commandGrant, commandTurn,
           commandGeneration, commandAuthorized, deliveryCount, effectCount,
           eventCount, lastEventGeneration, everTerminal,
           lastMutationAuthorized >>

EnvironmentPhases == {"ready", "terminal"}
ChannelStates == {"connected", "disconnected"}
SessionPhases == {
  "idle", "running", "waiting_for_user", "stopping", "terminal"
}
CommandKinds == {
  "none", "start", "steer", "start_queued", "interrupt", "response", "stop"
}
MutablePhases == {"idle", "running", "waiting_for_user"}

InSeq(x, s) == \E i \in 1..Len(s): s[i] = x

UniqueSeq(s) ==
  \A i, j \in 1..Len(s): i # j => s[i] # s[j]

IndexOf(t, s) == CHOOSE i \in 1..Len(s): s[i] = t

Init ==
  /\ envPhase = "ready"
  /\ envGeneration = FirstGeneration
  /\ channelState = "connected"
  /\ channelGeneration = FirstGeneration
  /\ sessionPhase = "idle"
  /\ sessionGeneration = FirstGeneration
  /\ controller = InitialController
  /\ activeTurn = NoTurn
  /\ queue = <<>>
  /\ knownTurns = {}
  /\ cancelledTurns = {}
  /\ enqueueHistory = <<>>
  /\ queuedStartedHistory = <<>>
  /\ accepted = {}
  /\ processed = {}
  /\ commandKind = [c \in Commands |-> "none"]
  /\ commandGrant = [c \in Commands |-> NoGrant]
  /\ commandTurn = [c \in Commands |-> NoTurn]
  /\ commandGeneration = [c \in Commands |-> NoGeneration]
  /\ commandAuthorized = [c \in Commands |-> FALSE]
  /\ deliveryCount = [c \in Commands |-> 0]
  /\ effectCount = [c \in Commands |-> 0]
  /\ eventCount = 0
  /\ lastEventGeneration = NoGeneration
  /\ everTerminal = FALSE
  /\ lastMutationAuthorized = TRUE

RecordCommand(c, g, kind, turn) ==
  /\ accepted' = accepted \cup {c}
  /\ commandKind' = [commandKind EXCEPT ![c] = kind]
  /\ commandGrant' = [commandGrant EXCEPT ![c] = g]
  /\ commandTurn' = [commandTurn EXCEPT ![c] = turn]
  /\ commandGeneration' = [commandGeneration EXCEPT ![c] = envGeneration]
  /\ commandAuthorized' = [commandAuthorized EXCEPT ![c] = TRUE]
  /\ deliveryCount' = [deliveryCount EXCEPT ![c] = 1]
  /\ UNCHANGED << processed, effectCount >>

TakeOver(g) ==
  /\ sessionPhase \in MutablePhases
  /\ g \in Grants
  /\ g # controller
  /\ controller' = g
  /\ lastMutationAuthorized' = TRUE
  /\ UNCHANGED << envPhase, envGeneration, channelState, channelGeneration,
                  sessionPhase, sessionGeneration, activeTurn, queue,
                  knownTurns, cancelledTurns, enqueueHistory,
                  queuedStartedHistory, accepted, processed, commandKind,
                  commandGrant, commandTurn, commandGeneration,
                  commandAuthorized, deliveryCount, effectCount, eventCount,
                  lastEventGeneration, everTerminal >>

QueueTurn(g, t) ==
  /\ sessionPhase \in MutablePhases
  /\ g = controller
  /\ t \in Turns \ knownTurns
  /\ queue' = Append(queue, t)
  /\ knownTurns' = knownTurns \cup {t}
  /\ enqueueHistory' = Append(enqueueHistory, t)
  /\ lastMutationAuthorized' = TRUE
  /\ UNCHANGED << envPhase, envGeneration, channelState, channelGeneration,
                  sessionPhase, sessionGeneration, controller, activeTurn,
                  cancelledTurns, queuedStartedHistory, accepted, processed,
                  commandKind, commandGrant, commandTurn, commandGeneration,
                  commandAuthorized, deliveryCount, effectCount, eventCount,
                  lastEventGeneration, everTerminal >>

CancelQueuedTurn(g, t) ==
  /\ sessionPhase \in MutablePhases
  /\ g = controller
  /\ InSeq(t, queue)
  /\ queue' = SelectSeq(queue, LAMBDA x: x # t)
  /\ cancelledTurns' = cancelledTurns \cup {t}
  /\ lastMutationAuthorized' = TRUE
  /\ UNCHANGED << envPhase, envGeneration, channelState, channelGeneration,
                  sessionPhase, sessionGeneration, controller, activeTurn,
                  knownTurns, enqueueHistory, queuedStartedHistory, accepted,
                  processed, commandKind, commandGrant, commandTurn,
                  commandGeneration, commandAuthorized, deliveryCount,
                  effectCount, eventCount, lastEventGeneration,
                  everTerminal >>

AcceptStart(c, g, t) ==
  /\ envPhase = "ready"
  /\ channelState = "connected"
  /\ channelGeneration = envGeneration
  /\ sessionGeneration = envGeneration
  /\ sessionPhase = "idle"
  /\ g = controller
  /\ c \in Commands \ accepted
  /\ t \in Turns \ knownTurns
  /\ RecordCommand(c, g, "start", t)
  /\ sessionPhase' = "running"
  /\ activeTurn' = t
  /\ knownTurns' = knownTurns \cup {t}
  /\ lastMutationAuthorized' = TRUE
  /\ UNCHANGED << envPhase, envGeneration, channelState, channelGeneration,
                  sessionGeneration, controller, queue, cancelledTurns,
                  enqueueHistory, queuedStartedHistory, eventCount,
                  lastEventGeneration, everTerminal >>

AcceptSteer(c, g) ==
  /\ envPhase = "ready"
  /\ channelState = "connected"
  /\ channelGeneration = envGeneration
  /\ sessionGeneration = envGeneration
  /\ sessionPhase = "running"
  /\ activeTurn \in Turns
  /\ g = controller
  /\ c \in Commands \ accepted
  /\ RecordCommand(c, g, "steer", activeTurn)
  /\ lastMutationAuthorized' = TRUE
  /\ UNCHANGED << envPhase, envGeneration, channelState, channelGeneration,
                  sessionPhase, sessionGeneration, controller, activeTurn,
                  queue, knownTurns, cancelledTurns, enqueueHistory,
                  queuedStartedHistory, eventCount, lastEventGeneration,
                  everTerminal >>

StartQueued(c) ==
  /\ envPhase = "ready"
  /\ channelState = "connected"
  /\ channelGeneration = envGeneration
  /\ sessionGeneration = envGeneration
  /\ sessionPhase = "idle"
  /\ Len(queue) > 0
  /\ c \in Commands \ accepted
  /\ RecordCommand(c, controller, "start_queued", Head(queue))
  /\ sessionPhase' = "running"
  /\ activeTurn' = Head(queue)
  /\ queue' = Tail(queue)
  /\ queuedStartedHistory' = Append(queuedStartedHistory, Head(queue))
  /\ lastMutationAuthorized' = TRUE
  /\ UNCHANGED << envPhase, envGeneration, channelState, channelGeneration,
                  sessionGeneration, controller, knownTurns, cancelledTurns,
                  enqueueHistory, eventCount, lastEventGeneration,
                  everTerminal >>

AcceptInterrupt(c, g) ==
  /\ envPhase = "ready"
  /\ channelState = "connected"
  /\ channelGeneration = envGeneration
  /\ sessionGeneration = envGeneration
  /\ sessionPhase = "running"
  /\ activeTurn \in Turns
  /\ g = controller
  /\ c \in Commands \ accepted
  /\ RecordCommand(c, g, "interrupt", activeTurn)
  /\ lastMutationAuthorized' = TRUE
  /\ UNCHANGED << envPhase, envGeneration, channelState, channelGeneration,
                  sessionPhase, sessionGeneration, controller, activeTurn,
                  queue, knownTurns, cancelledTurns, enqueueHistory,
                  queuedStartedHistory, eventCount, lastEventGeneration,
                  everTerminal >>

AcceptResponse(c, g) ==
  /\ envPhase = "ready"
  /\ channelState = "connected"
  /\ channelGeneration = envGeneration
  /\ sessionGeneration = envGeneration
  /\ sessionPhase = "waiting_for_user"
  /\ g = controller
  /\ c \in Commands \ accepted
  /\ RecordCommand(c, g, "response", activeTurn)
  /\ sessionPhase' = "running"
  /\ lastMutationAuthorized' = TRUE
  /\ UNCHANGED << envPhase, envGeneration, channelState, channelGeneration,
                  sessionGeneration, controller, activeTurn, queue,
                  knownTurns, cancelledTurns, enqueueHistory,
                  queuedStartedHistory, eventCount, lastEventGeneration,
                  everTerminal >>

AcceptStop(c, g) ==
  /\ envPhase = "ready"
  /\ sessionPhase \in MutablePhases
  /\ g = controller
  /\ c \in Commands \ accepted
  /\ RecordCommand(c, g, "stop", activeTurn)
  /\ sessionPhase' = "stopping"
  /\ lastMutationAuthorized' = TRUE
  /\ UNCHANGED << envPhase, envGeneration, channelState, channelGeneration,
                  sessionGeneration, controller, activeTurn, queue,
                  knownTurns, cancelledTurns, enqueueHistory,
                  queuedStartedHistory, eventCount, lastEventGeneration,
                  everTerminal >>

ProcessCommand(c) ==
  /\ c \in accepted \ processed
  /\ envPhase = "ready"
  /\ channelState = "connected"
  /\ commandGeneration[c] = envGeneration
  /\ processed' = processed \cup {c}
  /\ effectCount' = [effectCount EXCEPT ![c] = @ + 1]
  /\ IF commandKind[c] = "interrupt"
     THEN /\ sessionPhase = "running"
          /\ activeTurn = commandTurn[c]
          /\ sessionPhase' = "idle"
          /\ activeTurn' = NoTurn
          /\ everTerminal' = everTerminal
          /\ queue' = queue
     ELSE IF commandKind[c] = "stop"
          THEN /\ sessionPhase = "stopping"
               /\ sessionPhase' = "terminal"
               /\ activeTurn' = NoTurn
               /\ queue' = <<>>
               /\ everTerminal' = TRUE
          ELSE /\ sessionPhase' = sessionPhase
               /\ activeTurn' = activeTurn
               /\ queue' = queue
               /\ everTerminal' = everTerminal
  /\ UNCHANGED << envPhase, envGeneration, channelState, channelGeneration,
                  sessionGeneration, controller, knownTurns, cancelledTurns,
                  enqueueHistory, queuedStartedHistory, accepted, commandKind,
                  commandGrant, commandTurn, commandGeneration,
                  commandAuthorized, deliveryCount, eventCount,
                  lastEventGeneration, lastMutationAuthorized >>

Redeliver(c) ==
  /\ c \in accepted
  /\ deliveryCount[c] = 1
  /\ deliveryCount' = [deliveryCount EXCEPT ![c] = 2]
  /\ UNCHANGED << envPhase, envGeneration, channelState, channelGeneration,
                  sessionPhase, sessionGeneration, controller, activeTurn,
                  queue, knownTurns, cancelledTurns, enqueueHistory,
                  queuedStartedHistory, accepted, processed, commandKind,
                  commandGrant, commandTurn, commandGeneration,
                  commandAuthorized, effectCount, eventCount,
                  lastEventGeneration, everTerminal,
                  lastMutationAuthorized >>

CompleteTurn(gen) ==
  /\ gen = envGeneration
  /\ gen = sessionGeneration
  /\ envPhase = "ready"
  /\ channelState = "connected"
  /\ channelGeneration = gen
  /\ sessionPhase = "running"
  /\ sessionPhase' = "idle"
  /\ activeTurn' = NoTurn
  /\ eventCount' = eventCount + 1
  /\ lastEventGeneration' = gen
  /\ UNCHANGED << envPhase, envGeneration, channelState, channelGeneration,
                  sessionGeneration, controller, queue, knownTurns,
                  cancelledTurns, enqueueHistory, queuedStartedHistory,
                  accepted, processed, commandKind, commandGrant, commandTurn,
                  commandGeneration, commandAuthorized, deliveryCount,
                  effectCount, everTerminal, lastMutationAuthorized >>

RequestInput(gen) ==
  /\ gen = envGeneration
  /\ gen = sessionGeneration
  /\ envPhase = "ready"
  /\ channelState = "connected"
  /\ channelGeneration = gen
  /\ sessionPhase = "running"
  /\ sessionPhase' = "waiting_for_user"
  /\ eventCount' = eventCount + 1
  /\ lastEventGeneration' = gen
  /\ UNCHANGED << envPhase, envGeneration, channelState, channelGeneration,
                  sessionGeneration, controller, activeTurn, queue,
                  knownTurns, cancelledTurns, enqueueHistory,
                  queuedStartedHistory, accepted, processed, commandKind,
                  commandGrant, commandTurn, commandGeneration,
                  commandAuthorized, deliveryCount, effectCount,
                  everTerminal, lastMutationAuthorized >>

Disconnect ==
  /\ channelState = "connected"
  /\ channelState' = "disconnected"
  /\ channelGeneration' = NoGeneration
  /\ UNCHANGED << envPhase, envGeneration, sessionPhase, sessionGeneration,
                  controller, activeTurn, queue, knownTurns, cancelledTurns,
                  enqueueHistory, queuedStartedHistory, accepted, processed,
                  commandKind, commandGrant, commandTurn, commandGeneration,
                  commandAuthorized, deliveryCount, effectCount, eventCount,
                  lastEventGeneration, everTerminal,
                  lastMutationAuthorized >>

Connect(gen) ==
  /\ envPhase = "ready"
  /\ channelState = "disconnected"
  /\ gen = envGeneration
  /\ channelState' = "connected"
  /\ channelGeneration' = gen
  /\ UNCHANGED << envPhase, envGeneration, sessionPhase, sessionGeneration,
                  controller, activeTurn, queue, knownTurns, cancelledTurns,
                  enqueueHistory, queuedStartedHistory, accepted, processed,
                  commandKind, commandGrant, commandTurn, commandGeneration,
                  commandAuthorized, deliveryCount, effectCount, eventCount,
                  lastEventGeneration, everTerminal,
                  lastMutationAuthorized >>

EnvironmentTerminates ==
  /\ envPhase = "ready"
  /\ envPhase' = "terminal"
  /\ channelState' = "disconnected"
  /\ channelGeneration' = NoGeneration
  /\ sessionPhase' = "terminal"
  /\ activeTurn' = NoTurn
  /\ queue' = <<>>
  /\ everTerminal' = TRUE
  /\ UNCHANGED << envGeneration, sessionGeneration, controller, knownTurns,
                  cancelledTurns, enqueueHistory, queuedStartedHistory,
                  accepted, processed, commandKind, commandGrant, commandTurn,
                  commandGeneration, commandAuthorized, deliveryCount,
                  effectCount, eventCount, lastEventGeneration,
                  lastMutationAuthorized >>

ReplaceEnvironment ==
  /\ envPhase = "terminal"
  /\ envGeneration = FirstGeneration
  /\ envPhase' = "ready"
  /\ envGeneration' = SecondGeneration
  /\ channelState' = "disconnected"
  /\ channelGeneration' = NoGeneration
  /\ UNCHANGED << sessionPhase, sessionGeneration, controller, activeTurn,
                  queue, knownTurns, cancelledTurns, enqueueHistory,
                  queuedStartedHistory, accepted, processed, commandKind,
                  commandGrant, commandTurn, commandGeneration,
                  commandAuthorized, deliveryCount, effectCount, eventCount,
                  lastEventGeneration, everTerminal,
                  lastMutationAuthorized >>

Next ==
  \/ \E g \in Grants: TakeOver(g)
  \/ \E g \in Grants, t \in Turns: QueueTurn(g, t)
  \/ \E g \in Grants, t \in Turns: CancelQueuedTurn(g, t)
  \/ \E c \in Commands, g \in Grants, t \in Turns: AcceptStart(c, g, t)
  \/ \E c \in Commands, g \in Grants: AcceptSteer(c, g)
  \/ \E c \in Commands: StartQueued(c)
  \/ \E c \in Commands, g \in Grants: AcceptInterrupt(c, g)
  \/ \E c \in Commands, g \in Grants: AcceptResponse(c, g)
  \/ \E c \in Commands, g \in Grants: AcceptStop(c, g)
  \/ \E c \in Commands: ProcessCommand(c)
  \/ \E c \in Commands: Redeliver(c)
  \/ \E gen \in Generations: CompleteTurn(gen)
  \/ \E gen \in Generations: RequestInput(gen)
  \/ Disconnect
  \/ \E gen \in Generations: Connect(gen)
  \/ EnvironmentTerminates
  \/ ReplaceEnvironment

Spec == Init /\ [][Next]_vars

TypeOK ==
  /\ envPhase \in EnvironmentPhases
  /\ envGeneration \in Generations
  /\ channelState \in ChannelStates
  /\ channelGeneration \in Generations \cup {NoGeneration}
  /\ sessionPhase \in SessionPhases
  /\ sessionGeneration \in Generations
  /\ controller \in Grants
  /\ activeTurn \in Turns \cup {NoTurn}
  /\ queue \in Seq(Turns)
  /\ knownTurns \subseteq Turns
  /\ cancelledTurns \subseteq Turns
  /\ enqueueHistory \in Seq(Turns)
  /\ queuedStartedHistory \in Seq(Turns)
  /\ accepted \subseteq Commands
  /\ processed \subseteq accepted
  /\ commandKind \in [Commands -> CommandKinds]
  /\ commandGrant \in [Commands -> Grants \cup {NoGrant}]
  /\ commandTurn \in [Commands -> Turns \cup {NoTurn}]
  /\ commandGeneration \in [Commands -> Generations \cup {NoGeneration}]
  /\ commandAuthorized \in [Commands -> BOOLEAN]
  /\ deliveryCount \in [Commands -> 0..2]
  /\ effectCount \in [Commands -> 0..2]
  /\ eventCount \in Nat
  /\ lastEventGeneration \in Generations \cup {NoGeneration}
  /\ everTerminal \in BOOLEAN
  /\ lastMutationAuthorized \in BOOLEAN

ChannelUsesCurrentGeneration ==
  channelState = "connected" =>
    /\ envPhase = "ready"
    /\ channelGeneration = envGeneration

LiveSessionUsesCurrentGeneration ==
  sessionPhase # "terminal" =>
    /\ envPhase = "ready"
    /\ sessionGeneration = envGeneration

EventsUseSessionGeneration ==
  lastEventGeneration # NoGeneration =>
    lastEventGeneration = sessionGeneration

TerminalIsSticky == everTerminal => sessionPhase = "terminal"

EnvironmentTerminalEndsSession ==
  envPhase = "terminal" => sessionPhase = "terminal"

SessionShape ==
  /\ (sessionPhase = "idle" => activeTurn = NoTurn)
  /\ (sessionPhase \in {"running", "waiting_for_user"} => activeTurn \in Turns)
  /\ (sessionPhase = "terminal" => /\ activeTurn = NoTurn /\ Len(queue) = 0)

CommandEffectsAtMostOnce ==
  \A c \in Commands: effectCount[c] <= 1

AcceptedCommandsWereAuthorized ==
  /\ lastMutationAuthorized
  /\ \A c \in accepted: commandAuthorized[c]

QueuedTurnsAreUnique ==
  /\ UniqueSeq(queue)
  /\ UniqueSeq(enqueueHistory)
  /\ UniqueSeq(queuedStartedHistory)

CancelledTurnsNeverStart ==
  \A t \in cancelledTurns: ~InSeq(t, queuedStartedHistory)

QueuedStartsPreserveFIFO ==
  \A i, j \in 1..Len(queuedStartedHistory):
    i < j =>
      IndexOf(queuedStartedHistory[i], enqueueHistory) <
        IndexOf(queuedStartedHistory[j], enqueueHistory)

(***************************************************************************)
(* Negative witnesses show that the finite instance distinguishes the two  *)
(* most important adapter failures: duplicate native effects after          *)
(* redelivery and accepting a write from an old Session Controller.         *)
(***************************************************************************)
BadDuplicateProcess(c) ==
  /\ c \in processed
  /\ effectCount[c] = 1
  /\ effectCount' = [effectCount EXCEPT ![c] = 2]
  /\ UNCHANGED << envPhase, envGeneration, channelState, channelGeneration,
                  sessionPhase, sessionGeneration, controller, activeTurn,
                  queue, knownTurns, cancelledTurns, enqueueHistory,
                  queuedStartedHistory, accepted, processed, commandKind,
                  commandGrant, commandTurn, commandGeneration,
                  commandAuthorized, deliveryCount, eventCount,
                  lastEventGeneration, everTerminal,
                  lastMutationAuthorized >>

BadUnauthorizedSteer(c, g) ==
  /\ envPhase = "ready"
  /\ channelState = "connected"
  /\ sessionPhase = "running"
  /\ activeTurn \in Turns
  /\ g \in Grants \ {controller}
  /\ c \in Commands \ accepted
  /\ accepted' = accepted \cup {c}
  /\ commandKind' = [commandKind EXCEPT ![c] = "steer"]
  /\ commandGrant' = [commandGrant EXCEPT ![c] = g]
  /\ commandTurn' = [commandTurn EXCEPT ![c] = activeTurn]
  /\ commandGeneration' = [commandGeneration EXCEPT ![c] = envGeneration]
  /\ commandAuthorized' = [commandAuthorized EXCEPT ![c] = FALSE]
  /\ deliveryCount' = [deliveryCount EXCEPT ![c] = 1]
  /\ lastMutationAuthorized' = FALSE
  /\ UNCHANGED << envPhase, envGeneration, channelState, channelGeneration,
                  sessionPhase, sessionGeneration, controller, activeTurn,
                  queue, knownTurns, cancelledTurns, enqueueHistory,
                  queuedStartedHistory, processed, effectCount, eventCount,
                  lastEventGeneration, everTerminal >>

DuplicateBadNext == Next \/ \E c \in Commands: BadDuplicateProcess(c)
DuplicateBadSpec == Init /\ [][DuplicateBadNext]_vars

AuthorityBadNext ==
  Next \/ \E c \in Commands, g \in Grants: BadUnauthorizedSteer(c, g)
AuthorityBadSpec == Init /\ [][AuthorityBadNext]_vars

====
