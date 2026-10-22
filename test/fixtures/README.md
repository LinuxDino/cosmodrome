# Agent output fixtures

Raw stdout of headless agent runs, one folder per agent, one file per case:
`<agent>/<case>.jsonl` (or `.txt`), with optional `<case>.exit` (exit code) and `<case>.stderr`.

The event shapes match real output of the versions noted in each adapter
(`src/core/adapters/*.js`). The content is written by hand and shortened, so the files hold
no paths, account names or session data from real runs.

- Tests: `test/adapters.test.js` replays every case and checks the events.
- Interface work without accounts: `COSMO_MOCK=1 cosmo` replays `<agent>/simple` for every agent,
  `COSMO_MOCK=tool cosmo` replays `<agent>/tool`.
- New cases: run with `COSMO_RECORD=/some/dir` to save raw stdout/stderr of each run, then remove
  personal data (paths, names, ids) before adding it here.
