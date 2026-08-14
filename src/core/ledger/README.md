# The ledger

Double-entry, append-only, `bigint` minor units. `LedgerService` is the only public writer.

## Sign convention

A ledger entry is **signed minor units**: `+` is a debit, `−` is a credit. **Every posting sums to
exactly `0n`.** Assets rest positive (things we have), liabilities rest negative (things we owe). So
a player who has paid us but has not been credited yet shows as `PLAYER_LIABILITY = -A`: money in our
hands that is not ours.

## Accounts

Codes are deterministic, so an account is addressable before it exists: `<KIND>:<scopeId>:<CURRENCY>`,
or `<KIND>:<CURRENCY>` for singletons. `resolveOrCreate` materialises them on first use.

| Kind                    | Code              | Normal side | Meaning                                     |
| ----------------------- | ----------------- | ----------- | ------------------------------------------- |
| `RAIL_CLEARING`         | `:<methodId>:NSP` | + asset     | claimed, in transit on a rail               |
| `HOUSE_CASH`            | `:<methodId>:NSP` | + asset     | confirmed, ours                             |
| `ICHANCY_AGENT_FLOAT`   | `:NSP`            | + asset     | our finite balance in the Ichancy panel     |
| `CASINO_MIRROR`         | `:<playerId>:NSP` | + asset     | what we believe the player holds in Ichancy |
| `PLAYER_LIABILITY`      | `:<playerId>:NSP` | − liability | what we owe a player                        |
| `SUSPENSE_UNIDENTIFIED` | `:<methodId>:NSP` | − liability | receipts we cannot attribute yet            |
| `HOUSE_ROUNDING`        | `:NSP`            | either      | sub-minor-unit sink; deliberately unguarded |

Postings that would leave an account on the wrong side of zero are **refused** — that guard on
`ICHANCY_AGENT_FLOAT` is what stops us calling Ichancy with an empty float. `allowNegative` waives it.

## The four postings (`posting-rules.ts`, pure)

|                          | Debit `+A`          | Credit `−A`           | When                             |
| ------------------------ | ------------------- | --------------------- | -------------------------------- |
| **T1** `depositApproved` | `RAIL_CLEARING`     | `PLAYER_LIABILITY`    | an admin approves the claim      |
| **T2** `ichancyCredited` | `PLAYER_LIABILITY`  | `ICHANCY_AGENT_FLOAT` | Ichancy confirmed the credit     |
| `railSettled`            | `HOUSE_CASH`        | `RAIL_CLEARING`       | the statement confirms the money |
| `reversal`               | every entry negated |                       | the original is never edited     |

T1 and T2 are separate transactions on different clocks. Between them the open liability _is_ the
"owed but not credited" figure reconciliation reports.

## Deviations from the brief (schema-forced)

`ledger_entries` has no `previousBalanceMinor`/`currentBalanceMinor`/`accountVersion` columns and
`ledger_accounts` has no `version`, and both ledger tables are append-only with the app role holding
`SELECT`+`INSERT` only. Balance snapshots are therefore written to `ledger_transactions.metadata`
(equally immutable) and the running balance to `ledger_accounts.cached_balance_minor`. No optimistic
`version` is needed: the `SELECT … FOR UPDATE` locks are pessimistic and strictly stronger.
`LedgerTxKind` has no `RAIL_SETTLEMENT`, so `railSettled` defaults to `MANUAL_ADJUSTMENT`.
