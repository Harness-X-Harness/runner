# Treat remote environments as user-controlled

A Remote Development Environment is a user-owned general development machine, not a repository publication workflow. The platform supplies one temporary GitHub-hosted runner, current official tools, T3, current connection discovery, and best-effort Tailscale connectivity for administrators. It can contain zero or many repositories. Commits, pushes, pull requests, and external commands are ordinary user or tool effects, not control-plane lifecycle states.

Users may authenticate tools such as `gh` inside the Environment. Credentials remain ephemeral runner state and disappear with the workflow. The control plane does not receive, interpret, persist, or recover them.

## Considered Options

- Requiring one repository at startup was rejected because it constrains a general remote machine and duplicates native `git` or `gh` workflows.
- Interpreting external commands in the control plane was rejected because flexibility belongs to the user and remote client.
