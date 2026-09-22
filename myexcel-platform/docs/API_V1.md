# HTTP/JSON API v1

Stage 3 freezes the first integration contract at `/api/v1`. Existing `/api/runtime` routes remain for compatibility, while the web client now exercises the v1 record endpoints.

The machine-readable contract is available from a running instance at:

```text
GET http://127.0.0.1:8091/api/v1/openapi.json
```

The API uses the same `myexcel_session` HTTP-only cookie as the browser. Obtain it through the existing login endpoint before calling protected routes:

```bash
curl -c session.txt -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"Admin123!"}' \
  http://127.0.0.1:8091/api/auth/login
```

## Runtime endpoints

For a published template ID:

```text
GET  /api/v1/apps/{templateId}/schema
GET  /api/v1/apps/{templateId}/records?limit=30&offset=0
POST /api/v1/apps/{templateId}/records
GET  /api/v1/apps/{templateId}/records/{recordId}
PUT  /api/v1/apps/{templateId}/records/{recordId}
GET  /api/v1/apps/{templateId}/records/{recordId}/audit
POST /api/v1/apps/{templateId}/records/{recordId}/workflow
GET  /api/v1/apps/{templateId}/references/{entityId}
GET  /api/v1/apps/{templateId}/summary
```

A create request uses stable entity and field IDs from the schema:

```json
{
  "templateVersion": 2,
  "requestId": "9ff6bd64-b52e-48cf-98a7-897268e72353",
  "record": {
    "entityId": "contact",
    "values": {
      "name": "Synthetic contact"
    },
    "details": {}
  }
}
```

`requestId` makes retries idempotent. Updates additionally require `expectedVersion`; a stale write returns HTTP 409. Schema validation and permission checks are always enforced on the server.

## Version policy

- `/api/v1` remains backward compatible within the v1 line. Additive response fields may appear.
- Business models currently use `schemaVersion: 1`.
- Template packages currently use `version: 1`.
- Breaking API changes require a new URL version. Breaking template or business-model changes require an explicit migration path or a compatibility error.
- The API does not expose database tables, arbitrary SQL, plugin execution, or unauthenticated record access.

Binary XLSX export remains on the existing browser-oriented endpoint and is intentionally not presented as the Stage 3 HTTP/JSON data exchange contract.
