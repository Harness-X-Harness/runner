---- MODULE BoundedSessionResources ----
EXTENDS FiniteSets, Naturals, Sequences

(***************************************************************************)
(* Focused obligation model for bounded resources in one runner. Queue and *)
(* driver admission reject excess work. Recoverable chunks may be dropped. *)
(* A non-recoverable overflow terminates only the target Session.           *)
(***************************************************************************)

CONSTANTS Sessions, Inputs, MaxQueue, MaxOutbox, MaxEvents, MaxDrivers

ASSUME Cardinality(Sessions) = 2
ASSUME Cardinality(Inputs) >= 2
ASSUME MaxQueue > 0
ASSUME MaxOutbox > 1
ASSUME MaxEvents > 1
ASSUME MaxDrivers > 0
ASSUME MaxDrivers < Cardinality(Sessions)

VARIABLES phase,
          queue,
          acceptedInputs,
          rejectedInputs,
          eventCount,
          recoverableEvents,
          outboxChunks,
          outboxCritical,
          criticalProduced,
          criticalDelivered,
          drivers,
          channel,
          disconnectedOnce,
          reconnectEvidence,
          overflowed

vars == << phase, queue, acceptedInputs, rejectedInputs, eventCount,
           recoverableEvents, outboxChunks, outboxCritical,
           criticalProduced, criticalDelivered, drivers, channel,
           disconnectedOnce, reconnectEvidence, overflowed >>

Init ==
  /\ phase = [s \in Sessions |-> "idle"]
  /\ queue = [s \in Sessions |-> <<>>]
  /\ acceptedInputs = [s \in Sessions |-> {}]
  /\ rejectedInputs = [s \in Sessions |-> {}]
  /\ eventCount = [s \in Sessions |-> 0]
  /\ recoverableEvents = [s \in Sessions |-> 0]
  /\ outboxChunks = [s \in Sessions |-> 0]
  /\ outboxCritical = [s \in Sessions |-> <<>>]
  /\ criticalProduced = [s \in Sessions |-> <<>>]
  /\ criticalDelivered = [s \in Sessions |-> <<>>]
  /\ drivers = {}
  /\ channel = "connected"
  /\ disconnectedOnce = FALSE
  /\ reconnectEvidence = FALSE
  /\ overflowed = {}

Live(s) == phase[s] # "terminal"
OutboxSize(s) == outboxChunks[s] + Len(outboxCritical[s])
SequenceSet(sequence) == {sequence[index] : index \in 1..Len(sequence)}

AcceptInput(s, input) ==
  /\ Live(s)
  /\ input \in Inputs \ (acceptedInputs[s] \cup rejectedInputs[s])
  /\ Len(queue[s]) < MaxQueue
  /\ eventCount[s] < MaxEvents - 1 \/ recoverableEvents[s] > 0
  /\ queue' = [queue EXCEPT ![s] = Append(@, input)]
  /\ acceptedInputs' = [acceptedInputs EXCEPT ![s] = @ \cup {input}]
  /\ IF eventCount[s] < MaxEvents - 1
     THEN /\ eventCount' = [eventCount EXCEPT ![s] = @ + 1]
          /\ recoverableEvents' = recoverableEvents
     ELSE /\ eventCount' = eventCount
          /\ recoverableEvents' = [recoverableEvents EXCEPT ![s] = @ - 1]
  /\ UNCHANGED << phase, rejectedInputs, outboxChunks,
                  outboxCritical, criticalProduced, criticalDelivered,
                  drivers, channel, disconnectedOnce, reconnectEvidence,
                  overflowed >>

TerminateForOverflow(s) ==
  /\ phase' = [phase EXCEPT ![s] = "terminal"]
  /\ queue' = [queue EXCEPT ![s] = <<>>]
  /\ eventCount' = [eventCount EXCEPT ![s] = IF @ < MaxEvents THEN @ + 1 ELSE @]
  /\ recoverableEvents' = [recoverableEvents EXCEPT
       ![s] = IF eventCount[s] = MaxEvents /\ @ > 0 THEN @ - 1 ELSE @]
  /\ outboxChunks' = [outboxChunks EXCEPT ![s] = 0]
  /\ outboxCritical' = [outboxCritical EXCEPT ![s] = <<>>]
  /\ drivers' = drivers \ {s}
  /\ overflowed' = overflowed \cup {s}

