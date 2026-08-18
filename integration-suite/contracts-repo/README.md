# The contracts repo

The contracts lab publishes one file — `pack.json`, describing every agent CLI's
live hook contract — to **[FailproofAI/hook-contracts](https://github.com/FailproofAI/hook-contracts)**,
a separate public repo. This directory holds a copy of what that repo runs, so
the two can be diffed. Nothing here executes.

## Why a separate repo

The pack changes on the vendors' schedule, not ours. Publishing it here would
mean a commit to the product repo every time somebody else's CLI shipped, and a
release cadence driven by other people's release cadence. It also has to stay
readable by clients older than it is, which is easier to honour when it is
plainly a separate artifact with its own history.

## Two channels, and why the branch protection is load-bearing

The org ruleset `failproofai-rules` requires a reviewed pull request on every
repo's default branch, with **no bypass actors** — so the lab cannot push to
`main`, and turning a daily data update into a daily review request would stop
it being unattended. Rather than work around that, the rollout is staged on it:

| Branch | What it is | Who pulls it |
|---|---|---|
| `packs` | The lab pushes here unattended the moment a vendor moves. Cuts a **prerelease**. | Our own machines (`FAILPROOFAI_CONTRACTS_CHANNEL=internal`) |
| `main` | Reached only by a pull request from `packs`. Cuts the **real release**. | Every client machine, via `releases/latest/download/pack.json` |

GitHub's `latest` skips prereleases, so the split needs no extra plumbing: a
pack built from a bad lab run **cannot** become the one customers resolve to.
And the review the ruleset demands is exactly the promotion gate — a human
agreeing a vendor really moved before it reaches every machine. The rule that
blocked the lab is the rule that makes this safe.

The internal channel reads the branch file directly rather than the newest
prerelease, because "latest prerelease" has no constructible URL — only an API
query, which is the discovery step the stable path exists to avoid.

## Promotion: who decides a pack is real

A pack reaches customers only after **two** independent things agree with it.

1. The lab measures a vendor and pushes to `packs`.
2. A machine that runs those CLIs **for real** pulls that pack and compares it
   against its own accumulated observations — `failproofai doctor --corroborate`,
   which exits `0` corroborated, `1` contradicted, `2` nothing comparable.
3. Only on `0` does `contracts-promote.sh` open the pull request. `2` is not a
   pass: promotion requires evidence, and "could not check" is not evidence.
4. A human reads the diff and approves. The ruleset makes that unavoidable, and
   the diff is the vendor's own key names — so approving it is agreeing that
   somebody else shipped a change.

Corroboration compares **findings**, not raw keys, and only where the two sides
are genuinely comparable: same CLI, same version, same tool. A local table is a
union accumulated over weeks, so it legitimately holds optional keys one lab run
never saw — demanding key-for-key equality would mean nothing ever promotes. And
a version mismatch is skipped rather than failed, because there the difference
*is* the vendor moving, which is the thing being reported.

Run `contracts-promote.sh` on a real working machine, never on the lab box:
comparing the lab's run against the lab's own leftovers would always agree,
which is worse than not checking — it looks like corroboration while supplying
none.

## Giving the box its credentials

Put these in `~/fp-canary/secrets.env`:

```
CONTRACTS_REF=main
CONTRACTS_REPO=FailproofAI/hook-contracts
CONTRACTS_TOKEN=<a token with contents: write on that repo only>
```

The internal machine that runs `contracts-promote.sh` needs `CONTRACTS_REPO` and
a token with **pull-requests: write** — it opens a pull request and can do
nothing else. It never merges; it cannot, and that is the point.

Until `CONTRACTS_REPO` and `CONTRACTS_TOKEN` are both set the lab still runs and
still reports to Slack — it just does not publish. That is deliberate: a lab
that cannot publish is still a lab.

## What a release means

`contracts-publish.sh` commits **only when the contract moved** — it compares
the pack with `generatedAt` removed, because every run produces a fresh
timestamp. So a release means a vendor changed something. If it ever starts
firing daily, that property has been lost and the notification stops being worth
reading.
