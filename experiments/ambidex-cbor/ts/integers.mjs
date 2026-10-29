export function exact(text, signed = true) {
  if (typeof text !== 'string' || !/^(0|-?[1-9][0-9]*)$/.test(text) || text.length > 20) throw new RangeError('invalid integer');
  const value = BigInt(text);
  const min = signed ? -(1n << 63n) : 0n;
  const max = signed ? (1n << 63n) - 1n : (1n << 64n) - 1n;
  if (value < min || value > max) throw new RangeError('integer range');
  return value;
}
export function checked(text, signed = true) {
  const value = exact(text, signed);
  if (value < -9007199254740991n || value > 9007199254740991n) throw new RangeError('unsafe number');
  return Number(value);
}
