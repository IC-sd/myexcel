# Performance baseline

This project keeps performance evidence reproducible and synthetic. It does not use customer workbooks or production traffic.

## Run the benchmark

```powershell
npm run benchmark
```

The command creates a production build, verifies that the spreadsheet workspace is not part of the login entry chunk, checks compressed bundle budgets, and runs five iterations of deterministic workbook generation and JSON serialization. The reported duration is the median.

## Recorded baseline

Recorded on 2026-09-21 with Node.js 24.19.0, Windows x64:

| Measurement | Result | Budget |
|---|---:|---:|
| Login entry JavaScript, gzip | 29,493 bytes | 81,920 bytes |
| Lazy workspace JavaScript, gzip | 2,685,938 bytes | 3,145,728 bytes |
| 100 rows × 26 columns, generate / serialize | 0.29 / 0.10 ms | — |
| 1,000 rows × 200 columns, generate / serialize | 2.13 / 1.14 ms | — |
| 10,000 rows × 200 columns, generate / serialize | 22.51 / 11.04 ms | 1,000 / 1,000 ms |

The 10,000-row snapshot is about 1.66 MB as JSON. Only eight data columns are populated; `200 columns` verifies the declared wide-sheet boundary rather than pretending to be a dense two-million-cell workload.

## Interpretation

- The login screen remains small because `WorkspaceView` and Univer are loaded only after authentication.
- The workspace bundle is still large. It is isolated from the first screen and protected by a budget, but reducing the Univer payload remains a valid future optimization.
- Generation and serialization measurements cover the platform-owned data path. Grid rendering, scrolling, and formula recalculation are provided by Univer and must be checked interactively after dependency upgrades.
- Timings vary by machine; a regression is the budget failure or a sustained change across repeated runs, not a small difference from this table.
