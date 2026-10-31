/** Experimental alternatives; no production generated types are changed. */
export type ExactI64 = bigint & { readonly __exactI64: unique symbol };
export type ExactU64 = bigint & { readonly __exactU64: unique symbol };
export interface BigintProfile {
  signed: bigint;
  unsigned: bigint;
}
export interface CheckedProfile {
  safe: number;
  fullSigned: ExactI64;
  fullUnsigned: ExactU64;
}
/** Factories must check signedness and bounds; branding alone is not validation. */
export declare function exact(text: string, signed?: boolean): bigint;
export declare function checked(text: string, signed?: boolean): number;
