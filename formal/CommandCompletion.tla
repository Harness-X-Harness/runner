--------------------------- MODULE CommandCompletion ---------------------------
EXTENDS TLC
CONSTANT EarlyReturn
VARIABLES stopRequested, exited, streamsClosed, returned
vars == <<stopRequested, exited, streamsClosed, returned>>

\* Focused safety obligation for one successfully spawned command. OS exit and
\* pipe closure are external events, not consequences assumed from a signal.
\* No liveness claim: the OS may never supply either observation. Ownership,
\* admission, detached descendants, persistence and multiple commands are outside
\* this model. EarlyReturn is a discriminating fault, not production behavior.
Init == /\ stopRequested = FALSE /\ exited = FALSE
        /\ streamsClosed = FALSE /\ returned = FALSE
Stop == /\ ~stopRequested /\ ~returned /\ stopRequested' = TRUE
        /\ UNCHANGED <<exited, streamsClosed, returned>>
Exit == /\ ~exited /\ exited' = TRUE
        /\ UNCHANGED <<stopRequested, streamsClosed, returned>>
CloseStreams == /\ exited /\ ~streamsClosed /\ streamsClosed' = TRUE
                /\ UNCHANGED <<stopRequested, exited, returned>>
Return == /\ ~returned /\ (streamsClosed \/ (EarlyReturn /\ stopRequested))
          /\ returned' = TRUE /\ UNCHANGED <<stopRequested, exited, streamsClosed>>
Next == Stop \/ Exit \/ CloseStreams \/ Return
Spec == Init /\ [][Next]_vars
ObservedCompletion == returned => (exited /\ streamsClosed)
=============================================================================
