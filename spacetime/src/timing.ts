import { TIMING } from "@dibs/protocol";
// Integration tests copy the module and replace ONLY this file in their temporary build.
export const timing = { ...TIMING };
