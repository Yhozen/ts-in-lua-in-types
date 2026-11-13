import { Run, Rev, Flat, mk } from "../lib/lib";
import { state as prev } from "../s0/stage";
type S0 = typeof prev;
type S1 = Run<S0>;
type S2 = Run<S1>;
type S3 = Run<S2>;
type S4 = Run<S3>;
type Out = S4 extends { obj: infer O } ? Omit<S4, "obj"> & { obj: Flat<O> } : never;
export const state = mk<Flat<Out>>();
