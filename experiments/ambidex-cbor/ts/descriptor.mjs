// Convert a Rust-derived nominal semantic graph into runtime hydration descriptors.
export function descriptor(document) {
  const cache = new Map();
  const direction = document.direction;
  function convert(node) {
    if (node.ref) {
      const key = `${node.ref}.${direction}`;
      if (!Object.hasOwn(document.definitions, key))
        throw new Error("unresolved nominal reference");
      if (!cache.has(key)) {
        const target = {};
        cache.set(key, target);
        Object.assign(target, convert(document.definitions[key]));
      }
      return { type: "ref", target: cache.get(key) };
    }
    if (node.type === "object") {
      const fields = Object.create(null),
        optional = [],
        flatten = [];
      for (const f of node.fields) {
        fields[f.name] = convert(f.schema);
        if (f.optional) optional.push(f.name);
        if (f.flatten) flatten.push(f.name);
      }
      return {
        type: "object",
        fields,
        optional,
        flatten,
        unknownFields: node.unknownFields,
      };
    }
    if (node.type === "array") return { ...node, items: convert(node.items) };
    if (node.type === "map") return { ...node, values: convert(node.values) };
    if (node.type === "tuple")
      return { ...node, items: node.items.map(convert) };
    if (node.type === "nullable")
      return { ...node, inner: convert(node.inner) };
    if (node.type === "enum")
      return {
        ...node,
        variants: node.variants.map((v) => ({
          ...v,
          schema: convert(v.schema),
        })),
      };
    return { ...node };
  }
  return convert(document.root);
}
