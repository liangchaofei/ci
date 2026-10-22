/** 拒绝 JSON 会静默丢失或改写的数据；共享引用可以保存，循环引用不行。 */
export function assertJsonData(value: unknown, ancestors = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return;
  if (typeof value !== "object" || value === null) throw new Error("Session data must be JSON-compatible");

  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
    throw new Error("Session data must contain only plain objects and arrays");
  }
  if (ancestors.has(value)) throw new Error("Session data contains a cycle");
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error("Session data contains symbol keys");

  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some((entry) => "get" in entry || "set" in entry)) {
    throw new Error("Session data cannot contain accessors");
  }
  const expectedKeys = Object.keys(value).length + (Array.isArray(value) ? 1 : 0);
  if (Object.getOwnPropertyNames(value).length !== expectedKeys) throw new Error("Session data contains hidden properties");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!(index in value)) throw new Error("Session data contains an array hole");
        assertJsonData(value[index], ancestors);
      }
      if (Object.keys(value).length !== value.length) throw new Error("Session array contains extra properties");
    } else {
      for (const item of Object.values(value)) assertJsonData(item, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

