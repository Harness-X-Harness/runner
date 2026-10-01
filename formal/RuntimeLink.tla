-------------------------- MODULE RuntimeLink --------------------------
\* Focused obligation for one already-authenticated socket, not a refinement
\* of Environment admission or execution. A lost link need not deliver Close.
\* Only local timer scheduling is fair; no peer response or reconnect is assumed.
\* Ping/Pong are control frames, not activity that renews the Environment deadline.
\* Code seam: agent-runtime/environment-connection.ts, its connection-scoped timer.
CONSTANT ProbeEnabled
VARIABLES reachable, localOpen, awaitingPong
vars == <<reachable, localOpen, awaitingPong>>

Init == /\ reachable = TRUE /\ localOpen = TRUE /\ awaitingPong = FALSE
SilentLoss == /\ reachable /\ reachable' = FALSE
              /\ UNCHANGED <<localOpen, awaitingPong>>
\* A tick either sends one Ping, or retires the unanswered socket.
ProbeTick == /\ ProbeEnabled /\ localOpen
             /\ localOpen' = ~awaitingPong /\ awaitingPong' = TRUE
             /\ UNCHANGED reachable
Pong == /\ reachable /\ localOpen /\ awaitingPong
        /\ awaitingPong' = FALSE /\ UNCHANGED <<reachable, localOpen>>
\* Close delivery is possible, but deliberately not guaranteed or fair.
CloseDelivered == /\ ~reachable /\ localOpen
                  /\ localOpen' = FALSE /\ awaitingPong' = FALSE
                  /\ UNCHANGED reachable

Next == SilentLoss \/ ProbeTick \/ Pong \/ CloseDelivered
Spec == Init /\ [][Next]_vars /\ WF_vars(ProbeTick)
TypeOK == /\ reachable \in BOOLEAN /\ localOpen \in BOOLEAN /\ awaitingPong \in BOOLEAN
DetectSilentLoss == ~reachable ~> ~localOpen
=============================================================================
