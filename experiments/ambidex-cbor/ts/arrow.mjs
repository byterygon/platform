// Scalar alignment experiment, not an Arrow IPC implementation.
import { AmbidexDecimal, temporal, decimal } from "./semantic.mjs";
const billion = 1000000000n,
  day = 86400n * billion;
const dayIndex = (s) => BigInt(Date.parse(s + "T00:00:00Z") / 86400000);
const dateText = (d) => {
  const s = new Date(Number(d) * 86400000).toISOString();
  if (!/^\d{4}-/.test(s)) throw new RangeError("year");
  return s.slice(0, 10);
};
function timeNs(s) {
  const [whole, fraction = ""] = s.split("."),
    [h, m, sec] = whole.split(":").map(BigInt);
  return (
    (h * 3600n + m * 60n + sec) * billion + BigInt(fraction.padEnd(9, "0"))
  );
}
function timeText(ns, precision) {
  const seconds = ns / billion,
    frac = String(ns % billion).padStart(9, "0");
  if (
    precision < 9 &&
    frac
      .slice(precision)
      .split("")
      .some((x) => x !== "0")
  )
    throw new RangeError("precision loss");
  return (
    [seconds / 3600n, (seconds % 3600n) / 60n, seconds % 60n]
      .map((x) => String(x).padStart(2, "0"))
      .join(":") + (precision ? "." + frac.slice(0, precision) : "")
  );
}
export function toArrow(value, kind) {
  const s = value.toString();
  if (kind === "decimal") {
    const d = decimal(s);
    return {
      type: "Decimal128",
      coefficient: d.coefficient,
      scale: d.scale,
      precision: 38,
    };
  }
  const normalized = temporal(s, kind);
  if (kind === "date") return { type: "Date32", value: dayIndex(normalized) };
  if (kind === "time")
    return {
      type: "Time64",
      unit: "ns",
      value: timeNs(normalized),
      precision: (normalized.split(".")[1] ?? "").length,
    };
  if (kind === "instant" || kind === "local") {
    const tail =
      kind === "instant" ? normalized.slice(11, -1) : normalized.slice(11);
    return {
      type: "Timestamp",
      unit: "ns",
      timezone: kind === "instant" ? "UTC" : null,
      value: dayIndex(normalized.slice(0, 10)) * day + timeNs(tail),
      precision: (tail.split(".")[1] ?? "").length,
    };
  }
  throw new RangeError("unsupported Arrow alignment");
}
export function fromArrow(a) {
  if (a.type === "Decimal128")
    return new AmbidexDecimal(
      a.scale >= 0
        ? (() => {
            const sign = a.coefficient < 0n ? "-" : "",
              digits = (a.coefficient < 0n ? -a.coefficient : a.coefficient)
                .toString()
                .padStart(a.scale + 1, "0");
            return (
              sign +
              (a.scale
                ? digits.slice(0, -a.scale) + "." + digits.slice(-a.scale)
                : digits)
            );
          })()
        : `${a.coefficient}e${-a.scale}`,
    ).toString();
  if (a.type === "Date32") return temporal(dateText(a.value), "date");
  if (a.type === "Time64")
    return temporal(timeText(a.value, a.precision), "time");
  if (a.type === "Timestamp") {
    let days = a.value / day,
      ns = a.value % day;
    if (ns < 0n) {
      days--;
      ns += day;
    }
    const text =
      dateText(days) +
      "T" +
      timeText(ns, a.precision) +
      (a.timezone === "UTC" ? "Z" : "");
    return temporal(text, a.timezone === "UTC" ? "instant" : "local");
  }
  throw new RangeError("unsupported Arrow alignment");
}
