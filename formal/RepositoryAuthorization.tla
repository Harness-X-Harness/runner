---- MODULE RepositoryAuthorization ----
EXTENDS Naturals

VARIABLES mode,
          visibility,
          installation,
          userVerified,
          installationNotified,
          status,
          accessPath,
          dispatchCount,
          dispatchAuthorized

vars == << mode, visibility, installation, userVerified,
           installationNotified, status, accessPath, dispatchCount,
           dispatchAuthorized >>

Statuses == {"submitted", "awaiting_installation", "ready",
             "dispatching", "queued", "failed", "cancelled"}
Modes == {"analyze", "write"}
Visibilities == {"public", "private"}
Installations == {"missing", "sufficient", "unknown"}
AccessPaths == {"none", "public_read", "installation"}

Init ==
  /\ mode \in Modes
  /\ visibility \in Visibilities
  /\ installation \in Installations
  /\ userVerified = FALSE
  /\ installationNotified = FALSE
  /\ status = "submitted"
  /\ accessPath = "none"
  /\ dispatchCount = 0
  /\ dispatchAuthorized = FALSE

ObservePublicAnalyze ==
  /\ status = "submitted"
  /\ mode = "analyze"
  /\ visibility = "public"
  /\ status' = "ready"
  /\ accessPath' = "public_read"
  /\ userVerified' = TRUE
  /\ UNCHANGED << mode, visibility, installation,
                  installationNotified, dispatchCount,
                  dispatchAuthorized >>

ObserveInstalled ==
  /\ status = "submitted"
  /\ installation = "sufficient"
  /\ status' = "ready"
  /\ accessPath' = "installation"
  /\ userVerified' = TRUE
  /\ UNCHANGED << mode, visibility, installation,
                  installationNotified, dispatchCount,
                  dispatchAuthorized >>

ObserveMissing ==
  /\ status = "submitted"
  /\ installation = "missing"
  /\ status' = "awaiting_installation"
  /\ UNCHANGED << mode, visibility, installation, userVerified,
                  installationNotified, accessPath, dispatchCount,
                  dispatchAuthorized >>

ObserveFailure ==
  /\ status = "submitted"
  /\ installation = "unknown"
  /\ status' = "failed"
  /\ UNCHANGED << mode, visibility, installation, userVerified,
                  installationNotified, accessPath, dispatchCount,
                  dispatchAuthorized >>

NotifyInstallation ==
  /\ status = "awaiting_installation"
  /\ ~installationNotified
  /\ installationNotified' = TRUE
  /\ UNCHANGED << mode, visibility, installation, userVerified,
                  status, accessPath, dispatchCount,
                  dispatchAuthorized >>

EnvironmentInstalls ==
  /\ status = "awaiting_installation"
  /\ installation = "missing"
  /\ installation' = "sufficient"
  /\ UNCHANGED << mode, visibility, userVerified,
                  installationNotified, status, accessPath,
                  dispatchCount, dispatchAuthorized >>

VerifyInstalledUser ==
  /\ status = "awaiting_installation"
  /\ installation = "sufficient"
  /\ status' = "ready"
  /\ accessPath' = "installation"
  /\ userVerified' = TRUE
  /\ UNCHANGED << mode, visibility, installation,
                  installationNotified, dispatchCount,
                  dispatchAuthorized >>

StartDispatch ==
  /\ status = "ready"
  /\ status' = "dispatching"
  /\ dispatchCount' = dispatchCount + 1
  /\ dispatchAuthorized' =
       userVerified /\
       ((accessPath = "public_read" /\ mode = "analyze" /\ visibility = "public") \/
        accessPath = "installation")
  /\ UNCHANGED << mode, visibility, installation, userVerified,
                  installationNotified, accessPath >>

CommitDispatch ==
  /\ status = "dispatching"
  /\ status' = "queued"
  /\ UNCHANGED << mode, visibility, installation, userVerified,
                  installationNotified, accessPath, dispatchCount,
                  dispatchAuthorized >>

FailDispatch ==
  /\ status = "dispatching"
  /\ status' = "failed"
  /\ UNCHANGED << mode, visibility, installation, userVerified,
                  installationNotified, accessPath, dispatchCount,
                  dispatchAuthorized >>

Cancel ==
  /\ status \in {"submitted", "awaiting_installation", "ready"}
  /\ status' = "cancelled"
  /\ UNCHANGED << mode, visibility, installation, userVerified,
                  installationNotified, accessPath, dispatchCount,
                  dispatchAuthorized >>

Next ==
  \/ ObservePublicAnalyze
  \/ ObserveInstalled
  \/ ObserveMissing
  \/ ObserveFailure
  \/ NotifyInstallation
  \/ EnvironmentInstalls
  \/ VerifyInstalledUser
  \/ StartDispatch
  \/ CommitDispatch
  \/ FailDispatch
  \/ Cancel

Spec == Init /\ [][Next]_vars
             /\ WF_vars(StartDispatch)
             /\ WF_vars(CommitDispatch)
             /\ WF_vars(FailDispatch)

TypeOK ==
  /\ mode \in Modes
  /\ visibility \in Visibilities
  /\ installation \in Installations
  /\ userVerified \in BOOLEAN
  /\ installationNotified \in BOOLEAN
  /\ status \in Statuses
  /\ accessPath \in AccessPaths
  /\ dispatchCount \in 0..1
  /\ dispatchAuthorized \in BOOLEAN

AtMostOneDispatch == dispatchCount <= 1

AuthorizedDispatch == dispatchCount = 0 \/ dispatchAuthorized

PublicReadOnly == accessPath # "public_read" \/ mode = "analyze"

ReadyConverges ==
  [](status = "ready" => <>(status \in {"queued", "failed", "cancelled"}))

BadDispatchAfterNotification ==
  /\ status = "awaiting_installation"
  /\ installationNotified
  /\ status' = "dispatching"
  /\ dispatchCount' = dispatchCount + 1
  /\ dispatchAuthorized' = FALSE
  /\ UNCHANGED << mode, visibility, installation, userVerified,
                  installationNotified, accessPath >>

BadNext == Next \/ BadDispatchAfterNotification
BadSpec == Init /\ [][BadNext]_vars

====
