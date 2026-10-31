import type { BigintInput, CheckedInput, ExactU64 } from "./generated.js";
import { AmbidexDecimal, AmbidexTemporal } from "./semantic.mjs";
const common = {
  amount: new AmbidexDecimal("1.2300"),
  at: new AmbidexTemporal("2026-10-29T12:34:56.123456789Z", "instant"),
  date: new AmbidexTemporal("2026-02-28", "date"),
  local: new AmbidexTemporal("2026-10-29T12:34:56", "local"),
  secret: "hidden",
};
const big: BigintInput = { ...common, id: 18446744073709551615n };
declare const exact: ExactU64;
const checked: CheckedInput = { ...common, id: exact };
// @ts-expect-error changing full-range fields to number is not safe
const wrong: BigintInput = { ...common, id: 9007199254740993 };
// @ts-expect-error an unvalidated bigint must not masquerade as a branded exact type
const unchecked: CheckedInput = { ...common, id: 1n };
void [big, checked, wrong, unchecked];

import type { MappingBigintInput, MappingCheckedInput } from "./generated.js";
import { exactI64, exactU64 } from "./integers.mjs";
const mixed: MappingCheckedInput = {
  safe: 42,
  full_signed: exactI64("-9223372036854775808"),
  full_unsigned: exactU64("18446744073709551615"),
};
const allBigint: MappingBigintInput = {
  safe: 42n,
  full_signed: -9223372036854775808n,
  full_unsigned: 18446744073709551615n,
};
// @ts-expect-error the explicit safe field uses a checked number in the mixed profile
const wrongMixed: MappingCheckedInput = { ...mixed, safe: 42n };
void [mixed, allBigint, wrongMixed];

import type { BigintError } from "./generated.js";
const domainError: BigintError = { code: "bounds", details: { field: "id" } };
// @ts-expect-error serde rename_all is reflected in generated domain-error variants
const wrongError: BigintError = { code: "Bounds", details: { field: "id" } };
void [domainError, wrongError];
