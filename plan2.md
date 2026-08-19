# Plan 2 — more than one agent account

Deferred work. Written 2026-08-19, after the single-agent path (register from `/start`, from the
admin API, from the CLI and from the bot) was finished and the Cloudflare block was diagnosed.

Read `docs/DECISIONS.md` before changing anything here — several constraints below are Ichancy's,
not ours, and cannot be designed away.

---

## 0. The two questions this plan answers

| Question                                           | Answer today                     | After this plan                            |
| -------------------------------------------------- | -------------------------------- | ------------------------------------------ |
| "We got a second agent account — can we use both?" | No. One agent, from env.         | Yes. Players are split across agents.      |
| "Can we just switch to the new agent?"             | Only on a fresh system — see §1. | Same, but the trap is visible in the data. |

## 1. The trap that makes this a feature and not a config change

Changing `ICHANCY_USERNAME` / `ICHANCY_PASSWORD` / `ICHANCY_AGENT_ID` and restarting _appears_ to
work. It does not, for anyone who already exists:

- `players.ichancy_player_id` points at an account inside the OLD agent's tree.
- `depositToPlayer` is drawn from the CALLING agent's wallet, and an agent may only move money to
  its own players. Every credit to a pre-existing player then fails.
- Re-registering them under the new agent creates a SECOND gaming account. The balance in the first
  one stays where it is; the player sees their money vanish.

So: a switch is safe only when `SELECT count(*) FROM players WHERE ichancy_player_id IS NOT NULL`
is zero. Otherwise the answer is this plan.

## 2. What Ichancy's API forces on the design

From the agent API docs (`Agent System API Documentation.pdf`) and `ichancy-session.service.ts`:

- **One access/refresh token pair per agent, ever.** A second `signin` for the SAME agent kills the
  first. Two DIFFERENT agents are independent — two agents means two live pairs, and that is fine.
- **`registerPlayer` takes `parentId`.** That is what puts a player in an agent's tree, and it is
  decided once, at registration. There is no "move player to another agent" endpoint.
- **`getAgentAllWallets` is per signed-in agent.** Each agent has its own float, so each needs its
  own ledger account and its own reconciliation.
- **No delete.** Nothing here can be undone from our side.

## 3. Design

### 3.1 Schema

```prisma
model IchancyAgent {
  id           String  @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  /// affiliateId — the value sent as parentId on registerPlayer.
  affiliateId  String  @unique @map("affiliate_id")
  username     String  @unique
  /// Encrypted with the same secret-box helper the player credentials use. NEVER plaintext.
  passwordEnc  String  @map("password_enc")
  currencyCode String  @map("currency_code") @db.VarChar(3)
  isActive     Boolean @default(true) @map("is_active")
  /// false = still accepts credits for existing players, takes no NEW ones. The safe way to retire one.
  acceptsNew   Boolean @default(true) @map("accepts_new")
  ...
  @@map("ichancy_agents")
}
```

- `players.agent_id` → `ichancy_agents.id`, **nullable only until backfill**, then NOT NULL.
- Set at registration time, alongside `ichancy_player_id`, in the same compare-and-set write that
  `PlayerRepository.linkIchancyAccount` already does. It must never change afterwards.

### 3.2 Session — one pair per agent

`ichancy-session.service.ts` today holds one Redis key (`ichancy:session:v1:tokens`) and one lock.
Both become per-agent: `ichancy:session:v1:<agentId>:tokens`, `lock:ichancy:session:<agentId>`.
Everything else in that file — single-flight, rotation, the api/worker asymmetry — is unchanged and
must stay: it is per-agent correctness, and it was hard-won.

`IchancyHttpClient` gains an agent parameter for `signin` (credentials come from the row, not env)
and the cookie jar becomes per-agent too, since each agent is a separate browser session upstream.

### 3.3 Ledger — one float account per agent

`ICHANCY_AGENT_FLOAT` becomes `ICHANCY_AGENT_FLOAT:<affiliateId>` (see
`src/core/ledger/account-codes.ts`). Consequences, all of which are the POINT rather than side
effects: `/float` lists per agent, `AgentFloatSyncService` syncs each, an `AGENT_FLOAT_MISMATCH`
break names the agent, and the low-watermark alert fires per agent.

### 3.4 Assignment — which agent gets a new player

One function, one place, easy to change:

```
pickAgentForNewPlayer(currencyCode) ->
  active + acceptsNew + matching currency, then:
    a) round-robin by player count   (default: keeps trees even)
    b) fill-first by float           (concentrates volume; simpler reconciliation)
```

Whatever it returns is written to `players.agent_id` and used as `parentId`. Existing players are
never re-assigned.

### 3.5 Credit path

`DepositCreditService` reads the player's agent instead of the global config: that agent's session,
that agent's float account, that agent's watermark. `PLAYER_LINK_PORT.ensureLinked` returns the
agent id so the caller never has to look it up twice.

## 4. Steps, in order

1. Migration: `ichancy_agents` + `players.agent_id` (nullable).
2. Seed the CURRENT env agent as the first row; backfill every existing player to it. This is what
   makes §1's trap disappear — after it, every player carries the agent that actually owns them.
3. Make `players.agent_id` NOT NULL.
4. Per-agent session keys + credentials from the row.
5. Per-agent float accounts + reconciliation + `/float`.
6. `pickAgentForNewPlayer` + registration writes the agent id.
7. Credit path reads the player's agent.
8. Admin surface: `GET/POST /v1/admin/ichancy-agents`, and the agent shown on the player row.
9. Delete `ICHANCY_USERNAME` / `ICHANCY_PASSWORD` / `ICHANCY_AGENT_ID` from env — the DB is now the
   source of truth, and two sources would drift.

## 5. Cost and risk

- ~2–3 days including tests.
- Highest-risk step is 4: an error there logs the wrong agent out mid-credit. Do it behind the fake
  adapter first; `modules.int.spec.ts` should grow a two-agent case.
- Steps 1–3 are safe on their own and worth doing early even if the rest waits — they record who
  owns whom, which is the fact that is currently unrecorded and unrecoverable later.

---

# Appendix — deferred: getting past Cloudflare without an IP allowlist

Only if Ichancy refuses to allowlist the server IP (ask first — it is one message and it is the
correct fix). Diagnosis on 2026-08-19: `Cf-Mitigated: challenge`, "Just a moment…", i.e. a Managed
Challenge. `cf_clearance` binds to IP **+ User-Agent + TLS fingerprint**, so a cookie copied from a
browser is refused from Node no matter how fresh it is — proven, not assumed.

Option: an **Ichancy gateway** — a tiny service running Playwright/Chromium that performs the POSTs
from inside a real browser context (real TLS fingerprint), exposing the same shape
`IchancyHttpClient` already speaks. The client gains a `ICHANCY_GATEWAY_URL` mode and nothing above
the transport changes. ~1 day, plus a browser in the deployment image and its memory.

Do not build this before asking for the allowlist.
