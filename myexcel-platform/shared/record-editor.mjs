export function newRecordDraft(model, templateVersion) {
  const main = model.entities.find((item) => item.id === model.document.entityId);
  const values = {};
  for (const field of main?.fields || []) if (field.defaultValue != null && field.defaultValue !== '') values[field.id] = field.defaultValue;
  return { entityId: model.document.entityId, templateVersion, values, details: Object.fromEntries(model.document.details.map((detail) => [detail.id, []])) };
}

export function detailRowIdentities(model, record) {
  return Object.fromEntries(model.document.details.map((detail) => [detail.id,
    Array.from({ length: detail.rowCount }, (_, index) => record?.details?.[detail.id]?.[index]?.id || null),
  ]));
}
