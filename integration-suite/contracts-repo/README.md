# The contracts repo

The contracts lab publishes one file — `pack.json`, describing every agent CLI's
live hook contract — to a **separate public repo** under the failproofai org.
This directory holds what that repo needs. Nothing here runs from this repo.

## Why a separate repo

The pack changes on the vendors' schedule, not ours. Publishing it here would
mean a commit to the product repo every time somebody else's CLI shipped, and a
release cadence driven by other people's release cadence. It also has to stay
readable by clients older than it is, which is easier to honour when it is
plainly a separate artifact with its own history.

## Setting it up

1. Create the repo (public), with a `main` branch and a `pack.json` — an empty
   `{"clis":{}}` is fine as the first commit; the lab replaces it.
2. Copy `release.yml` into `.github/workflows/`.
3. Give the box a token with **contents: write** on that repo only, and put it
   in `~/fp-canary/secrets.env`:

   ```
   CONTRACTS_REPO=FailproofAI/<name>
   CONTRACTS_TOKEN=<token>
   ```

   Until both are set the lab still runs and still reports to Slack — it just
   does not publish. That is deliberate: a lab that cannot publish is still a
   lab, and one that refuses to install until a repo exists is not.
4. Point clients at it by setting `DEFAULT_PACK_URL` in
   `src/hooks/contract-pack-client.ts` to the release asset URL, or by setting
   `FAILPROOFAI_CONTRACTS_URL` per machine. It is empty today on purpose: a
   plausible-looking guess would 404 on every machine forever while looking
   configured.

## What a release means

`contracts-publish.sh` commits **only when the contract moved** — it compares
the pack with `generatedAt` removed, because every run produces a fresh
timestamp. So a release in that repo means a vendor changed something. If it
ever starts firing daily, that property has been lost and the notification stops
being worth reading.
