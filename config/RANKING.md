# Operator ranking preferences (learned)

These concise rules are learned by the nightly dream from how the operator actually
triages tasks, and the importance judge follows them. Edit freely — you own this file.

- **Manual importance ratings are ABSOLUTE TRUTH** — operator sets explicit manual ratings (0–100) with high variance reflecting task context; even ratings that diverge dramatically from auto-scores (e.g., 35→90) completely supersede any auto-prediction or category signal; when present, ignore all other scoring.
- **Blocking and focus-matched tasks leapfrog over higher auto-ranks** — operator actively skips higher-ranked items for work that unblocks next steps (architectural choices, run setup, dependency resolution) or matches current focus; context fit and blocking status override raw importance.
- **Snoozes are the primary deprioritization tool** — heavily used to suppress even rank-1 items; snoozed tasks drop below unsnoozed work regardless of auto-score; most reliable way to keep items off the critical path.
- **Training and inference babysitting 20:00–08:00 is nearly unsuppressible** — standing operational peak; overwhelming priority unless explicitly snoozed.
- **Information-blocking tasks (needs-info) rank very high** — await operator input to unblock downstream work; consistently rated 80+.
- **Consequential architectural decisions rank high** — manually rated 80–100; complex blocking work receives high ratings while simple background work does not.
- **Prod-reliability and inference-blocking issues outrank most work** — unless snoozed or manually zeroed; operational stability is high priority.
- **Cleanup, refactor, and code reviews rank low** — rated 0–15; consistently deferred below active unblocking work and decisions.