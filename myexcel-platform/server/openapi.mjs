const json = (schema, description = '成功') => ({ description, content: { 'application/json': { schema } } });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const id = { name: 'templateId', in: 'path', required: true, schema: { type: 'string' } };
const recordId = { name: 'recordId', in: 'path', required: true, schema: { type: 'string' } };

export const openApiV1 = {
  openapi: '3.1.0',
  info: {
    title: 'Generic Sheet App Builder API',
    version: '1.0.0',
    description: 'Stable HTTP/JSON contract for published spreadsheet applications and portable template packages.',
  },
  servers: [{ url: '/api/v1' }],
  tags: [
    { name: 'Contract', description: 'Version and machine-readable contract' },
    { name: 'Template packages', description: 'Portable design-only packages; never include records, users, or permissions' },
    { name: 'Runtime', description: 'Published application schema and business records' },
  ],
  paths: {
    '/': { get: { tags: ['Contract'], summary: 'Read API versions', responses: { 200: json({ type: 'object' }) } } },
    '/openapi.json': { get: { tags: ['Contract'], summary: 'Read this OpenAPI document', responses: { 200: json({ type: 'object' }) } } },
    '/templates/{templateId}/package': { get: { tags: ['Template packages'], summary: 'Export a draft or published template package', parameters: [id, { name: 'published', in: 'query', schema: { type: 'integer', enum: [1] } }], responses: { 200: json(ref('TemplatePackage')), 401: json(ref('Error')), 403: json(ref('Error')), 404: json(ref('Error')) } } },
    '/template-packages/validate': { post: { tags: ['Template packages'], summary: 'Validate a package without writing it', requestBody: { required: true, content: { 'application/json': { schema: ref('TemplatePackage') } } }, responses: { 200: json(ref('PackageValidation')), 422: json(ref('ValidationError')) } } },
    '/template-packages': { post: { tags: ['Template packages'], summary: 'Import a package as a new draft', requestBody: { required: true, content: { 'application/json': { schema: ref('TemplatePackage') } } }, responses: { 201: json({ type: 'object', properties: { workbook: { type: 'object' }, report: ref('PackageValidation') } }), 422: json(ref('ValidationError')) } } },
    '/apps/{templateId}/schema': { get: { tags: ['Runtime'], summary: 'Read a published application schema', parameters: [id], responses: { 200: json({ type: 'object' }), 404: json(ref('Error')) } } },
    '/apps/{templateId}/records': {
      get: { tags: ['Runtime'], summary: 'List visible records', parameters: [id, { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100 } }, { name: 'offset', in: 'query', schema: { type: 'integer', minimum: 0 } }], responses: { 200: json({ type: 'object', properties: { records: { type: 'array', items: { type: 'object' } } } }) } },
      post: { tags: ['Runtime'], summary: 'Create a record', parameters: [id], requestBody: { required: true, content: { 'application/json': { schema: ref('RecordWrite') } } }, responses: { 201: json({ type: 'object' }), 409: json(ref('Error')), 422: json(ref('ValidationError')) } },
    },
    '/apps/{templateId}/records/{recordId}': {
      get: { tags: ['Runtime'], summary: 'Read a record', parameters: [id, recordId], responses: { 200: json({ type: 'object' }), 404: json(ref('Error')) } },
      put: { tags: ['Runtime'], summary: 'Update a record with optimistic concurrency', parameters: [id, recordId], requestBody: { required: true, content: { 'application/json': { schema: ref('RecordWrite') } } }, responses: { 200: json({ type: 'object' }), 409: json(ref('Error')), 422: json(ref('ValidationError')) } },
    },
    '/apps/{templateId}/records/{recordId}/audit': { get: { tags: ['Runtime'], summary: 'Read full record audit history', parameters: [id, recordId], responses: { 200: json({ type: 'object' }) } } },
    '/apps/{templateId}/records/{recordId}/workflow': { post: { tags: ['Runtime'], summary: 'Apply a configured state transition', parameters: [id, recordId], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['transitionId', 'expectedVersion', 'requestId'], properties: { transitionId: { type: 'string' }, expectedVersion: { type: 'integer' }, requestId: { type: 'string', format: 'uuid' } } } } } }, responses: { 200: json({ type: 'object' }), 409: json(ref('Error')), 422: json(ref('ValidationError')) } } },
    '/apps/{templateId}/references/{entityId}': { get: { tags: ['Runtime'], summary: 'List records allowed as reference choices', parameters: [id, { name: 'entityId', in: 'path', required: true, schema: { type: 'string' } }], responses: { 200: json({ type: 'object' }) } } },
    '/apps/{templateId}/summary': { get: { tags: ['Runtime'], summary: 'Read configured aggregate results', parameters: [id], responses: { 200: json({ type: 'object' }) } } },
  },
  components: {
    securitySchemes: { sessionCookie: { type: 'apiKey', in: 'cookie', name: 'myexcel_session' } },
    schemas: {
      Error: { type: 'object', required: ['error'], properties: { error: { type: 'string' } } },
      ValidationIssue: { type: 'object', required: ['path', 'message'], properties: { path: { type: 'string' }, message: { type: 'string' } } },
      ValidationError: { type: 'object', required: ['error', 'issues'], properties: { error: { type: 'string' }, issues: { type: 'array', items: ref('ValidationIssue') } } },
      PackageValidation: { type: 'object', properties: { valid: { type: 'boolean' }, issues: { type: 'array', items: ref('ValidationIssue') }, summary: { type: 'object' } } },
      TemplatePackage: { type: 'object', required: ['format', 'version', 'application', 'template'], properties: { format: { const: 'myexcel-template-package' }, version: { const: 1 }, exportedAt: { type: 'string', format: 'date-time' }, application: { type: 'object', required: ['name', 'description'], properties: { name: { type: 'string', maxLength: 100 }, description: { type: 'string', maxLength: 500 } } }, template: { type: 'object', required: ['snapshot', 'templateConfig', 'dataSourceConfig'], properties: { snapshot: { type: 'object' }, templateConfig: { type: 'object' }, dataSourceConfig: { type: 'object' } } } } },
      RecordWrite: { type: 'object', required: ['templateVersion', 'requestId', 'record'], properties: { templateVersion: { type: 'integer' }, expectedVersion: { type: 'integer' }, requestId: { type: 'string', format: 'uuid' }, record: { type: 'object' } } },
    },
  },
  security: [{ sessionCookie: [] }],
};
