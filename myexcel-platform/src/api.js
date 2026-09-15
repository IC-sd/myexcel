async function request(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body && !(options.body instanceof Blob) && !(options.body instanceof ArrayBuffer) ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.blob();
  if (!response.ok) {
    const error = new Error(payload?.error || `请求失败（${response.status}）`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export const api = {
  runtimeStatus: () => request('/api/runtime/status'),
  runtimeSchema: (id) => request(`/api/runtime/${id}/schema`),
  listRecords: (id, offset = 0, filters = {}) => {
    const query = new URLSearchParams({ limit: '30', offset: String(offset) });
    for (const key of ['dateFieldId', 'dateFrom', 'dateTo', 'workflowState']) if (filters[key]) query.set(key, filters[key]);
    return request(`/api/runtime/${id}/records?${query}`);
  },
  getRecord: (id, recordId) => request(`/api/runtime/${id}/records/${recordId}`),
  getRecordAudit: (id, recordId) => request(`/api/runtime/${id}/records/${recordId}/audit`),
  saveRecord: (id, recordId, data) => request(`/api/runtime/${id}/records${recordId ? `/${recordId}` : ''}`, { method: recordId ? 'PUT' : 'POST', body: JSON.stringify(data) }),
  referenceRecords: (id, entityId, offset = 0) => request(`/api/runtime/${id}/references/${entityId}?limit=30&offset=${offset}`),
  runtimeSummary: (id) => request(`/api/runtime/${id}/summary`),
  transitionRecord: (id, recordId, data) => request(`/api/runtime/${id}/records/${recordId}/workflow`, { method: 'POST', body: JSON.stringify(data) }),
  recordExportUrl: (id, recordId) => `/api/runtime/${id}/records/${recordId}/export`,
  me: () => request('/api/auth/me'),
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),
  listWorkbooks: () => request('/api/workbooks'),
  getWorkbook: (id) => request(`/api/workbooks/${id}`),
  createWorkbook: (name, description = '') => request('/api/workbooks', { method: 'POST', body: JSON.stringify({ name, description }) }),
  saveWorkbook: (id, data) => request(`/api/workbooks/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  listVersions: (id) => request(`/api/workbooks/${id}/versions`),
  saveDesign: (id, data) => request(`/api/workbooks/${id}/design`, { method: 'PUT', body: JSON.stringify(data) }),
  previewDesign: (id, businessModel, expectedVersion, previewRole = 'editor', recordId = null) => request(`/api/workbooks/${id}/design/preview`, { method: 'POST', body: JSON.stringify({ businessModel, expectedVersion, previewRole, recordId }) }),
  publishWorkbook: (id, expectedVersion) => request(`/api/workbooks/${id}/publish`, { method: 'POST', body: JSON.stringify({ expectedVersion }) }),
  listReleases: (id) => request(`/api/workbooks/${id}/releases`),
  rollbackWorkbook: (id, version, expectedVersion) => request(`/api/workbooks/${id}/rollback`, { method: 'POST', body: JSON.stringify({ version, expectedVersion }) }),
  getPublishedWorkbook: (id) => request(`/api/published/${id}`),
  getPermissions: (id) => request(`/api/workbooks/${id}/permissions`),
  savePermissions: (id, permissions) => request(`/api/workbooks/${id}/permissions`, { method: 'PUT', body: JSON.stringify({ permissions }) }),
  getAudit: (id) => request(`/api/workbooks/${id}/audit`),
  createWorkbookBenchmark: (rowCount = 3000, columnCount = 26) => request('/api/benchmarks/workbook', { method: 'POST', body: JSON.stringify({ rowCount, columnCount }) }),
  importWorkbook: (file) => request('/api/workbooks/import', {
    method: 'POST',
    body: file,
    headers: { 'Content-Type': file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'X-File-Name': encodeURIComponent(file.name) },
  }),
  exportUrl: (id, published = false) => `/api/workbooks/${id}/export${published ? '?published=1' : ''}`,
};
