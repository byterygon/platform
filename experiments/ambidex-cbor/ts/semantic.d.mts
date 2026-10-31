export declare class AmbidexDecimal {
  readonly coefficient: bigint;
  readonly scale: number;
  constructor(value: string);
  toString(): string;
}
export declare class AmbidexTemporal {
  readonly value: string;
  readonly kind: string;
  constructor(value: string, kind: string);
  toString(): string;
}
