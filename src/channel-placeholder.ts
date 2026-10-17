// The stand-in for the channel key in the static wrapper files
// (src/extension/channel.ts swaps the real key in when it registers
// them). Its own module so the harness, which loads a wrapper under
// Node, can call the registry gate with it.
export const CHANNEL_KEY_PLACEHOLDER = '__SM_KEY__';
