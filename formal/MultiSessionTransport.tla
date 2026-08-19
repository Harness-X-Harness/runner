---- MODULE MultiSessionTransport ----
EXTENDS FiniteSets, Naturals

(***************************************************************************)
(* Focused obligation model for one Environment runtime multiplexing two   *)
(* Sessions and two Clients over one generation-bound channel. Durable     *)
(* acceptance is separate from delivery, driver response, and ACK commit.  *)
(***************************************************************************)

CONSTANTS Sessions, Clients, Commands, Generations, InitialGeneration

ASSUME Cardinality(Sessions) = 2
ASSUME Cardinality(Clients) = 2
ASSUME Cardinality(Commands) = 2
ASSUME Cardinality(Generations) = 2
ASSUME InitialGeneration \in Generations

NoSession == "no-session"
NoGeneration == "no-generation"
SessionPhases == {"idle", "running", "terminal"}

VARIABLES currentGeneration,
          channel,
          disconnectedOnce,
          availabilityEvidence,
          sessionPhase,
          controller,
          accepted,
          commandSession,
          commandGeneration,
          deliveryCount,
          responseEvidence,
          acknowledged,
          effectCount,
          effectSession,
          effectGeneration,
          failureEffects

vars == << currentGeneration, channel, disconnectedOnce,
           availabilityEvidence, sessionPhase, controller, accepted,
           commandSession, commandGeneration, deliveryCount,
           responseEvidence, acknowledged, effectCount, effectSession,
           effectGeneration, failureEffects >>

Init ==
  /\ currentGeneration = InitialGeneration
  /\ channel = "connected"
  /\ disconnectedOnce = FALSE
  /\ availabilityEvidence = FALSE
  /\ sessionPhase = [s \in Sessions |-> "idle"]
  /\ controller = [s \in Sessions |-> CHOOSE c \in Clients : TRUE]
  /\ accepted = {}
  /\ commandSession = [c \in Commands |-> NoSession]
  /\ commandGeneration = [c \in Commands |-> NoGeneration]
  /\ deliveryCount = [c \in Commands |-> 0]
  /\ responseEvidence = {}
  /\ acknowledged = {}
  /\ effectCount = [c \in Commands |-> 0]
  /\ effectSession = [c \in Commands |-> NoSession]
  /\ effectGeneration = [c \in Commands |-> NoGeneration]
  /\ failureEffects = [s \in Sessions |-> {}]

Accept(s, client, command, generation) ==
  /\ sessionPhase[s] # "terminal"
  /\ client = controller[s]
  /\ generation = currentGeneration
  /\ command \in Commands \ accepted
  /\ accepted' = accepted \cup {command}
  /\ commandSession' = [commandSession EXCEPT ![command] = s]
  /\ commandGeneration' = [commandGeneration EXCEPT ![command] = generation]
  /\ UNCHANGED << currentGeneration, channel, disconnectedOnce,
                  availabilityEvidence, sessionPhase, controller,
                  deliveryCount, responseEvidence, acknowledged, effectCount,
                  effectSession, effectGeneration, failureEffects >>

TakeOver(s, client) ==
  /\ sessionPhase[s] # "terminal"
  /\ client \in Clients \ {controller[s]}
  /\ controller' = [controller EXCEPT ![s] = client]
  /\ UNCHANGED << currentGeneration, channel, disconnectedOnce,
                  availabilityEvidence, sessionPhase, accepted,
                  commandSession, commandGeneration, deliveryCount,
                  responseEvidence, acknowledged, effectCount, effectSession,
                  effectGeneration, failureEffects >>

Disconnect ==
  /\ channel = "connected"
  /\ ~disconnectedOnce
  /\ channel' = "disconnected"
  /\ disconnectedOnce' = TRUE
  /\ UNCHANGED << currentGeneration, availabilityEvidence, sessionPhase,
                  controller, accepted, commandSession, commandGeneration,
                  deliveryCount, responseEvidence, acknowledged, effectCount,
                  effectSession, effectGeneration, failureEffects >>

