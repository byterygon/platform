import type { ExactI64, ExactU64 } from "./generated.js";
export declare function exact(text: string, signed?: boolean): bigint;
export declare function checked(text: string, signed?: boolean): number;
export declare function exactI64(text: string): ExactI64;
export declare function exactU64(text: string): ExactU64;
