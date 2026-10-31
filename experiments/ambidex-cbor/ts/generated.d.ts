// Generated from Rust semantic declarations; no handwritten field list.
import type { AmbidexDecimal, AmbidexTemporal } from "./semantic.mjs";
export type ExactI64 = bigint & { readonly __exactI64: unique symbol };
export type ExactU64 = bigint & { readonly __exactU64: unique symbol };
type Bigint_0 = {
  amount: AmbidexDecimal;
  at: AmbidexTemporal;
  date: AmbidexTemporal;
  id: bigint;
  local: AmbidexTemporal;
  secret: string;
};
export type BigintInput = Bigint_0;
type Checked_0 = {
  amount: AmbidexDecimal;
  at: AmbidexTemporal;
  date: AmbidexTemporal;
  id: ExactU64;
  local: AmbidexTemporal;
  secret: string;
};
export type CheckedInput = Checked_0;
type MappingBigint_0 = {
  full_signed: bigint;
  full_unsigned: bigint;
  safe: bigint;
};
export type MappingBigintInput = MappingBigint_0;
type MappingChecked_0 = {
  full_signed: ExactI64;
  full_unsigned: ExactU64;
  safe: number;
};
export type MappingCheckedInput = MappingChecked_0;
type BigintError_0 =
  | { code: "bounds"; details: { field: string } }
  | { code: "rejected"; details: { message: string } };
export type BigintError = BigintError_0;
type CheckedError_0 =
  | { code: "bounds"; details: { field: string } }
  | { code: "rejected"; details: { message: string } };
export type CheckedError = CheckedError_0;
