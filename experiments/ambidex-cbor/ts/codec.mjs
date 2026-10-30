// Experimental restricted control profile. No production imports or registration.
const te = new TextEncoder(),
  td = new TextDecoder("utf-8", { fatal: true });
export const limits = {
  bytes: 1048576,
  depth: 64,
  nodes: 100000,
  keys: 4096,
  array: 65536,
  field: 262144,
  allocation: 8388608,
};
const fail = () => {
  throw new RangeError("invalid control payload");
};
export class Tag {
  constructor(tag, value) {
    this.tag = tag;
    this.value = value;
  }
}
export function encode(value) {
  const out = [];
  const put = (m, n) => {
    n = BigInt(n);
    if (n < 0n || n > 0xffffffffffffffffn) fail();
    if (n < 24n) out.push(m * 32 + Number(n));
    else {
      const size = n <= 255n ? 1 : n <= 65535n ? 2 : n <= 4294967295n ? 4 : 8;
      out.push(m * 32 + { 1: 24, 2: 25, 4: 26, 8: 27 }[size]);
      for (let i = size - 1; i >= 0; i--)
        out.push(Number((n >> BigInt(i * 8)) & 255n));
    }
  };
  const walk = (v, d = 0) => {
    if (d > 64) fail();
    if (v instanceof Tag) {
      put(6, v.tag);
      walk(v.value, d + 1);
    } else if (
      typeof v === "bigint" ||
      (typeof v === "number" && Number.isSafeInteger(v))
    ) {
      const n = BigInt(v);
      put(n < 0n ? 1 : 0, n < 0n ? -1n - n : n);
    } else if (typeof v === "string") {
      const b = te.encode(v);
      if (td.decode(b) !== v) fail();
      put(3, b.length);
      for (const x of b) out.push(x);
    } else if (v instanceof Uint8Array) {
      put(2, v.length);
      for (const b of v) out.push(b);
    } else if (v === null) out.push(246);
    else if (typeof v === "boolean") out.push(v ? 245 : 244);
    else if (Array.isArray(v)) {
      put(4, v.length);
      for (const x of v) walk(x, d + 1);
    } else if (v && typeof v === "object") {
      const entries = Object.entries(v).map(([k, x]) => [encode(k), x]);
      entries.sort((a, b) => compare(a[0], b[0]));
      put(5, entries.length);
      for (const [k, x] of entries) {
        for (const b of k) out.push(b);
        walk(x, d + 1);
      }
    } else fail();
  };
  walk(value);
  return Uint8Array.from(out);
}
function compare(a, b) {
  for (let i = 0; i < Math.min(a.length, b.length); i++)
    if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}
