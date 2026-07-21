export function StringEnum(values, options = {}) {
  return { type: "string", enum: [...values], ...options };
}
