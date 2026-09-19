# Changelog

All notable changes to this project are documented in this file.

## [0.2.0] - 2026-09-16

First public preview of the generic spreadsheet application builder.

### Added

- Design and runtime modes for published spreadsheet applications.
- Stable master/detail bindings and cross-template record relationships.
- A zero-dependency local JSON record adapter enabled by default.
- Reproducible synthetic contact, catalog and request examples.
- Optional MySQL record storage for integration testing and advanced use.
- MIT license, contribution and security guidance, issue templates and CI.

### Verified

- 69 automated tests: 58 passed and 11 optional MySQL tests skipped without a configured server.
- Production build with Node.js 24.
- Clean local startup, seeded demo listing, saved-record reopen and validation in a real browser.

### Known limitations

- XLSX support intentionally covers a documented subset rather than every Excel feature.
- The Univer workspace bundle is large and will be evaluated for code splitting in a later stage.
- The local JSON record file and SQLite metadata are durable but not one atomic database transaction.
- Real-time collaboration, complex workflow engines and company-specific modules are out of scope.
