---
type: Issues
---

# Issues

* [Backfill Runs Ended Before Writing Their Status](Backfill-Runs-Ended-Before-Writing-Status.md) - The first cloud backfill runs did their work but never said so. The fix splits the backfill into short alarm-driven chunks that record themselves as they go.
* [Backfilled Mail Has No Conversation IDs](Backfilled-Mail-Has-No-Conversation-IDs.md) - Only mail the Worker synced itself has conversation IDs; the backfill indexed everything else before reading the metadata that holds them.
* [Search Ranks Passing Mentions Above Real Matches](Search-Ranks-Passing-Mentions-Above-Real-Matches.md) - Search does require every word, but sorts newest first and shows one excerpt, so the real match gets buried.
* [The Recent Mail List Has No Previews](Recent-Mail-List-Has-No-Previews.md) - Listing the latest mail returns an empty preview; previews only appear for keyword searches.
