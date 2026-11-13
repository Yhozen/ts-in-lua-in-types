import { Run, Rev, Flat, mk } from "../lib/lib";
type S0 = { done: false; i: "0"; n: Rev<"100000">; log: null; obj: {} };
type S1 = Run<S0>;
type S2 = Run<S1>;
type S3 = Run<S2>;
type S4 = Run<S3>;
type Out = S4 extends { obj: infer O } ? Omit<S4, "obj"> & { obj: Flat<O> } : never;
export const state = mk<Flat<Out>>();
