# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Versioned `/api/v1` HTTP/JSON runtime contract and OpenAPI 3.1 document.
- Portable `.mxapp.json` template packages with validation and clean-instance migration.
- Browser import/export entry for design-only template packages.
- Reproducible lazy-loading bundle budgets and synthetic 100/1,000/10,000-row benchmark.
- Keyboard skip navigation, visible focus indicators, and current-view announcements in the application shell.

### Security

- Template packages intentionally exclude users, sessions, permission overrides, business records, audit history, storage files, and environment secrets.

### Fixed

- Malformed worksheet or business-rule payloads now return structured package validation issues instead of an internal server error.
- Imported business templates open in design mode as unpublished drafts, avoiding an invalid jump into the published runtime.
- The OpenAPI package-validation response now matches the actual `{ report }` envelope.

## [0.2.0] - 2026-09-19

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

### Fixed

- Shared synthetic directory records are seeded once, so relation pickers and grouped summaries no longer show duplicate labels for different demo users.
- The runtime header now states that administrators can see all records instead of incorrectly describing an owner-only view.

### Known limitations

- XLSX support intentionally covers a documented subset rather than every Excel feature.
- The Univer workspace bundle is large and will be evaluated for code splitting in a later stage.
- The local JSON record file and SQLite metadata are durable but not one atomic database transaction.
- Real-time collaboration, complex workflow engines and company-specific modules are out of scope.
