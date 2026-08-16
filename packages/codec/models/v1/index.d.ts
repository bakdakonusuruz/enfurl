import type { ModelJSON, Codec, FurlResult, NormalizeOptions } from '../../dist/index.js';
declare const model: ModelJSON;
export default model;
export declare const codec: Codec;
/** Roll a URL up into a furl. */
export declare function furl(input: string, opts?: NormalizeOptions): FurlResult;
/** Open a furl back into its URL. */
export declare function unfurl(code: string): string;