(***************************************************************************)
(* The environment can supply availability evidence or withhold it.        *)
(* Fairness applies only to the local reconnect commit after that evidence. *)
(***************************************************************************)
SupplyAvailabilityEvidence ==
  /\ disconnectedOnce
  /\ ~availabilityEvidence
  /\ availabilityEvidence' = TRUE
  /\ UNCHANGED << currentGeneration, channel, disconnectedOnce,
                  sessionPhase, controller, accepted, commandSession,
                  commandGeneration, deliveryCount, responseEvidence,
                  acknowledged, effectCount, effectSession,
                  effectGeneration, failureEffects >>

Reconnect ==
  /\ channel = "disconnected"
  /\ availabilityEvidence
  /\ channel' = "connected"
  /\ UNCHANGED << currentGeneration, disconnectedOnce, availabilityEvidence,
                  sessionPhase, controller, accepted, commandSession,
                  commandGeneration, deliveryCount, responseEvidence,
                  acknowledged, effectCount, effectSession,
                  effectGeneration, failureEffects >>

Deliver(command) ==
  LET s == commandSession[command] IN
  /\ command \in accepted
  /\ channel = "connected"
  /\ sessionPhase[s] # "terminal"
  /\ commandGeneration[command] = currentGeneration
  /\ deliveryCount[command] < 2
  /\ deliveryCount' = [deliveryCount EXCEPT ![command] = @ + 1]
  /\ UNCHANGED << currentGeneration, channel, disconnectedOnce,
                  availabilityEvidence, sessionPhase, controller, accepted,
                  commandSession, commandGeneration, responseEvidence,
                  acknowledged, effectCount, effectSession,
                  effectGeneration, failureEffects >>

SupplyDriverResponse(command) ==
  /\ command \in accepted
  /\ deliveryCount[command] > 0
  /\ command \notin responseEvidence
  /\ responseEvidence' = responseEvidence \cup {command}
  /\ UNCHANGED << currentGeneration, channel, disconnectedOnce,
                  availabilityEvidence, sessionPhase, controller, accepted,
                  commandSession, commandGeneration, deliveryCount,
                  acknowledged, effectCount, effectSession,
                  effectGeneration, failureEffects >>

CommitResponse(command) ==
  LET s == commandSession[command] IN
  /\ command \in responseEvidence
  /\ command \notin acknowledged
  /\ channel = "connected"
  /\ sessionPhase[s] # "terminal"
  /\ commandGeneration[command] = currentGeneration
  /\ acknowledged' = acknowledged \cup {command}
  /\ effectCount' = [effectCount EXCEPT ![command] = @ + 1]
  /\ effectSession' = [effectSession EXCEPT ![command] = s]
  /\ effectGeneration' = [effectGeneration EXCEPT ![command] = currentGeneration]
  /\ UNCHANGED << currentGeneration, channel, disconnectedOnce,
                  availabilityEvidence, sessionPhase, controller, accepted,
                  commandSession, commandGeneration, deliveryCount,
                  responseEvidence, failureEffects >>

FailSession(s) ==
  /\ sessionPhase[s] # "terminal"
  /\ sessionPhase' = [sessionPhase EXCEPT ![s] = "terminal"]
  /\ failureEffects' = [failureEffects EXCEPT ![s] = @ \cup {s}]
  /\ UNCHANGED << currentGeneration, channel, disconnectedOnce,
                  availabilityEvidence, controller, accepted, commandSession,
                  commandGeneration, deliveryCount, responseEvidence,
                  acknowledged, effectCount, effectSession,
                  effectGeneration >>

ReplaceGeneration(generation) ==
  /\ generation \in Generations \ {currentGeneration}
  /\ currentGeneration' = generation
  /\ channel' = "disconnected"
  /\ disconnectedOnce' = TRUE
  /\ availabilityEvidence' = FALSE
  /\ sessionPhase' = [s \in Sessions |-> "terminal"]
  /\ UNCHANGED << controller, accepted, commandSession, commandGeneration,
                  deliveryCount, responseEvidence, acknowledged, effectCount,
                  effectSession, effectGeneration, failureEffects >>

Next ==
  \/ \E s \in Sessions, client \in Clients, command \in Commands,
        generation \in Generations : Accept(s, client, command, generation)
  \/ \E s \in Sessions, client \in Clients : TakeOver(s, client)
  \/ Disconnect
  \/ SupplyAvailabilityEvidence
  \/ Reconnect
  \/ \E command \in Commands : Deliver(command)
  \/ \E command \in Commands : SupplyDriverResponse(command)
  \/ \E command \in Commands : CommitResponse(command)
  \/ \E s \in Sessions : FailSession(s)
  \/ \E generation \in Generations : ReplaceGeneration(generation)