RejectInputOverflow(s, input) ==
  /\ Live(s)
  /\ input \in Inputs \ (acceptedInputs[s] \cup rejectedInputs[s])
  /\ Len(queue[s]) = MaxQueue \/
       /\ eventCount[s] = MaxEvents - 1
       /\ recoverableEvents[s] = 0
  /\ TerminateForOverflow(s)
  /\ rejectedInputs' = [rejectedInputs EXCEPT ![s] = @ \cup {input}]
  /\ UNCHANGED << acceptedInputs, criticalProduced, criticalDelivered,
                  channel, disconnectedOnce, reconnectEvidence >>

EmitEventChunk(s) ==
  /\ Live(s)
  /\ IF eventCount[s] < MaxEvents - 1
     THEN /\ eventCount' = [eventCount EXCEPT ![s] = @ + 1]
          /\ recoverableEvents' = [recoverableEvents EXCEPT ![s] = @ + 1]
     ELSE /\ eventCount' = eventCount
          /\ recoverableEvents' = recoverableEvents
  /\ UNCHANGED << phase, queue, acceptedInputs, rejectedInputs,
                  outboxChunks, outboxCritical, criticalProduced,
                  criticalDelivered, drivers, channel, disconnectedOnce,
                  reconnectEvidence, overflowed >>

EmitCriticalEvent(s) ==
  /\ Live(s)
  /\ eventCount[s] < MaxEvents - 1 \/ recoverableEvents[s] > 0
  /\ IF eventCount[s] < MaxEvents - 1
     THEN /\ eventCount' = [eventCount EXCEPT ![s] = @ + 1]
          /\ recoverableEvents' = recoverableEvents
     ELSE /\ eventCount' = eventCount
          /\ recoverableEvents' = [recoverableEvents EXCEPT ![s] = @ - 1]
  /\ UNCHANGED << phase, queue, acceptedInputs, rejectedInputs,
                  outboxChunks, outboxCritical, criticalProduced,
                  criticalDelivered, drivers, channel, disconnectedOnce,
                  reconnectEvidence, overflowed >>

CriticalEventOverflow(s) ==
  /\ Live(s)
  /\ eventCount[s] = MaxEvents - 1
  /\ recoverableEvents[s] = 0
  /\ TerminateForOverflow(s)
  /\ UNCHANGED << acceptedInputs, rejectedInputs, criticalProduced,
                  criticalDelivered, channel, disconnectedOnce,
                  reconnectEvidence >>

StartDriver(s) ==
  /\ Live(s)
  /\ s \notin drivers
  /\ Cardinality(drivers) < MaxDrivers
  /\ drivers' = drivers \cup {s}
  /\ UNCHANGED << phase, queue, acceptedInputs, rejectedInputs, eventCount,
                  recoverableEvents, outboxChunks, outboxCritical,
                  criticalProduced, criticalDelivered, channel,
                  disconnectedOnce, reconnectEvidence, overflowed >>

DriverOverflow(s) ==
  /\ Live(s)
  /\ s \notin drivers
  /\ Cardinality(drivers) = MaxDrivers
  /\ TerminateForOverflow(s)
  /\ UNCHANGED << acceptedInputs, rejectedInputs, criticalProduced,
                  criticalDelivered, channel, disconnectedOnce,
                  reconnectEvidence >>

Disconnect ==
  /\ channel = "connected"
  /\ ~disconnectedOnce
  /\ channel' = "disconnected"
  /\ disconnectedOnce' = TRUE
  /\ UNCHANGED << phase, queue, acceptedInputs, rejectedInputs, eventCount,
                  recoverableEvents, outboxChunks, outboxCritical,
                  criticalProduced, criticalDelivered, drivers,
                  reconnectEvidence, overflowed >>

