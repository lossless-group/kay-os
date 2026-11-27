---
type: Plans
---

# Plans

Step-by-step plans sized to hand to one agent each. Every plan names its spec,
what to read first, the rules (no Cloudflare access, no secrets), what "done"
means, and what to hand back.

* [Plan C1 — A D1 Index With the Laptop's Tables](Plan-C1-D1-Cloud-Index.md) - Give the sync Worker a database: the same messages and attachments tables the laptop has, in Cloudflare D1.
* [Plan C2 — The Worker Indexes Each Message as It Stores It](Plan-C2-Worker-Indexes-New-Mail.md) - Every email the sync Worker saves to R2 also lands in the D1 index, with its attachments sorted the same way the laptop sorts them.
* [Plan C3 — The Worker Backfills the Index From R2](Plan-C3-Backfill-Index-From-R2.md) - Mail already in R2 gets indexed by the Worker itself, a batch at a time, with no laptop involved.
* [Plan C4 — A Remote MCP Connector for the Claude App](Plan-C4-Remote-MCP-Connector.md) - Let Claude on the phone search the archive and open attachments, through a login only Michael can pass.
* [Plan C6 — Calendar Tools in the Connector](Plan-C6-Calendar-Tools-in-the-Connector.md) - Ask Claude on the phone who you last met, what is on Thursday, or every meeting with a fund, from the same connector that serves the mail; and when you ask, put the meeting on the calendar.
