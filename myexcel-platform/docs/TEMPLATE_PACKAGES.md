# Portable template packages

A template package is a UTF-8 JSON file with the `.mxapp.json` suffix. It moves reusable application design between instances without modifying source code.

## Included

- workbook sheets, values, formulas, and dimensions;
- application name and description;
- stable business model and cell bindings;
- relation, calculation, aggregate, field-policy, and optional state-flow rules;
- portable data-source labels (`type` and `name` only).

## Never included

- business records or audit history;
- users, sessions, roles, or instance permission overrides;
- source workbook, release, or record IDs;
- SQLite/MySQL/JSON storage files;
- environment variables or secrets.

Connection strings and credentials are deliberately removed even if an instance stored them in its local design metadata.

The imported workbook and snapshot receive new identities and remain a draft until explicitly published.

## Browser workflow

In the workbook toolbar, open **导入 / 导出**:

1. Export a draft owned by a designer, or use the published view to export the fixed release.
2. Import the `.mxapp.json` file into another clean instance.
3. Review the validation summary, adjust instance-specific data-source settings if needed, and publish the new draft.

## API workflow

```bash
# Export
curl -b session.txt -o sample.mxapp.json \
  http://127.0.0.1:8091/api/v1/templates/TEMPLATE_ID/package

# Validate without writing
curl -b session.txt -H "Content-Type: application/json" \
  --data-binary @sample.mxapp.json \
  http://127.0.0.1:8091/api/v1/template-packages/validate

# Import as a new draft
curl -b session.txt -H "Content-Type: application/json" \
  --data-binary @sample.mxapp.json \
  http://127.0.0.1:8091/api/v1/template-packages
```

Import is rejected when the package format/version is unsupported, the workbook shape is invalid, or business bindings do not match the included snapshot. Formula compatibility is summarized during validation.

Template packages are not a plugin runtime: they cannot ship executable code or bypass platform validation.
