// Model v1: frozen. Do not edit model.json; a retrain is a new version directory.
//
// Besides the raw model, this entry gives you a ready-made codec so that
//   import { furl, unfurl } from '@enfurl/codec/models/v1';
// is all a small script needs.
import { Codec } from '../../dist/index.js';
import model from './model.json' with { type: 'json' };

export default model;
export const codec = new Codec([model]);
/** Roll a URL up into a furl. */
export const furl = (input, opts) => codec.furl(input, opts);
/** Open a furl back into its URL. */
export const unfurl = (code) => codec.unfurl(code);