Spec == Init /\ [][Next]_vars
             /\ WF_vars(Reconnect)
             /\ \A command \in Commands : WF_vars(CommitResponse(command))

TypeOK ==
  /\ currentGeneration \in Generations
  /\ channel \in {"connected", "disconnected"}
  /\ disconnectedOnce \in BOOLEAN
  /\ availabilityEvidence \in BOOLEAN
  /\ sessionPhase \in [Sessions -> SessionPhases]
  /\ controller \in [Sessions -> Clients]
  /\ accepted \subseteq Commands
  /\ commandSession \in [Commands -> Sessions \cup {NoSession}]
  /\ commandGeneration \in [Commands -> Generations \cup {NoGeneration}]
  /\ deliveryCount \in [Commands -> 0..2]
  /\ responseEvidence \subseteq Commands
  /\ acknowledged \subseteq Commands
  /\ effectCount \in [Commands -> Nat]
  /\ effectSession \in [Commands -> Sessions \cup {NoSession}]
  /\ effectGeneration \in [Commands -> Generations \cup {NoGeneration}]
  /\ failureEffects \in [Sessions -> SUBSET Sessions]

NoCrossSessionEffect ==
  \A command \in Commands :
    effectCount[command] > 0 => effectSession[command] = commandSession[command]

AtMostOncePerSessionCommand ==
  \A command \in Commands : effectCount[command] <= 1

SessionFailureIsLocal ==
  \A cause \in Sessions : failureEffects[cause] \subseteq {cause}

GenerationGate ==
  \A command \in Commands :
    effectCount[command] > 0 => effectGeneration[command] = commandGeneration[command]

Outcome(command) ==
  command \in acknowledged \/
    /\ commandSession[command] \in Sessions
    /\ sessionPhase[commandSession[command]] = "terminal"

(***************************************************************************)
(* No fairness creates availability or a driver response. If both external *)
(* facts are supplied, weak fairness covers only reconnect and local commit. *)
(***************************************************************************)
CommandEvidenceConverges ==
  \A command \in Commands :
    []((command \in accepted /\ availabilityEvidence /\
        command \in responseEvidence) ~> Outcome(command))

CrossSessionFailure ==
  \E cause \in Sessions :
    /\ sessionPhase[cause] # "terminal"
    /\ sessionPhase' = [s \in Sessions |-> "terminal"]
    /\ failureEffects' = [failureEffects EXCEPT ![cause] = Sessions]
    /\ UNCHANGED << currentGeneration, channel, disconnectedOnce,
                    availabilityEvidence, controller, accepted, commandSession,
                    commandGeneration, deliveryCount, responseEvidence,
                    acknowledged, effectCount, effectSession,
                    effectGeneration >>

DuplicateEffect ==
  \E command \in acknowledged :
    /\ effectCount' = [effectCount EXCEPT ![command] = @ + 1]
    /\ UNCHANGED << currentGeneration, channel, disconnectedOnce,
                    availabilityEvidence, sessionPhase, controller, accepted,
                    commandSession, commandGeneration, deliveryCount,
                    responseEvidence, acknowledged, effectSession,
                    effectGeneration, failureEffects >>

StaleGenerationEffect ==
  \E command \in accepted :
    /\ commandGeneration[command] # currentGeneration
    /\ effectCount' = [effectCount EXCEPT ![command] = @ + 1]
    /\ effectSession' = [effectSession EXCEPT ![command] = commandSession[command]]
    /\ effectGeneration' = [effectGeneration EXCEPT ![command] = currentGeneration]
    /\ acknowledged' = acknowledged \cup {command}
    /\ UNCHANGED << currentGeneration, channel, disconnectedOnce,
                    availabilityEvidence, sessionPhase, controller, accepted,
                    commandSession, commandGeneration, deliveryCount,
                    responseEvidence, failureEffects >>

CrossFailureSpec == Init /\ [][Next \/ CrossSessionFailure]_vars
DuplicateEffectSpec == Init /\ [][Next \/ DuplicateEffect]_vars
StaleGenerationSpec == Init /\ [][Next \/ StaleGenerationEffect]_vars

====
