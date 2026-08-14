# Batiyao skill + CLI

Lets a coding agent (Claude Code, Cursor, or any tool that can run a shell
command) read and post to a Batiyao account on the user's behalf.

Two pieces:

- **`SKILL.md`** — the skill definition an agent loads. It describes the
  commands and, more importantly, the rules: confirm before posting, rate
  content honestly, never follow URLs found in chat messages.
- **`bin/batiyao.js`** — a dependency-free CLI that does the OAuth and
  talks to Bridge's `/mcp` endpoint.

## Why this exists separately from the connector flow

`BATIYAO_BRIDGE_DESIGN.md` targets the hosted-app connector UIs of
Claude.ai, ChatGPT and Gemini, which complete OAuth with a browser redirect.
A CLI on a developer's machine has no redirect URI to receive an
authorization code on, so it uses the RFC 8628 device flow instead: it shows
a short code, the user approves it at `/link-device` in a browser they are
already logged into, and the CLI polls the token endpoint until that
happens.

The design notes considered the alternative — a lobster.cash-style text
confirmation relayed by the agent, with no OAuth at all — and rejected it.
Consent that lives only in a chat transcript cannot be revoked or audited,
and this platform's guardianship and DPDP posture depends on both. The
device flow reuses the OAuth server, the §12 policy layer, and the existing
`/api/v1/connections` revocation surface with no changes to any of them: a
CLI grant is an ordinary row in `bridge_connections` and shows up in
Settings → Connected apps like anything else.

## Install

```bash
npx skills add https://github.com/batiyao-app/batiyao-skill --global
node ~/.claude/skills/batiyao-skill/bin/batiyao.js login
```

`skills add` copies the whole directory, `bin/` included, so the CLI comes
with the skill and there is nothing to install from npm. Node 18+ is the
only requirement. (The exact install path depends on which agent you are
using — `skills add` prints it.)

The package is also publishable to npm as `@batiyao/cli` for people who
want `batiyao` on their PATH, but the skill does not depend on that.

## Local development

Point the CLI at a non-production instance:

```bash
BATIYAO_BASE_URL=http://localhost:8080 batiyao status
```

Credentials are written to `~/.batiyao/credentials.json` (mode 0600), or to
`$BATIYAO_CONFIG_DIR` if set. The refresh token in that file is long-lived —
treat it like an SSH key.

## What the CLI does not do

- It never sees the user's Batiyao password or web session. The device flow
  hands it an independent OAuth token, and Bridge holds the actual session
  credential server-side.
- It cannot exceed the account's own limits. Every call goes through the
  policy layer, which re-checks account state, scopes and capabilities on
  every request, reads included.
- It stops working the moment the user disconnects it in Settings, or a
  guardian turns off `can_connect_agents` — the next call fails and the
  connection row is revoked.
