# Assessment 15: Financial incident simulation

**Status:** complete.

- **Reproductions:** `pnpm --filter @fincore/api scenario incidents` reproduces all five incidents against a real stack. Output: `evidence/15/incident-reproductions.txt`, which ends with "ALL CHECKS PASSED".
- **Postmortems:** [../postmortems/README.md](../postmortems/README.md). Each covers the timeline, impact, root cause, corrective action, prevention and proof of recovery.
- **Runbooks:** [../runbooks/](../runbooks/README.md).
- **Capstone:** `pnpm --filter @fincore/api scenario capstone`. Output: `evidence/capstone/capstone-run.txt`.