BufferChunk(s) ==
  /\ Live(s)
  /\ channel = "disconnected"
  /\ IF OutboxSize(s) < MaxOutbox
     THEN outboxChunks' = [outboxChunks EXCEPT ![s] = @ + 1]
     ELSE outboxChunks' = outboxChunks
  /\ UNCHANGED << phase, queue, acceptedInputs, rejectedInputs, eventCount,
                  recoverableEvents, outboxCritical, criticalProduced,
                  criticalDelivered, drivers, channel, disconnectedOnce,
                  reconnectEvidence, overflowed >>

BufferCritical(s, input) ==
  /\ Live(s)
  /\ channel = "disconnected"
  /\ input \in Inputs \ SequenceSet(criticalProduced[s])
  /\ OutboxSize(s) < MaxOutbox \/ outboxChunks[s] > 0
  /\ criticalProduced' = [criticalProduced EXCEPT ![s] = Append(@, input)]
  /\ outboxCritical' = [outboxCritical EXCEPT ![s] = Append(@, input)]
  /\ outboxChunks' = [outboxChunks EXCEPT
       ![s] = IF OutboxSize(s) = MaxOutbox THEN @ - 1 ELSE @]
  /\ UNCHANGED << phase, queue, acceptedInputs, rejectedInputs, eventCount,
                  recoverableEvents, criticalDelivered, drivers, channel,
                  disconnectedOnce, reconnectEvidence, overflowed >>

CriticalOutboxOverflow(s, input) ==
  /\ Live(s)
  /\ channel = "disconnected"
  /\ input \in Inputs \ SequenceSet(criticalProduced[s])
  /\ OutboxSize(s) = MaxOutbox
  /\ outboxChunks[s] = 0
  /\ TerminateForOverflow(s)
  /\ UNCHANGED << acceptedInputs, rejectedInputs, criticalProduced,
                  criticalDelivered, channel, disconnectedOnce,
                  reconnectEvidence >>

SupplyReconnectEvidence ==
  /\ channel = "disconnected"
  /\ ~reconnectEvidence
  /\ reconnectEvidence' = TRUE
  /\ UNCHANGED << phase, queue, acceptedInputs, rejectedInputs, eventCount,
                  recoverableEvents, outboxChunks, outboxCritical,
                  criticalProduced, criticalDelivered, drivers, channel,
                  disconnectedOnce, overflowed >>

Reconnect ==
  /\ channel = "disconnected"
  /\ reconnectEvidence
  /\ channel' = "connected"
  /\ UNCHANGED << phase, queue, acceptedInputs, rejectedInputs, eventCount,
                  recoverableEvents, outboxChunks, outboxCritical,
                  criticalProduced, criticalDelivered, drivers,
                  disconnectedOnce, reconnectEvidence, overflowed >>

DeliverBuffered(s) ==
  /\ channel = "connected"
  /\ Len(outboxCritical[s]) > 0
  /\ criticalDelivered' = [criticalDelivered EXCEPT ![s] = Append(@, Head(outboxCritical[s]))]
  /\ outboxCritical' = [outboxCritical EXCEPT ![s] = Tail(@)]
  /\ UNCHANGED << phase, queue, acceptedInputs, rejectedInputs, eventCount,
                  recoverableEvents, outboxChunks, criticalProduced, drivers,
                  channel, disconnectedOnce, reconnectEvidence, overflowed >>

Next ==
  \/ \E s \in Sessions, input \in Inputs : AcceptInput(s, input)
  \/ \E s \in Sessions, input \in Inputs : RejectInputOverflow(s, input)
  \/ \E s \in Sessions : EmitEventChunk(s)
  \/ \E s \in Sessions : EmitCriticalEvent(s)
  \/ \E s \in Sessions : CriticalEventOverflow(s)
  \/ \E s \in Sessions : StartDriver(s)
  \/ \E s \in Sessions : DriverOverflow(s)
  \/ Disconnect
  \/ \E s \in Sessions : BufferChunk(s)
  \/ \E s \in Sessions, input \in Inputs : BufferCritical(s, input)
  \/ \E s \in Sessions, input \in Inputs : CriticalOutboxOverflow(s, input)
  \/ SupplyReconnectEvidence
  \/ Reconnect
  \/ \E s \in Sessions : DeliverBuffered(s)

