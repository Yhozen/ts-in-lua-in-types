
export type IncD = { "0": "1"; "1": "2"; "2": "3"; "3": "4"; "4": "5"; "5": "6"; "6": "7"; "7": "8"; "8": "9" };
export type Inc<I extends string> = I extends `${infer d}${infer r}` ? d extends "9" ? `0${Inc<r>}` : `${IncD[d & keyof IncD]}${r}` : "1";
export type Rev<S extends string, O extends string = ""> = S extends `${infer h}${infer t}` ? Rev<t, `${h}${O}`> : O;
type Fuel = "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
// state: counter, limit, and a "heap" that grows: a cons list of visited multiples of 100 plus an object keyed by them
type B0<F extends string, I extends string, N extends string, L, O> =
  F extends `x${infer F2}`
    ? Inc<I> extends infer I2 extends string
      ? I2 extends N ? { done: true; i: I2; log: L; obj: O }
        : I2 extends `00${string}` ? B0<F2, I2, N, [I2, L], O & { [K in I2]: { at: I2; prev: L extends [infer P, unknown] ? P : null } }> : B0<F2, I2, N, L, O>
      : never
    : { done: false; i: I; n: N; log: L; obj: O };
export type Run<R> = R extends { done: false; i: infer I extends string; n: infer N extends string; log: infer L; obj: infer O } ? B0<Fuel, I, N, L, O> : R;
export type Flat<T> = { [K in keyof T]: T[K] };
export declare function mk<T>(): T;