export function decode(bytes, strict = true, budget = limits.allocation) {
  if (bytes.length > limits.bytes) fail();
  let p = 0,
    nodes = 0,
    allocation = 0;
  const reserve = (n) => {
    allocation += n;
    if (allocation > Math.min(budget, limits.allocation)) fail();
  };
  const take = (n) => {
    if (n > bytes.length - p) fail();
    const b = bytes.subarray(p, p + n);
    p += n;
    return b;
  };
  const walk = (depth = 0, parent = -1, slot = -1) => {
    if (depth > limits.depth || ++nodes > limits.nodes) fail();
    reserve(32);
    const h = take(1)[0],
      major = h >> 5,
      ai = h & 31;
    if (major === 7) {
      if (ai === 20) return false;
      if (ai === 21) return true;
      if (ai === 22) return null;
      fail();
    }
    let n;
    if (ai < 24) n = BigInt(ai);
    else {
      const size = { 24: 1, 25: 2, 26: 4, 27: 8 }[ai];
      if (!size) fail();
      n = 0n;
      for (const b of take(size)) n = n * 256n + BigInt(b);
      if (n < { 1: 24n, 2: 256n, 4: 65536n, 8: 4294967296n }[size]) fail();
    }
    if (major === 0) return n;
    if (major === 1) return -1n - n;
    if (n > BigInt(limits.bytes)) fail();
    const len = Number(n);
    if (major === 2 || major === 3) {
      if (len > limits.field) fail();
      reserve(len * 2);
      const b = take(len);
      return major === 2 ? b.slice() : td.decode(b);
    }
    if (major === 4) {
      if (len > limits.array) fail();
      reserve(len * 8);
      const a = [];
      for (let i = 0; i < len; i++) a.push(walk(depth + 1, parent, i));
      return a;
    }
    if (major === 5) {
      if (len > limits.keys) fail();
      reserve(len * 64);
      const o = Object.create(null);
      let prev;
      for (let i = 0; i < len; i++) {
        const start = p,
          k = walk(depth + 1);
        const raw = bytes.subarray(start, p);
        if (
          typeof k !== "string" ||
          Object.hasOwn(o, k) ||
          (strict && prev && compare(prev, raw) >= 0)
        )
          fail();
        prev = raw;
        o[k] = walk(depth + 1);
      }
      return o;
    }
    if (major === 6) {
      if (
        ![0, 4, 1004, 2, 3].includes(len) ||
        ([2, 3].includes(len) && !(parent === 4 && slot === 1))
      )
        fail();
      const v = walk(depth + 1, len);
      if (len === 4) {
        if (
          !Array.isArray(v) ||
          v.length !== 2 ||
          typeof v[0] !== "bigint" ||
          v[0] < -1000n ||
          v[0] > 1000n
        )
          fail();
        if (typeof v[1] !== "bigint" && !(v[1] instanceof Tag)) fail();
      }
      if (len === 2 || len === 3) {
        if (
          !(v instanceof Uint8Array) ||
          v.length <= 8 ||
          v[0] === 0 ||
          v.length > 16
        )
          fail();
      }
      if ([0, 1004].includes(len) && typeof v !== "string") fail();
      return new Tag(len, v);
    }
    fail();
  };
  const value = walk();
  if (p !== bytes.length) fail();
  return value;
}
// Recursive-descent JSON scanner validates duplicates and budgets before JSON.parse.
export function parseJSON(bytes) {
  if (bytes.length > limits.bytes) fail();
  const s = td.decode(bytes);
  let p = 0,
    nodes = 0,
    allocation = 0;
  const ws = () => {
    while (/[\x20\t\r\n]/.test(s[p] ?? "x")) p++;
  };
  const str = () => {
    const start = p++;
    while (p < s.length) {
      if (s[p] === '"') {
        p++;
        const raw = s.slice(start, p);
        allocation += te.encode(raw).length * 2;
        if (allocation > limits.allocation) fail();
        const decoded = JSON.parse(raw);
        if (
          te.encode(decoded).length > limits.field ||
          td.decode(te.encode(decoded)) !== decoded
        )
          fail();
        return decoded;
      }
      if (s[p] === "\\") p++;
      p++;
    }
    fail();
  };
  const val = (d = 0) => {
    ws();
    if (d > 64 || ++nodes > limits.nodes) fail();
    allocation += 32;
    if (allocation > limits.allocation) fail();
    const c = s[p];
    if (c === '"') {
      str();
      return;
    }
    if (c === "{" || c === "[") {
      p++;
      ws();
      const end = c === "{" ? "}" : "]",
        keys = new Set();
      let count = 0;
      if (s[p] === end) {
        p++;
        return;
      }
      while (true) {
        if (++count > (c === "{" ? limits.keys : limits.array)) fail();
        if (c === "{") {
          if (++nodes > limits.nodes) fail();
          allocation += 96;
          if (allocation > limits.allocation) fail();
          ws();
          if (s[p] !== '"') fail();
          const k = str();
          if (keys.has(k)) fail();
          keys.add(k);
          ws();
          if (s[p++] !== ":") fail();
        }
        if (c === "[") {
          allocation += 8;
          if (allocation > limits.allocation) fail();
        }
        val(d + 1);
        ws();
        if (s[p] === end) {
          p++;
          return;
        }
        if (s[p++] !== ",") fail();
      }
    }
    const m =
      /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
        s.slice(p),
      );
    if (!m) fail();
    p += m[0].length;
  };
  val();
  ws();
  if (p !== s.length) fail();
  return JSON.parse(s, (k, v) => {
    if (
      typeof v === "number" &&
      (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v)))
    )
      fail();
    if (v && typeof v === "object" && !Array.isArray(v))
      return Object.assign(Object.create(null), v);
    return v;
  });
}
export const jsonBytes = (v) => te.encode(JSON.stringify(v));
export const hex = (b) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
