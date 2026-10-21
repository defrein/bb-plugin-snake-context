// bb-plugin-snake-context — backend entry.
//
// The game runs entirely in the app bundle: it reads thread status and
// context-window usage through the public SDK, so the server only logs load.
import type { BbPluginApi } from "@get-bb/plugin-sdk";

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");
}
