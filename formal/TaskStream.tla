---- MODULE TaskStream ----
EXTENDS Naturals, Sequences

(* Focused obligation for the Code Task observation stream. The final task   *)
(* result remains authoritative. Stream events are a bounded, ordered view.  *)

CONSTANTS MaxEvents, BufferLimit, FaultyLateEvents

ASSUME MaxEvents >= 2
ASSUME BufferLimit >= 1

VARIABLES nextSeq, buffer, terminal, terminalSeq, result,
          connected, cursor, pending

vars == <<nextSeq, buffer, terminal, terminalSeq, result,
          connected, cursor, pending>>

Event(seq, kind) == [seq |-> seq, kind |-> kind]

Trim(events) ==
  IF Len(events) <= BufferLimit
  THEN events
  ELSE SubSeq(events, Len(events) - BufferLimit + 1, Len(events))

Init ==
  /\ nextSeq = 1
  /\ buffer = <<>>
  /\ terminal = FALSE
  /\ terminalSeq = 0
  /\ result = FALSE
  /\ connected = FALSE
  /\ cursor = 0
  /\ pending = 0

AppendEvent ==
  /\ ~terminal
  /\ nextSeq <= MaxEvents
  /\ buffer' = Trim(Append(buffer, Event(nextSeq, "activity")))
  /\ pending' = IF connected THEN nextSeq ELSE pending
  /\ nextSeq' = nextSeq + 1
  /\ UNCHANGED <<terminal, terminalSeq, result, connected, cursor>>

Complete ==
  /\ ~terminal
  /\ nextSeq <= MaxEvents
  /\ buffer' = Trim(Append(buffer, Event(nextSeq, "completed")))
  /\ terminal' = TRUE
  /\ terminalSeq' = nextSeq
  /\ result' = TRUE
  /\ pending' = IF connected THEN nextSeq ELSE pending
  /\ nextSeq' = nextSeq + 1
  /\ UNCHANGED <<connected, cursor>>

Connect ==
  /\ ~connected
  /\ connected' = TRUE
  /\ pending' = IF nextSeq - 1 > cursor THEN nextSeq - 1 ELSE 0
  /\ UNCHANGED <<nextSeq, buffer, terminal, terminalSeq, result, cursor>>

Disconnect ==
  /\ connected
  /\ connected' = FALSE
  /\ pending' = 0
  /\ UNCHANGED <<nextSeq, buffer, terminal, terminalSeq, result, cursor>>

Deliver ==
  /\ connected
  /\ pending > cursor
  /\ cursor' = pending
  /\ pending' = 0
  /\ UNCHANGED <<nextSeq, buffer, terminal, terminalSeq, result, connected>>

FaultyLateAppend ==
  /\ FaultyLateEvents
  /\ terminal
  /\ nextSeq <= MaxEvents
  /\ buffer' = Trim(Append(buffer, Event(nextSeq, "late")))
  /\ pending' = IF connected THEN nextSeq ELSE pending
  /\ nextSeq' = nextSeq + 1
  /\ UNCHANGED <<terminal, terminalSeq, result, connected, cursor>>

Next ==
  \/ AppendEvent
  \/ Complete
  \/ Connect
  \/ Disconnect
  \/ Deliver
  \/ FaultyLateAppend

Spec == Init /\ [][Next]_vars /\ WF_vars(Deliver)

TypeOK ==
  /\ nextSeq \in 1..(MaxEvents + 1)
  /\ buffer \in Seq([seq : 1..MaxEvents, kind : {"activity", "completed", "late"}])
  /\ terminal \in BOOLEAN
  /\ terminalSeq \in 0..MaxEvents
  /\ result \in BOOLEAN
  /\ connected \in BOOLEAN
  /\ cursor \in 0..MaxEvents
  /\ pending \in 0..MaxEvents

BufferBounded == Len(buffer) <= BufferLimit

BufferOrdered ==
  \A left, right \in 1..Len(buffer):
    left < right => buffer[left].seq < buffer[right].seq

CursorNotAhead == cursor < nextSeq

FinalResultAuthority == terminal <=> result

NoLateEvents == terminal => nextSeq = terminalSeq + 1

DeliveryQuiesces == []<>(pending = 0)

=============================================================================
