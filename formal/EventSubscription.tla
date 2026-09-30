-------------------------- MODULE EventSubscription --------------------------
EXTENDS Naturals, FiniteSets

\* Focused safety obligation, not a refinement of the Environment runtime.
\* Two incarnations of one deterministic subscription ID expose stale results.
\* Verify and grant lookup can return late or never return. TTL/unsubscribe
\* invalidate the incarnation. A started HTTP request can arrive after either.
\* Network receipt is not model continuation. No fairness or liveness claim.
CONSTANT FaultyVerification, FaultySend, FaultyReply
VARIABLES epoch, active, verifying, stopped, revoked, queue, checking,
          authorized, flight, attempts, badSend, erasedNewer
vars == <<epoch, active, verifying, stopped, revoked, queue, checking,
          authorized, flight, attempts, badSend, erasedNewer>>

Init == /\ epoch = 0 /\ active = 0 /\ verifying = {} /\ stopped = {}
        /\ revoked = {} /\ queue = 0 /\ checking = 0 /\ authorized = 0
        /\ flight = 0 /\ attempts = 0 /\ badSend = FALSE /\ erasedNewer = FALSE

Subscribe == /\ epoch < 2 /\ epoch' = epoch + 1 /\ active' = 0
             /\ verifying' = verifying \cup {epoch + 1}
             /\ queue' = (IF queue # 0 THEN epoch + 1 ELSE 0) /\ attempts' = 0
             /\ UNCHANGED <<stopped, revoked, checking, authorized, flight, badSend, erasedNewer>>

Verify(e) == /\ e \in verifying /\ verifying' = verifying \ {e}
             /\ active' = (IF FaultyVerification \/ (e = epoch /\ e \notin stopped /\ e \notin revoked)
                           THEN e ELSE active)
             /\ UNCHANGED <<epoch, stopped, revoked, queue, checking, authorized, flight, attempts, badSend, erasedNewer>>

Stop == /\ epoch # 0 /\ stopped' = stopped \cup {epoch}
        /\ active' = 0 /\ queue' = 0
        /\ UNCHANGED <<epoch, verifying, revoked, checking, authorized, flight, attempts, badSend, erasedNewer>>

RevokeObserved == /\ epoch # 0 /\ revoked' = revoked \cup {epoch}
                  /\ UNCHANGED <<epoch, active, verifying, stopped, queue, checking, authorized, flight, attempts, badSend, erasedNewer>>

Publish == /\ active = epoch /\ epoch # 0 /\ epoch \notin stopped
           /\ queue' = epoch
           /\ UNCHANGED <<epoch, active, verifying, stopped, revoked, checking, authorized, flight, attempts, badSend, erasedNewer>>

CheckGrant == /\ queue # 0 /\ active = epoch /\ checking = 0 /\ attempts < 2
              /\ checking' = epoch /\ attempts' = attempts + 1
              /\ UNCHANGED <<epoch, active, verifying, stopped, revoked, queue, authorized, flight, badSend, erasedNewer>>

GrantReply == /\ checking # 0 /\ authorized' = checking /\ checking' = 0
              /\ UNCHANGED <<epoch, active, verifying, stopped, revoked, queue, flight, attempts, badSend, erasedNewer>>

Send == /\ authorized # 0 /\ flight = 0
        /\ (FaultySend \/ (authorized = epoch /\ active = epoch /\ epoch \notin stopped /\ epoch \notin revoked))
        /\ flight' = authorized /\ authorized' = 0
        /\ badSend' = (badSend \/ ~(authorized = epoch /\ active = epoch /\ epoch \notin stopped /\ epoch \notin revoked))
        /\ UNCHANGED <<epoch, active, verifying, stopped, revoked, queue, checking, attempts, erasedNewer>>

HttpReply == /\ flight # 0
             /\ erasedNewer' = (erasedNewer \/ (FaultyReply /\ queue # 0 /\ queue # flight))
             /\ queue' = (IF FaultyReply \/ queue = flight THEN 0 ELSE queue)
             /\ flight' = 0
             /\ UNCHANGED <<epoch, active, verifying, stopped, revoked, checking, authorized, attempts, badSend>>

Next == Subscribe \/ (\E e \in {1, 2}: Verify(e)) \/ Stop \/ RevokeObserved
     \/ Publish \/ CheckGrant \/ GrantReply \/ Send \/ HttpReply
Spec == Init /\ [][Next]_vars
TypeOK == /\ epoch \in 0..2 /\ active \in 0..2 /\ verifying \subseteq {1, 2}
          /\ stopped \subseteq {1, 2} /\ revoked \subseteq {1, 2}
          /\ queue \in 0..2 /\ checking \in 0..2 /\ authorized \in 0..2 /\ flight \in 0..2
          /\ attempts \in 0..2 /\ badSend \in BOOLEAN /\ erasedNewer \in BOOLEAN
NoResurrection == active = 0 \/ (active = epoch /\ epoch \notin stopped)
StartWithCurrentAuthority == ~badSend
OldReplyPreservesNewer == ~erasedNewer
=============================================================================