Spec == Init /\ [][Next]_vars
             /\ WF_vars(Reconnect)
             /\ \A s \in Sessions : WF_vars(DeliverBuffered(s))

TypeOK ==
  /\ phase \in [Sessions -> {"idle", "terminal"}]
  /\ queue \in [Sessions -> Seq(Inputs)]
  /\ acceptedInputs \in [Sessions -> SUBSET Inputs]
  /\ rejectedInputs \in [Sessions -> SUBSET Inputs]
  /\ eventCount \in [Sessions -> Nat]
  /\ recoverableEvents \in [Sessions -> Nat]
  /\ outboxChunks \in [Sessions -> Nat]
  /\ outboxCritical \in [Sessions -> Seq(Inputs)]
  /\ criticalProduced \in [Sessions -> Seq(Inputs)]
  /\ criticalDelivered \in [Sessions -> Seq(Inputs)]
  /\ drivers \subseteq Sessions
  /\ channel \in {"connected", "disconnected"}
  /\ disconnectedOnce \in BOOLEAN
  /\ reconnectEvidence \in BOOLEAN
  /\ overflowed \subseteq Sessions

QueueBounded == \A s \in Sessions : Len(queue[s]) <= MaxQueue
OutboxBounded == \A s \in Sessions : OutboxSize(s) <= MaxOutbox
EventLogBounded == \A s \in Sessions : eventCount[s] <= MaxEvents
DriverRegistryBounded == Cardinality(drivers) <= MaxDrivers
RecoverableCountsAreRetained ==
  \A s \in Sessions :
    /\ recoverableEvents[s] <= eventCount[s]
    /\ outboxChunks[s] <= OutboxSize(s)

OverflowIsStableTerminal == overflowed \subseteq {s \in Sessions : phase[s] = "terminal"}

IsPrefix(prefix, sequence) ==
  Len(prefix) <= Len(sequence) /\
    \A index \in 1..Len(prefix) : prefix[index] = sequence[index]

ReconnectPreservesOrder ==
  \A s \in Sessions : IsPrefix(criticalDelivered[s], criticalProduced[s])

(***************************************************************************)
(* Negative witnesses. They are excluded from Spec.                         *)
(***************************************************************************)
GrowOutboxPastLimit ==
  \E s \in Sessions :
    /\ OutboxSize(s) = MaxOutbox
    /\ outboxChunks' = [outboxChunks EXCEPT ![s] = @ + 1]
    /\ UNCHANGED << phase, queue, acceptedInputs, rejectedInputs, eventCount,
                    recoverableEvents, outboxCritical, criticalProduced,
                    criticalDelivered, drivers, channel, disconnectedOnce,
                    reconnectEvidence, overflowed >>

ReviveOverflowedSession ==
  \E s \in overflowed :
    /\ phase' = [phase EXCEPT ![s] = "idle"]
    /\ UNCHANGED << queue, acceptedInputs, rejectedInputs, eventCount,
                    recoverableEvents, outboxChunks, outboxCritical,
                    criticalProduced, criticalDelivered, drivers, channel,
                    disconnectedOnce, reconnectEvidence, overflowed >>

DeliverOutOfOrder ==
  \E s \in Sessions :
    /\ channel = "connected"
    /\ Len(outboxCritical[s]) >= 2
    /\ criticalDelivered' = [criticalDelivered EXCEPT ![s] = Append(@, outboxCritical[s][2])]
    /\ UNCHANGED << phase, queue, acceptedInputs, rejectedInputs, eventCount,
                    recoverableEvents, outboxChunks, outboxCritical,
                    criticalProduced, drivers, channel, disconnectedOnce,
                    reconnectEvidence, overflowed >>

BoundsFaultSpec == Init /\ [][Next \/ GrowOutboxPastLimit]_vars
TerminalFaultSpec == Init /\ [][Next \/ ReviveOverflowedSession]_vars
OrderFaultSpec == Init /\ [][Next \/ DeliverOutOfOrder]_vars

====
