function schema(type, extra = {}) {
  return { type, ...extra };
}

export const Type = {
  String(options = {}) { return schema("string", options); },
  Boolean(options = {}) { return schema("boolean", options); },
  Array(items, options = {}) { return schema("array", { items, ...options }); },
  Object(properties, options = {}) {
    return schema("object", { properties, ...options });
  },
  Optional(value) { return { ...value, optional: true }; },
};
